"""变化检测结果端点（契约 §5 / US-07/08）：斑块集合与单斑块举证详情。"""

import json

from fastapi import APIRouter, Depends

from app.api.common.exceptions import ApiHTTPException
from app.api.common.response import StatusCode, assemble_response
from app.api.deps import current_user
from app.db.sqlite import db

router = APIRouter(tags=["results"])

# 举证上下文图层可用性（契约 §5 固定标注）：
# - imerg 固定 2km（GIBS 用 6km 会被 400 拒绝，实测结论，不可改参）
# - poi 经 maps.mail.ru Overpass 镜像实测不稳，MVP 标记不可用（降级演示点）
CONTEXT_LAYERS = {
    "worldcover": "available",
    "worldpop": "available",
    "imerg": "available_2km",
    "poi": "unavailable",
}


def get_tenant_task_or_404(conn, tenant_id: str, task_id: str):
    row = conn.execute(
        "SELECT id, name FROM tasks WHERE id = ? AND tenant_id = ?", (task_id, tenant_id)
    ).fetchone()
    if row is None:
        raise ApiHTTPException(
            status_code=404, code=StatusCode.RESOURCE_NOT_FOUND, msg="任务不存在")
    return row


@router.get("/tasks/{task_id}/results")
@assemble_response
async def get_results(task_id: str, user: dict = Depends(current_user)):
    """本任务变化检测结果：统计摘要 + 斑块 FeatureCollection。"""
    with db() as conn:
        get_tenant_task_or_404(conn, user["tenantId"], task_id)
        rows = conn.execute(
            "SELECT * FROM patches WHERE task_id = ? AND tenant_id = ?"
            " ORDER BY area_km2 DESC",
            (task_id, user["tenantId"]),
        ).fetchall()

    features, by_type = [], {}
    total = 0.0
    for r in rows:
        props = {
            "patchId": r["id"],
            "areaKm2": round(r["area_km2"], 4),
            "confidence": r["confidence"],
            "changeType": r["change_type"],
            "beforeDate": r["before_date"],
            "afterDate": r["after_date"],
            "alertLevel": r["alert_level"],
        }
        features.append({
            "type": "Feature",
            "properties": props,
            "geometry": json.loads(r["geojson"]),
        })
        total += r["area_km2"]
        by_type[r["change_type"]] = by_type.get(r["change_type"], 0) + r["area_km2"]

    return {
        "taskId": task_id,
        "stats": {
            "patchCount": len(rows),
            "totalAreaKm2": round(total, 4),
            "byType": {k: round(v, 4) for k, v in by_type.items()},
        },
        "geojson": {"type": "FeatureCollection", "features": features},
    }


@router.get("/tasks/{task_id}/results/{patch_id}")
@assemble_response
async def get_patch_detail(task_id: str, patch_id: str,
                           user: dict = Depends(current_user)):
    """斑块举证详情：量化属性 + 上下文图层可用性（POI 不可用为降级演示点）。"""
    with db() as conn:
        get_tenant_task_or_404(conn, user["tenantId"], task_id)
        row = conn.execute(
            "SELECT * FROM patches WHERE id = ? AND task_id = ? AND tenant_id = ?",
            (patch_id, task_id, user["tenantId"]),
        ).fetchone()
        if row is None:
            raise ApiHTTPException(
                status_code=404, code=StatusCode.RESOURCE_NOT_FOUND, msg="斑块不存在")
    return {
        "patchId": row["id"],
        "taskId": task_id,
        "areaKm2": round(row["area_km2"], 4),
        "confidence": row["confidence"],
        "changeType": row["change_type"],
        "beforeDate": row["before_date"],
        "afterDate": row["after_date"],
        "alertLevel": row["alert_level"],
        "geojson": json.loads(row["geojson"]),
        "contextLayers": CONTEXT_LAYERS,
    }
