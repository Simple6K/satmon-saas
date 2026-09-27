from fastapi import APIRouter

from app.api.common.response import ResponseModel, assemble_response

router = APIRouter(prefix="/health", tags=["health"])


@router.get("/live")
@assemble_response
async def liveness():
    """存活探针。"""
    return {"status": "alive"}


@router.get("/ready")
@assemble_response
async def readiness():
    """就绪探针。"""
    return {"status": "ready"}
