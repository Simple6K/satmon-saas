"""anntologger（vendored 本地版）。

来源：python-scaffold 技能目录的用户替换实现（2026-09-27）。

对外暴露脚手架模板约定的接口：`from anntologger import Logger`，用法 `Logger.getLogger(name)`。
实现方式：首次 getLogger 时调用 vendored 的 setup_logger() 配置 loguru sinks
（控制台 + logs/annto_app.log 按日轮转），随后返回标准 logging logger——
标准 logger 经 InterceptHandler 转发到 loguru，模板代码按 std logging 接口使用即可。
"""

import logging
import threading

_initialized = False
_lock = threading.Lock()


def _ensure_initialized() -> None:
    global _initialized
    if _initialized:
        return
    with _lock:
        if _initialized:
            return
        try:
            from .log import setup_logger

            setup_logger()
        except Exception:
            pass
        _initialized = True


class Logger:
    @staticmethod
    def getLogger(name: str = "annto_app"):
        _ensure_initialized()
        return logging.getLogger(name)


__all__ = ["Logger"]
