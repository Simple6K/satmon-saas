#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
@Project : anntoconfig
@File : config_apollo.py
@Author : annto-dev
@Date : 2025/10/23 11:22
继承pyapollo
增加变更的回调订阅。但是目前没有锁数据，也没有消耗掉回调信息
"""
import os
import re
import threading
import time
import copy
from typing import Any, Dict, List, Optional, Union

import yaml
from loguru import logger

try:
    from pyapollo.client import ApolloClient
except ImportError:
    # 本地模式：不依赖 Apollo 远程配置中心。application.yaml 无 apollo 配置段时
    # AnntoApolloClient 不会被实例化，此处占位保证类定义可用。
    ApolloClient = object

from .utils import parse_to_dict


class AnntoApolloClient(ApolloClient):
    def __init__(self, *args, **kwargs):
        # 调用父类初始化
        # 初始化扩展功能
        # 用于存储各个命名空间的配置快照，格式：{namespace: {config_key: config_value}}，原来在self.cache
        self.config_snapshots: Dict[str, Dict[str, Any]] = {}
        # 用于保存变更通知
        self.change_callbacks: Dict[str, Dict[str, Any]] = {}
        self.change_listener_map = {}
        super().__init__(*args, **kwargs)




    # 重写方法
    def fetch_config_by_namespace(self, namespace: str = "application") -> None:
        """
        Fetch configuration of the namespace from apollo server
        """
        url = f"{self._config_server_host}:{self._config_server_port}/configs/{self._app_id}/{self._cluster}/{namespace}"
        try:
            r = self._http_get(url)
            if r.status_code == 200:
                data = r.json()
                configurations = data.get("configurations", {})
                release_key = data.get("releaseKey", str(time.time()))
                if namespace.endswith("yaml"):
                    configurations = yaml.load(configurations.get("content",""), Loader=yaml.FullLoader)
                else:
                    configurations = parse_to_dict(configurations)
                self.update_cache(namespace, configurations)

                self.update_local_file_cache(
                    release_key=release_key,
                    data=configurations,
                    namespace=namespace,
                )
                self.detect_changes(namespace)
            else:
                logger.warning(
                    "Get configuration from apollo failed, load from local cache file"
                )
                data = self.get_local_file_cache(namespace)
                self.update_cache(namespace, data)
                self.detect_changes(namespace)

        except Exception as e:
            data = self.get_local_file_cache(namespace)
            self.update_cache(namespace, data)

            logger.error(
                f"Fetch apollo configuration meet error, error: {e}, url: {url}, config server url: {self._config_server_url}, host: {self._config_server_host}, port: {self._config_server_port}"
            )
            self.update_config_server(exclude=self._config_server_host)


    def check_namespace(self, namespace: str) -> bool:
        """
        检查远程是否存在，若不存在GG

        Args:
            namespace: Apollo namespace name

        Returns:
            bool: 命名空间是否存在
        """
        url = (
            f"{self._config_server_host}:{self._config_server_port}/configs/"
            f"{self._app_id}/{self._cluster}/{namespace}"
        )
        try:
            r = self._http_get(url)
            if r.status_code == 200:
                return True
            else:
                logger.error(
                    f"获取apollo配置失败，请检查《{namespace}》 "
                )
                data = self.get_local_file_cache(namespace)
                self.update_cache(namespace, data)
                return False
        except Exception as e:
            logger.error(
                f"获取apollo配置失败，请检查《{namespace}》 , 错误: {e}"
            )
            return False

    def take_snapshot(self, namespace: str) -> Dict[str, Any]:
        """
        获取/初始化配置快照

        Args:
            namespace: Apollo namespace name

        Returns:
            Dict[str, Any]: 当前配置快照
        """
        current_config = self._cache.get(namespace, {})
        snapshot = copy.deepcopy(current_config)

        self.config_snapshots[namespace] = snapshot

        return snapshot


    def _recursive_compare(self, old_val: Any, new_val: Any, current_path: str, changes: Dict[str, Any]):
        """
        递归比较的核心方法

        这是变更检测的核心算法，采用深度优先遍历的方式递归比较两个值。
        对于字典和列表会递归检查内部元素，对于基本类型直接比较。

        Args:
            old_val (Any): 旧值
            new_val (Any): 新值
            current_path (str): 当前比较路径（如 "database.mysql"）
            changes (Dict[str, Any]): 变更结果存储字典
        """
        # 🎯 情况1：两个都是字典类型 - 递归比较所有key
        if isinstance(old_val, dict) and isinstance(new_val, dict):
            old_keys = set(old_val.keys())
            new_keys = set(new_val.keys())

            # 新增的key - 数据放到change里
            for key in new_keys - old_keys:
                new_path = f"{current_path}.{key}" if current_path else key
                changes[new_path] = {"event": "add", "value": new_val[key]}

            # 🗑 删除的key
            for key in old_keys - new_keys:
                new_path = f"{current_path}.{key}" if current_path else key
                changes[new_path] = {"event": "delete", "value": old_val[key]}

            # 公共的key - 递归比较value
            for key in old_keys & new_keys:
                new_path = f"{current_path}.{key}" if current_path else key
                self._recursive_compare(old_val[key], new_val[key], new_path, changes)

        else:
            # 🔄 值发生变更
            if old_val != new_val:
                changes[current_path] = {
                    "event": "update",
                    "value": {"new": new_val, "old": old_val},
                }

    def detect_changes(self, namespace: str) -> Union[Dict[str, Any], bool]:
        """
        检查阿波罗的命名空间更新

        Args:
            namespace: Apollo namespace name

        Returns:
            Union[Dict[str, Any], bool]: 更新的内容，如果没有变化则返回False
        """
        old_config = self.config_snapshots.get(namespace, {})  # 旧的快照
        new_config = self.take_snapshot(namespace)  # 新的快照
        if new_config == old_config:
            return False
        else:
            changes = {}
            self._recursive_compare(old_config, new_config, "", changes)
            # 记录了变更，并完成
            self.config_snapshots[namespace] = new_config
            logger.info(
                f"apollo 配置远程热更新，命名空间《{namespace}》变更内容为{str(changes)}"
            )
            if namespace in self.change_callbacks.keys():
                self.change_callbacks[namespace].update(changes)
            else:
                self.change_callbacks[namespace] = changes
            self.callback_run(changes, namespace)
            return changes

    def get_value_namespace(self, namespace: str = "application") -> Any:
        """
        根据命名空间获取配置内容

        Args:
            namespace: Apollo namespace name

        Returns:
            Any: 命名空间的配置内容
        """
        return self._cache.get(namespace, {})

    def change_listener(self, callback, keys: Union[List, str], namespace: str):
        """
        注册回调

        Args:
            callback: 回调函数
            keys: 监听的变量路径 如key1.key2.key3
            namespace: Apollo namespace name
        """
        if isinstance(keys, str):
            keys = [keys]  # 少复制一份
        v = self.change_listener_map.get(namespace, {})

        for k in keys:
            if k in list(v.keys()):
                v[k].append(callback)
            else:
                v[k] = [callback]
        self.change_listener_map[namespace] = v


    def callback_run(self, changes: Dict[str, Any], namespace: str):
        """
        运行回调函数

        Args:
            changes: 变更内容
            namespace: Apollo namespace name
        """
        callback_map = self.change_listener_map.get(namespace, {})
        change_keys_listener = {}
        for change_key, change_value in changes.items():
            for k in list(callback_map.keys()):
                if change_key.startswith(k) and (change_key==k or (len(change_key) > len(k) and change_key[len(k)] == '.')):
                    if k in change_keys_listener:
                        change_keys_listener[k].append({change_key: change_value})
                    else:
                        change_keys_listener[k] = [{change_key: change_value}]
        threads = []
        for k, v in change_keys_listener.items():
            for c in callback_map.get(k):
                def run_func(func,congfig,f_changes):
                    try:
                        func(congfig,f_changes)
                    except:
                        logger.error(f"配置<{k}>订阅回调执行失败")
                t = threading.Thread(target=run_func, args=(c,self._cache.get(namespace, {}), v,))

                threads.append(t)
                t.start()
        for t in threads:
            t.join()
