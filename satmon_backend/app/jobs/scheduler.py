"""定时任务：APScheduler（由 server/app.py 的 lifespan 启停）。

硬约束：调度器为进程内单例——**多 worker 部署会重复触发任务**，
所有环境配置的 server.workers 必须为 1（各 application_*.yaml 已注释说明）。
"""

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from app.config.config import get_config
from app.log.log import logger

_scheduler: AsyncIOScheduler | None = None


def demo_job() -> None:
    """示例任务：替换为实际业务逻辑。长任务请用线程池（APScheduler 默认线程池执行同步函数）。"""
    logger.info("demo job triggered")


def start_scheduler() -> AsyncIOScheduler:
    global _scheduler
    if _scheduler is not None:
        return _scheduler
    _scheduler = AsyncIOScheduler(timezone="Asia/Shanghai")
    _scheduler.add_job(
        demo_job,
        "cron",
        hour=get_config("jobs.cron.hour", 0),
        minute=get_config("jobs.cron.minute", 35),
        id="demo_job",
        replace_existing=True,
    )
    _scheduler.start()
    logger.info("定时调度已启动（每日 %s:%s Asia/Shanghai）",
                get_config("jobs.cron.hour", 0), get_config("jobs.cron.minute", 35))
    return _scheduler


def shutdown_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("定时调度已关闭")
