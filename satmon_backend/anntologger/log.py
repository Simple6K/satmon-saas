#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
@Project : anntologger
@File : log.py
@Author : annto-dev
@Date : 2025/10/23 09:49
"""

# 日志模块配置文件
# 负责应用程序的日志记录功能，包括控制台输出和文件记录
# 支持定时轮转的日志文件管理
from typing import Any, Dict, List, Optional, Union
import sys,os
from pathlib import Path
import logging
import logging.handlers
from uvicorn.logging import AccessFormatter,DefaultFormatter
from loguru._logger import Logger,Core
from loguru import logger
import traceback


level = "INFO"
os.makedirs(str(Path.cwd().joinpath("logs").resolve()), exist_ok=True)
path_ = str(Path.cwd().joinpath("logs/annto_app.log").resolve())
name = "annto_app"
filter = ""

def custom_error_sink(message):
    # 自定义错误处理逻辑
    if message.record["level"].name == "ERROR":
        # 修改消息或执行额外操作
        exc_info = sys.exc_info()
        if exc_info[0] != None:
            exc_type, exc_value, exc_traceback = exc_info
            exc_msg = "".join(traceback.format_exception(exc_type, exc_value, exc_traceback))
            message.record["message"] = message.record["message"] + "\n" + exc_msg



"""
更详细的报错
diagnose 异常跟踪是否应显示变量值以简化调试。应在生产中设置为以避免泄露敏感数据。
backtrace 格式化的异常跟踪是否应向上扩展，超出捕获点，以显示生成错误的完整堆栈跟踪。
"""
# 时间-级别-采集器名称-【代码文件名:行数】- 日志信息

# log_format = "{time:YYYY-MM-DD HH:mm:ss.SSS} - {level} - {extra[name]} - [{file}:{line}] - {message}"
# log_format = "{time:YYYY-MM-DD HH:mm:ss.SSS} - {level} - {name} - [{file}:{line}] - {message}"
log_format = (
    "<light-blue>{time:YYYY-MM-DD HH:mm:ss.SSS}</light-blue> - "
    "<level>{level: <8}</level> - "
    "<magenta>{name}</magenta> - "
    "<cyan>[{file}:{line}]</cyan> - "
    "<level>{message}</level>"
)

log_format_file = "{time:YYYY-MM-DD HH:mm:ss.SSS} - {level} - {name} - [{file}:{line}] - {message}"

logger.remove()
logger.add(custom_error_sink,level='ERROR')
logger.add(sys.stderr,
           format=log_format,
           level=level,colorize=True)
logger.add(
    path_,
    format=log_format_file,
    level=level,
    rotation="00:00",
    retention="30 days",
    enqueue=True,
    colorize=True,
    diagnose=False,
    backtrace=False
           )

class InterceptHandler(logging.Handler):
    """
    继承logging的日志，是一个统一的
    """

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

#
# def logger_init(log_config:Dict):
#     global logger,level,name,path_
#     try:
#         level = log_config.get("leave",None) if log_config.get("leave",None) else level
#         path_ = log_config.get("path",None) if log_config.get("leave",None) else path_
#         name = log_config.get("name",None) if log_config.get("name",None) else name
#
def setup_logger(log_config:Dict={},
                 set_filter:Any=""):
    global logger,level,name,path_,filter
    try:
        if  log_config.get("path",False):
            path_ = log_config.get("path",path_)
            os.makedirs(str(Path.cwd().joinpath(path_).resolve()), exist_ok=True)
            path_ = str(Path.cwd().joinpath(f"{path_}/annto_app.log").resolve())
        level = log_config.get("level",level)
        name = log_config.get("name",name)
        diagnose = log_config.get("diagnose",False)
        backtrace = log_config.get("backtrace",False)
        if set_filter:
            filter = set_filter
        logger.remove()
        logger.add(custom_error_sink, level='ERROR')
        logger.add(sys.stderr,
                   format=log_format,
                   filter=filter,
                   level=level,colorize=True)
        logger.add(
            path_,
            format=log_format_file,
            level=level,
            filter=filter,
            rotation="00:00",
            retention="30 days",
            enqueue=True,
            colorize=True,
            diagnose=diagnose,
            backtrace=backtrace
                   )
    except:
        logger.error("日志设置刷新失败")



__all__ = ['logger',"uvicorn_init_log"]
# print(f"初始化的日志文件路径{path_}")
