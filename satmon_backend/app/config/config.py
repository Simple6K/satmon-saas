import os

try:
    from anntoconfig import Config as AnntoConfig

    _config_client = AnntoConfig()
except ImportError:
    _config_client = None


def get_config(key: str, default=None):
    """根据 key 获取配置值。

    优先使用 anntoconfig SDK，降级到环境变量。
    """
    if _config_client is not None:
        try:
            value = _config_client.get(key)
            if value is not None:
                return value
        except Exception:
            pass

    return os.getenv(key, default)


def get_env() -> str:
    """获取当前环境名称。"""
    return get_config("APP_ENV", os.getenv("APP_ENV", "local"))
