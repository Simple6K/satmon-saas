import time
import traceback

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from app.api.common.exceptions import BusinessException
from app.api.common.response import ResponseModel, StatusCode
from app.log.log import logger

# HTTPException → 统一信封业务码映射：4xx 不再返回 {"detail": ...} 裸格式，
# 前端始终拿到 {code, msg, data}，同时保留原 HTTP 状态码。
_HTTP_CODE_MAP = {400: StatusCode.PARAM_INVALID, 404: StatusCode.RESOURCE_NOT_FOUND}


def register_exception_handlers(app):
    """注册全局异常处理器到 FastAPI 应用。"""

    @app.exception_handler(BusinessException)
    async def business_exception_handler(request: Request, exc: BusinessException):
        logger.warning(f"业务异常: {exc.msg} (code={exc.code})")
        response = ResponseModel(code=exc.code, msg=exc.msg)
        return JSONResponse(status_code=200, content=response.model_dump())

    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, exc: HTTPException):
        code = _HTTP_CODE_MAP.get(exc.status_code, StatusCode.SYSTEM_ERROR)
        return JSONResponse(status_code=exc.status_code,
                            content=ResponseModel(code=code, msg=str(exc.detail)).model_dump())

    @app.exception_handler(Exception)
    async def global_exception_handler(request: Request, exc: Exception):
        logger.error(f"未处理异常: {traceback.format_exc()}")
        response = ResponseModel(code=StatusCode.SYSTEM_ERROR, msg="系统内部错误")
        return JSONResponse(status_code=500, content=response.model_dump())


def register_middlewares(app):
    """注册全局中间件到 FastAPI 应用。"""

    @app.middleware("http")
    async def request_timer_middleware(request: Request, call_next):
        start_time = time.time()
        response = await call_next(request)
        process_time = time.time() - start_time
        response.headers["X-Response-Time"] = f"{process_time:.4f}s"
        return response
