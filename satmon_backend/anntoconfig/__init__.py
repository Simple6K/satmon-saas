"""anntoconfig（vendored 本地版）。

来源：python-scaffold 技能目录的用户替换实现（2026-09-27）。
本项目走纯本地 application.yaml 配置，不依赖 Apollo 远程配置中心——
config_apollo.py 中的 pyapollo 导入已做 ImportError 保护，无 apollo 配置段时不会实例化客户端。

对外暴露脚手架模板约定的接口：`from anntoconfig import Config`，用法 `Config().get(key)`。
"""

from .config import AnntoConfig

__all__ = ["Config", "AnntoConfig"]


class Config(AnntoConfig):
    """适配层：把 AnntoConfig.get_value 映射为模板调用的 .get(key, default)。

    初始化为本地模式（application.yaml 不含 apollo 段时不启动轮询线程）。
    """

    def get(self, key: str, default=None):
        try:
            value = self.get_value(key)
        except Exception:
            return default
        return default if value is None else value
