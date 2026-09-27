from fastapi import APIRouter

from app.api.alerts import router as alerts_router
from app.api.aoi import router as aoi_router
from app.api.auth import router as auth_router
from app.api.health import router as health_router
from app.api.messages import router as messages_router
from app.api.reports import router as reports_router
from app.api.results import router as results_router
from app.api.subscription import router as subscription_router
from app.api.tasks import router as tasks_router

# 契约 §0：后端统一前缀 /api
api_router = APIRouter(prefix="/api")

api_router.include_router(health_router)
api_router.include_router(auth_router)
api_router.include_router(subscription_router)
api_router.include_router(aoi_router)
api_router.include_router(tasks_router)
api_router.include_router(results_router)
api_router.include_router(alerts_router)
api_router.include_router(messages_router)
api_router.include_router(reports_router)
