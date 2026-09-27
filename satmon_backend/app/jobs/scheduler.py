"""定时任务：APScheduler（由 server/app.py 的 lifespan 启停）。

硬约束：调度器为进程内单例——**多 worker 部署会重复触发任务**，
所有环境配置的 server.workers 必须为 1（各 application_*.yaml 已注释说明）。

当前唯一作业：任务状态机推进（契约 §4）——每 30s 扫描非终态任务，
queued → retrieving → analyzing → completed 单步推进，结果取 fixtures。
"""

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from app.log.log import logger
from app.service.task_engine import advance_tasks

_scheduler: AsyncIOScheduler | None = None

# 契约 §4：APScheduler 每 30s 推进任务状态机
ADVANCE_INTERVAL_SECONDS = 30


def start_scheduler() -> AsyncIOScheduler:
    global _scheduler
    if _scheduler is not None:
        return _scheduler
    _scheduler = AsyncIOScheduler(timezone="UTC")
    _scheduler.add_job(
        advance_tasks,
        "interval",
        seconds=ADVANCE_INTERVAL_SECONDS,
        id="advance_tasks",
        replace_existing=True,
        max_instances=1,  # 上一轮未跑完时不叠加执行（SQLite 短连接也不宜并发写）
    )
    _scheduler.start()
    logger.info("定时调度已启动（任务状态机推进，每 %ss）", ADVANCE_INTERVAL_SECONDS)
    return _scheduler


def shutdown_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("定时调度已关闭")
