#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
@Project : anntoPySdk
@File : log_logging.py
@Author : annto-dev
@Date : 2025/10/9 17:24
"""

# 日志模块配置文件
# 负责应用程序的日志记录功能，包括控制台输出和文件记录
# 支持定时轮转的日志文件管理

import sys,os
from pathlib import Path
import logging
import logging.handlers
from time import localtime
from anntoconfig.config import config
from uvicorn.logging import AccessFormatter,DefaultFormatter
from loguru import Logger
import traceback
path_ = config.get("log",{}).get("path",False)
if not path_:
    path_ = list(Path.cwd().glob("logs"))
    if len(path_)!=0:
        path_ = str(path_[0].joinpath("annto_app.log").resolve())
    else:
        os.makedirs(Path.cwd().joinpath("logs"))
        path_ = str(Path.cwd().joinpath("logs/annto_app.log").resolve())
else:
    path_ = str(Path(path_).resolve())
level = config.get("log",{}).get("level","INFO")
name = config.get("log",{}).get("name","annto_app")

class CustomLogger(Logger):
    """自定义 Logger，error 方法默认记录异常信息"""

    def error(self, msg, *args, exc_info=False, **kwargs):
        exc_traceback = traceback.format_exc()
        if exc_traceback.strip() and exc_traceback != "NoneType: None\n":
            exc_traceback = traceback.format_exc()
            msg = msg+"\n"+exc_traceback
            kwargs['exc_info'] =exc_info
        super().error(msg, *args,**kwargs)

logger = CustomLogger.bind(name=name)


"""
更详细的报错
diagnose 异常跟踪是否应显示变量值以简化调试。应在生产中设置为以避免泄露敏感数据。
backtrace 格式化的异常跟踪是否应向上扩展，超出捕获点，以显示生成错误的完整堆栈跟踪。
"""
# 时间-级别-采集器名称-【代码文件名:行数】- 日志信息

log_format = "{time:YYYY-MM-DD HH:mm:ss.SSS} - {level} - {name} - [{file}:{line}] - {message}"

logger.add(sys.stderr,
           format=log_format,
           level=level)

logger.add(path_,
           format=log_format,
           level=level,
           rotation="00:00",
           retention="30 days",
           )
# 时间-级别-采集器名称-【代码文件名:行数】- 日志信息
log_format = logging.Formatter('%(asctime)s - %(levelname)s - %(name)s - [%(filename)s:%(lineno)d] - %(message)s')
logging.setLoggerClass(CustomLogger)
logger = logging.getLogger(name)
_stream_handler = logging.StreamHandler(sys.stdout)
_stream_handler.setLevel(level)
_stream_handler.setFormatter(log_format)
logger.addHandler(_stream_handler)
_time = localtime()
_file_handler = logging.handlers.TimedRotatingFileHandler(path_, when='D', interval=1, backupCount=30, encoding='utf-8')
_file_handler.setLevel(level)
_file_handler.setFormatter(log_format)
logger.addHandler(_file_handler)
logger.setLevel(level)


class InterceptHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        # Get corresponding Loguru level if it exists.
        level: str | int
        try:
            level = logger.level(record.levelname).name
        except ValueError:
            level = record.levelno

        # Find caller from where originated the logged message.
        frame, depth = logging.currentframe(), 0
        while frame and (depth == 0 or frame.f_code.co_filename == logging.__file__):
            frame = frame.f_back
            depth += 1

        logger.opt(depth=depth, exception=record.exc_info).log(level, record.getMessage())

def uvicorn_init_log():
    """
    初始化Uvicorn日志配置

    """
    uv_access_handler = logging.StreamHandler(sys.stdout)
    uv_access_handler.setLevel(level)
    access_formatter = AccessFormatter(
        fmt='%(asctime)s - %(levelname)s - %(name)s - %(request_line)s : %(status_code)s'
    )
    uv_access_handler.setFormatter(access_formatter)
    uv_handler = logging.StreamHandler(sys.stdout)
    uv_handler.setLevel(level)
    uv_formatter = DefaultFormatter(
        fmt='%(asctime)s - %(levelname)s - %(message)s'
    )
    uv_handler.setFormatter(uv_formatter)

    uvicorn_access = logging.getLogger("uvicorn.access")
    uvicorn_logger = logging.getLogger("uvicorn")
    uvicorn_error = logging.getLogger("uvicorn.error")

    for uv_log in [uvicorn_error,uvicorn_access,uvicorn_logger]:
        for handler in uv_log.handlers[:]:
            uv_log.removeHandler(handler)
        if uv_log.name =="uvicorn.access":
            uv_log.addHandler(uv_access_handler)
        else:
            uv_log.addHandler(uv_handler)
        uv_log.propagate = False
        uv_log.setLevel(level)
        uv_log.handlers =  [InterceptHandler()]


class InterceptHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        # Get corresponding Loguru level if it exists.
        level: str | int
        try:
            level = logger.level(record.levelname).name
        except ValueError:
            level = record.levelno

        # Find caller from where originated the logged message.
        frame, depth = logging.currentframe(), 0
        while frame and (depth == 0 or frame.f_code.co_filename == logging.__file__):
            frame = frame.f_back
            depth += 1

        logger.opt(depth=depth, exception=record.exc_info).log(level, record.getMessage())

__all__ = ['logger',"uvicorn_init_log"]

# print(f"初始化的日志文件路径{path_}")
