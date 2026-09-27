#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
@Project : anntoconfig
@File : utils.py
@Author : annto-dev
@Date : 2025/10/31 14:18
"""


def merge_configs(configs, deep=True):
    """
    合并多个字典配置，按优先级从高到低合并

    功能说明:
    - 支持多个字典按优先级合并，后面的字典会覆盖前面的字典的同名键
    - 默认使用深度合并，可以处理嵌套字典结构
    - 支持任意数量的字典参数

    Args:
        configs: 列表，里面是多个字典
                 例如：merge_configs([D, C, B, A]) 表示D优先级最高，A最低

    Returns:
        dict: 合并后的配置字典

    使用示例:
        >>> A = {'a': 1, 'b': {'x': 10}}
        >>> B = {'b': {'y': 20}, 'c': 3}
        >>> C = {'a': 100, 'd': 4}
        >>> result = merge_configs(C, B, A)  # C优先级最高
        # result = {'a': 100, 'b': {'x': 10, 'y': 20}, 'c': 3, 'd': 4}

    注意:
        - 优先级：后面的参数优先级更高（会覆盖前面的同键值）
        - 深度合并：嵌套字典会递归合并，非字典值会被直接覆盖
        - 不修改原字典：返回新的合并结果字典
    """
    result = {}

    # 从低优先级到高优先级依次合并
    for config_dict in configs:
        if config_dict is None:
            continue

        if deep and isinstance(config_dict, dict):
            # 深度合并
            result = _deep_merge(result, config_dict)
        else:
            # 浅层合并
            if isinstance(config_dict, dict):
                result.update(config_dict)

    return result


def _deep_merge(dict1, dict2):
    """
    递归合并字典

    Args:
        dict1 (dict): 基础字典
        dict2 (dict): 要合并的字典（优先级更高）

    Returns:
        dict: 深度合并后的字典

    递归逻辑说明:
    - 如果两个值都是字典，则递归合并子字典
    - 如果只有一个值是字典或都不是字典，则用dict2的值覆盖
    - 正确处理多层嵌套结构，如：{'db': {'config': {'port': 3306}}}
    """
    result = {}

    # 合并dict1到结果中
    for key, value in dict1.items():
        if isinstance(value, dict):
            # 如果是字典，创建深拷贝避免修改原数据
            result[key] = _deep_copy_dict(value)
        else:
            result[key] = value

    # 合并dict2到结果中，处理冲突
    for key, value in dict2.items():
        if key in result:
            # 键存在，需要处理冲突
            old_value = result[key]

            if isinstance(old_value, dict) and isinstance(value, dict):
                # 两个都是字典，递归合并
                result[key] = _deep_merge(old_value, value)
            else:
                # 类型不匹配或都不是字典，直接覆盖（dict2优先级更高）
                if isinstance(value, dict):
                    result[key] = _deep_copy_dict(value)
                else:
                    result[key] = value
        else:
            # 新键，直接添加
            if isinstance(value, dict):
                result[key] = _deep_copy_dict(value)
            else:
                result[key] = value

    return result


def _deep_copy_dict(d):
    """
    深拷贝字典的辅助函数，支持任意嵌套层级

    Args:
        d (dict): 要拷贝的字典

    Returns:
        dict: 深拷贝的字典

    注意：这个函数专门处理字典类型的深拷贝，比copy.deepcopy()更高效
    """
    if not isinstance(d, dict):
        return d

    result = {}
    for key, value in d.items():
        if isinstance(value, dict):
            result[key] = _deep_copy_dict(value)  # 递归拷贝子字典
        elif isinstance(value, list):
            # 处理列表中可能包含的字典
            result[key] = [_deep_copy_dict(item) if isinstance(item, dict) else item for item in value]
        else:
            result[key] = value

    return result


def parse_to_dict(flat_config):
    """
    解析成嵌套的字典格式

    :param flat_config:
    :return:
    """
    nested = {}
    for key, value in flat_config.items():
        parts = key.split('.')
        current = nested
        for part in parts[:-1]:
            current = current.setdefault(part, {})
        current[parts[-1]] = value
    return nested
