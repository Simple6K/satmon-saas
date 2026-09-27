import asyncio
from datetime import datetime
from enum import IntEnum
from functools import wraps
from typing import Any, Optional

from pydantic import BaseModel


class StatusCode(IntEnum):
    """统一状态码枚举。"""
    SUCCESS = 0

    # 参数错误 (1xxx)
    PARAM_MISSING = 1001
    PARAM_FORMAT_ERROR = 1002
    PARAM_INVALID = 1003

    # 业务异常 (2xxx)
    BUSINESS_ERROR = 2000
    RESOURCE_NOT_FOUND = 2001
    RESOURCE_ALREADY_EXISTS = 2002
    PERMISSION_DENIED = 2003

    # 系统异常 (5xxx)
    SYSTEM_ERROR = 5000
    DATABASE_ERROR = 5001
    EXTERNAL_SERVICE_ERROR = 5002


class ResponseModel(BaseModel):
    """统一 API 响应模型。"""
    code: int = StatusCode.SUCCESS
    msg: str = "success"
    data: Optional[Any] = None
    timestamp: str = ""

    def model_post_init(self, __context: Any) -> None:
        if not self.timestamp:
            self.timestamp = datetime.now().isoformat()


def assemble_response(func):
    """装饰器：自动将返回值包装为统一响应格式。同时支持同步和异步函数。"""
    if asyncio.iscoroutinefunction(func):
        @wraps(func)
        async def async_wrapper(*args, **kwargs):
            result = await func(*args, **kwargs)
            if isinstance(result, ResponseModel):
                return result
            return ResponseModel(data=result)
        return async_wrapper
    else:
        @wraps(func)
        def sync_wrapper(*args, **kwargs):
            result = func(*args, **kwargs)
            if isinstance(result, ResponseModel):
                return result
            return ResponseModel(data=result)
        return sync_wrapper
