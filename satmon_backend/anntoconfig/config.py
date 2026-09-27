#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
@Project : anntoPySdk
@File : config.py
@Author : annto-dev
@Date : 2025/10/9 15:25
"""
# ==================== 导入标准库和类型注解 ====================
import time
from typing import Any, Dict, List, Optional, Union

# ==================== 导入第三方库 ====================
import os
import ast
import re
import threading
from pathlib import Path

import yaml
from loguru import logger

# ==================== 导入项目内部模块 ====================
from .exception import EnvNameSettingError
from .config_apollo import AnntoApolloClient
from .utils import merge_configs


def get_local_config(file_path=None) -> Dict[str, Any]:
    """
    获取本地配置文件

    在当前工作目录下查找 application.yaml 文件并加载配置

    Returns:
        Dict[str, Any]: 从本地配置文件加载的配置字典，如果没有找到配置文件则返回空字典

    查找逻辑:
        - 在当前工作目录下查找 application.yaml 文件
        - 如果找到文件，则使用yaml.FullLoader加载内容
        - 如果没有找到文件，返回空字典
    """
    if file_path==None:
        # 在当前工作目录下查找 application.yaml 文件
        config_file = list(Path.cwd().glob("config_files/application.yaml"))
    else:
        config_file = file_path
    if len(config_file) != 0:
        # 找到第一个.yaml文件并加载
        with open(config_file[0], encoding='utf-8') as f:
            config_init = yaml.load(f, Loader=yaml.FullLoader)
    else:
        # 没有找到yaml文件，返回空字典
        config_init = {}
    env_file_map = {
        "uat":"config_files/application_uat.yaml",
        "prod": "config_files/application_prod.yaml",
        "sit": "config_files/application_sit.yaml",
        "ver": "config_files/application_ver.yaml"
                    }
    if os.getenv('ENV_NAME'):
        file = env_file_map.get(os.getenv('ENV_NAME'),"")
        if file!='':
            with open(file, encoding='utf-8') as f:
                config_env = yaml.load(f, Loader=yaml.FullLoader)
            config_init.update(config_env)
    elif config_init.get("env_name",""):
        os.environ["ENV_NAME"] = config_init.get("env_name", "")
        file = env_file_map.get(config_init.get("env_name",""))
        with open(file, encoding='utf-8') as f:
            config_env = yaml.load(f, Loader=yaml.FullLoader)
        config_init.update(config_env)
    else:
        raise EnvNameSettingError()

    config_init = get_sys_config(config_init)
    return config_init

def set_config_value(config_name,config_value) -> dict:
    """

    """
    global config_client
    # 直接替换整个配置项，不考虑原有内容
    config_client._default_config[config_name] = config_value
    return config_value


def modify_config_value(new_config:dict) -> dict:
    """

    """
    global config_client
    config_client._default_config = merge_configs([config_client._default_config,new_config])

    return config_client._default_config

def get_sys_config(configs) -> dict:
    """
    替换配置字典中的环境变量并转换数据类型

    功能说明:
    - 扫描配置字典中的所有值，查找环境变量格式的字符串
    - 将 $ENV_VAR_NAME 格式的字符串替换为实际的环境变量值
    - 尝试将字符串值转换为对应的Python数据类型（如数字、布尔值等）

    Args:
        configs (dict): 配置字典，可能包含环境变量格式的字符串

    Returns:
        dict: 处理后的配置字典，环境变量已被替换并完成类型转换

    环境变量格式:
    - 必须以 $ 开头
    - 变量名只能包含大写字母、数字和下划线
    - 例如: $DATABASE_URL, $PORT, $DEBUG_MODE
    """
    for key, value in configs.items():
        # 识别值$大写字母，进行替换，只替换第一层，不做深层处理
        # 正则表达式模式：匹配以$开头的大写字母+数字+下划线格式的环境变量
        p = r"^\$[A-Z][A-Z0-9_]*$"
        if isinstance(value, str):
            if re.match(p, value):
                # 从环境变量获取值，如果不存在则保持原值
                value = os.getenv(value[1:], value)
                try:
                    # 尝试将字符串值转换为对应的Python数据类型
                    # 例如: "123" -> 123, "true" -> True, "[1,2,3]" -> [1,2,3]
                    value = eval(value)
                except:
                    # 转换失败则保持字符串原值
                    pass
                configs[key] = value
    return configs

class AnntoConfig:
    """
    配置管理器 - 统一管理本地配置和Apollo分布式配置

    主要功能:
    1. 加载本地YAML配置文件
    2. 连接Apollo配置中心获取远程配置
    3. 合并本地和远程配置
    4. 监听配置变化并触发回调
    5. 提供配置变更检测机制

    初始化流程:
    1. 获取本地配置 (application.yaml)
    2. 初始化Apollo客户端
    3. 合并本地和远程配置
    4. 创建配置快照用于变更检测
    """

    def __init__(self,cycle_time=5) -> None:
        """
        初始化配置管理器

        初始化步骤:
        1. 获取本地配置文件 (application.yaml)
        2. 处理环境变量替换和类型转换，作为基础配置
        3. 创建Apollo客户端实例，连接配置中心
        4. 合并本地配置和Apollo远程配置
        5. 创建配置快照，用于后续变更检测
        6. 初始化变更回调字典，存储配置变更的监听器
        """
        # 0. 轮询时间间隔
        self._cycle_time = cycle_time
        # 1. 获取本地配置文件 (application.yaml)
        self._default_config  = get_local_config()
        # 6. 初始化变更回调字典，存储配置变更的监听器
        self.change_callbacks = {}

        self.change_listener_map = {}

        # 3. 创建Apollo客户端实例，连接配置中心
        self.client = self._apollo_client()
        if self.client:
            # 4. 合并本地配置和Apollo远程配置
            self.global_configs = self.config_merge()

            # 5. 创建配置快照，用于后续变更检测
            self.snapshots_configs = self.global_configs

            # 7.开启轮询
            self.start_polling_thread()
        else:
            self.global_configs = self._default_config

    def _apollo_client(self) -> AnntoApolloClient:
        """
        创建Apollo客户端实例

        从基础配置中读取Apollo相关配置参数，创建并返回Apollo客户端实例

        Returns:
            AnntoApolloClient: 配置好的Apollo客户端实例

        配置参数说明:
            - app_id: Apollo应用ID
            - meta_server_address: Apollo元服务器地址
            - app_secret: 应用密钥（可选）
            - namespaces: 命名空间列表
            - cache_file_dir_path: 缓存文件目录路径
        """
        # 从基础配置中获取Apollo配置信息
        if self._default_config.get("apollo",False):


            apollo_config_data = self._default_config["apollo"]

        # 创建并返回Apollo客户端实例
            return AnntoApolloClient(app_id=apollo_config_data["app_id"],
                            meta_server_address=apollo_config_data["meta_server_address"],
                            app_secret=apollo_config_data["app_secret"],
                            namespaces= apollo_config_data["namespaces"],
                            cache_file_dir_path=apollo_config_data["cache_file_dir_path"]
                            )
        else:
            return False


    def config_merge(self) -> dict:
        """
        合并本地配置和Apollo远程配置

        将本地基础配置与Apollo配置中心中各个命名空间的配置进行合并
        合并策略由 merge_configs 函数决定，通常是远程配置覆盖本地配置

        Returns:
            dict: 合并后的完整配置字典

        合并流程:
            1. 以本地配置作为基础
            2. 遍历Apollo配置中的各个命名空间
            3. 获取每个命名空间的配置数据
            4. 使用merge_configs函数进行配置合并
        """
        # 创建配置列表，以本地默认配置作为起始点
        config_list = []
        # 遍历Apollo配置中的所有命名空间，获取远程配置
        for namespace in self._default_config["apollo"]["namespaces"][::-1]:
            # 从Apollo客户端获取指定命名空间的配置
            config_list.append(self.client.get_value_namespace(namespace))

        if self._default_config.get("local_first", False):
            config_list.append(self._default_config)

        else:
            config_list = [self._default_config]+config_list

        # 使用merge_configs函数合并所有配置并返回结果
        configs = merge_configs(config_list)
        return get_sys_config(configs)


    def detect_changes(self) -> Union[dict, bool]:
        """
        检测配置变更

        比较当前全局配置与快照配置之间的差异，并将变更信息存储在回调字典中
        这是配置热更新的核心机制

        Returns:
            dict|bool: 如果有配置变更，返回变更详情字典；如果没有变更，返回False

        检测流程:
            1. 获取当前全局配置和历史快照配置
            2. 进行深度比较，找出差异
            3. 更新配置快照
            4. 将变更信息存储到回调字典中
            5. 返回变更详情
        """
        # 获取当前全局配置和历史快照配置
        new_config = self.global_configs
        old_config = self.snapshots_configs

        # 如果配置没有变化，直接返回False
        if new_config == old_config:
            return False
        else:
            # 存在配置变更，进行深度比较
            changes = {}
            # 使用Apollo客户端的递归比较方法找出具体变更
            self.client._recursive_compare(old_config, new_config, "", changes)
            logger.info(f"全局配置远程热更新，变更内容为{str(changes)}")
            # 更新配置快照为当前配置
            self.snapshots_configs = new_config

            # 将变更信息存储到回调字典中
            if self.change_callbacks == {}:
                # 如果回调字典为空，直接赋值
                self.change_callbacks = changes
            else:
                # 如果回调字典已有数据，则合并新的变更信息
                self.change_callbacks.update(changes)

            self.callback_run(changes)

        return changes

    def callback_run(self, changes):
        """
        运行回调函数
        :param changes:
        :return:
        """
        change_keys_listener = {}
        for change_key, change_value in changes.items():
            for k in list(self.change_listener_map.keys()):
                if change_key.startswith(k) and (change_key==k or (len(change_key) > len(k) and change_key[len(k)] == '.')):
                    if k in change_keys_listener:
                        change_keys_listener[k].append({change_key: change_value})
                    else:
                        change_keys_listener[k] = [{change_key: change_value}]
        threads = []
        for k, v in change_keys_listener.items():
            for c in self.change_listener_map.get(k):
                def run_func(func,congfig,f_changes):
                    try:
                        func(congfig,f_changes)
                    except:
                        logger.error(f"配置<{k}>订阅回调执行失败")
                t = threading.Thread(target=run_func, args=(c,self.global_configs, v,))
                threads.append(t)
                t.start()
        for t in threads:
            t.join()



    def change_listener(self,callback, keys: Union[List, str], namespace: str = None) -> list:
        """
        配置变更监听器

        检查指定配置项是否有变更发生，并返回发生变更的配置项列表
        这是应用获取配置变更通知的主要接口

        Args:
            keys (Union[List, str]): 要监听的配置项路径，支持两种格式:
                                    - 单个配置路径字符串，如 "database.host"
                                    - 配置路径列表，如 ["database.host", "cache.port"]
            namespace (str, optional): Apollo命名空间名称。如果指定，则直接使用Apollo的变更监听

        Returns:
            list: 发生变更的配置项路径列表。如果没有变更，返回空列表

        使用方式:
            1. 直接监听本地配置变更: change_listener(["db.host", "cache.port"])
            2. 监听Apollo特定命名空间: change_listener("namespace1")

        监听机制:
            - 如果指定了namespace，直接调用Apollo客户端的变更监听
            - 如果没有指定namespace，则检查本地变更回调字典中的匹配项
            - 匹配规则: 配置项路径包含监听的关键字
        """

        if namespace is not None:
            if self.client:
                self.client.change_listener(callback,keys, namespace)
        else:
            if isinstance(keys, str):
                keys = [keys]
            for k in keys:
                if k in self.change_listener_map:
                    self.change_listener_map[k].append(callback)
                else:
                    self.change_listener_map[k]=[]
                    self.change_listener_map[k].append(callback)




    def get_value(self, key: str) -> Any:
        """
        获取嵌套配置项的值

        Args:
            key (str): 配置项路径，使用点号分隔，如 "database.host"

        Returns:
            Any: 配置项的值，如果路径不存在则返回空字典
        """
        value = self.global_configs
        for k in key.split("."):
            value = value.get(k,{})

        return value

    def start_polling_thread(self) -> None:
        """
        Start the long polling loop thread
        """

        self._stop_event = threading.Event()
        t = threading.Thread(target=self._listener)
        t.daemon = True
        t.start()
        logger.success("配置更新成功")


    def start_callback_thread(self,callback) -> None:
        """
        Start the long polling loop thread
        """

        t = threading.Thread(target=callback)
        t.daemon = True
        t.start()
        logger.success("配置更新成功")

    def _listener(self) -> None:
        while not self._stop_event.is_set():
            try:
                # 刷一遍配置
                self.global_configs = self.config_merge()
                # 检查变更
                self.detect_changes()
                # 卡住
                self._stop_event.wait(self._cycle_time)

            except:
                logger.error(f"配置更新失败")


config_client = AnntoConfig()

class AllConfig:

    def __init__(self):
        self.client = config_client

    def get_value(self, key: str) -> Any:
        return self.client.get_value(key)
    def namespace_config(self,namespace):
        return self.client.client.get_value_namespace(namespace)
    @property
    def global_configs(self):
        return self.client.global_configs
    @property
    def local_configs(self):
        return self.client._default_config



# 注释的代码示例
# config_client = AllConfig()
# config = config_client.global_configs
# config = get_local_config()

