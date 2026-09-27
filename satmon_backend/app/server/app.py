from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.common.handler import register_exception_handlers, register_middlewares
from app.log.log import logger
from app.server.router import api_router


@asynccontextmanager
async def lifespan(_: FastAPI):
    """应用启动/关闭钩子：初始化存储与种子数据、启停定时任务。

    注意：httpx ASGITransport（测试客户端）不触发 lifespan——测试环境不会启动调度器、
    不会执行初始化；需要库表与种子的测试请在 fixture 中自行调用 init_database()
    （见 tests/conftest.py 的 temp_db fixture）。
    """
    from app.db.seed import init_database
    init_database()
    from app.jobs.scheduler import shutdown_scheduler, start_scheduler
    start_scheduler()
    yield
    shutdown_scheduler()


def create_app() -> FastAPI:
    """创建并配置 FastAPI 应用实例。"""
    application = FastAPI(
        title="satmon_backend",
        description="卫星遥感监测 SaaS 平台后端（多租户订阅/监测任务/影像检索/变化检测/报告）",
        version="0.1.0",
        lifespan=lifespan,
    )

    # CORS：仅放行 Vite dev 源（契约 §0）
    from fastapi.middleware.cors import CORSMiddleware
    application.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # 注册路由
    application.include_router(api_router)

    # 注册异常处理器
    register_exception_handlers(application)

    # 注册中间件（如需自定义中间件，请在 app/core/middlewares/ 中实现后在此注册）
    register_middlewares(application)

    logger.info("satmon_backend 应用实例创建完成")

    return application
