"""报告端点（契约 §6 / US-09）：生成 / 列表 / 详情。

后端只供数据（sections JSON），PDF 由前端 print-CSS/jsPDF 生成。
生成动作不改变任务状态，决策审批者（画像 B）是报告的主要使用者，
故所有角色可生成（契约 §0 写操作白名单不含报告）。
"""

import json
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.api.common.exceptions import ApiHTTPException
from app.api.common.response import StatusCode, assemble_response
from app.api.deps import current_user
from app.db.sqlite import db

router = APIRouter(prefix="/reports", tags=["reports"])

# 方法学附注固定文案（对齐 PRD：数据源能力如实披露，不承诺未实现的能力）
_METHOD_NOTE = (
    "主数据源 Sentinel-2 L2A 10m（Copernicus Data Space，影像延迟 ≤ 5 天，"
    "年内有效重访 ≥ 11 次）；辅助数据源 Landsat 8/9 15-30m（USGS STAC，"
    "主源不可达时降级使用，分辨率降级可能影响小斑块识别）。变化检测结果"
    "基于双时相影像对比，最小可识别变化约受像元分辨率限制；举证建议结合"
    "ESA WorldCover 2021 10m 土地利用底数与现场核查。"
)

_MONITOR_TYPE_LABELS = {
    "illegal_construction": "违建识别",
    "farmland_non_agri": "耕地非农化",
    "urban_expansion": "城市扩张",
    "surface_change": "地表变化检测",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _build_sections(task, aoi, patches: list[dict], scene_count: int) -> dict:
    by_type: dict[str, dict] = {}
    for p in patches:
        entry = by_type.setdefault(p["change_type"], {"count": 0, "areaKm2": 0.0})
        entry["count"] += 1
        entry["areaKm2"] += p["area_km2"]
    top10 = sorted(patches, key=lambda p: p["area_km2"], reverse=True)[:10]

    return {
        "overview": {
            "taskName": task["name"],
            "monitorType": task["monitor_type"],
            "monitorTypeLabel": _MONITOR_TYPE_LABELS.get(task["monitor_type"]),
            "aoiName": aoi["name"],
            "aoiAreaKm2": round(aoi["area_km2"], 4),
            "aoiGeojson": json.loads(aoi["geojson"]),
            "timeWindow": {"start": task["start_date"], "end": task["end_date"]},
            "cloudMaxPct": task["cloud_max_pct"],
            "dataSource": {
                "sceneCount": scene_count,
                "note": "Sentinel-2 L2A 10m（Copernicus Data Space OData 目录检索）",
            },
        },
        "stats": {
            "patchCount": len(patches),
            "totalAreaKm2": round(sum(p["area_km2"] for p in patches), 4),
            "byType": [
                {"changeType": k, "count": v["count"], "areaKm2": round(v["areaKm2"], 4)}
                for k, v in sorted(by_type.items(), key=lambda kv: -kv[1]["areaKm2"])
            ],
            "top10Patches": [
                {
                    "patchId": p["id"],
                    "areaKm2": round(p["area_km2"], 4),
                    "changeType": p["change_type"],
                    "confidence": p["confidence"],
                    "beforeDate": p["before_date"],
                    "afterDate": p["after_date"],
                    "alertLevel": p["alert_level"],
                }
                for p in top10
            ],
        },
        "methodology": {"note": _METHOD_NOTE},
    }


class ReportCreateRequest(BaseModel):
    taskId: str  # noqa: N815 字段名对齐契约 §6


@router.post("")
@assemble_response
async def create_report(request: ReportCreateRequest,
                        user: dict = Depends(current_user)):
    """生成报告：聚合任务 / AOI / 斑块 / 影像景数据为 sections JSON 落库。"""
    with db() as conn:
        task = conn.execute(
            "SELECT t.*, a.name AS aoi_name, a.area_km2 AS aoi_area_km2,"
            " a.geojson AS aoi_geojson FROM tasks t"
            " JOIN aois a ON a.id = t.aoi_id"
            " WHERE t.id = ? AND t.tenant_id = ?",
            (request.taskId, user["tenantId"]),
        ).fetchone()
        if task is None:
            raise ApiHTTPException(
                status_code=404, code=StatusCode.RESOURCE_NOT_FOUND, msg="任务不存在")
        aoi = {
            "name": task["aoi_name"],
            "area_km2": task["aoi_area_km2"],
            "geojson": task["aoi_geojson"],
        }
        patches = [dict(r) for r in conn.execute(
            "SELECT * FROM patches WHERE task_id = ? AND tenant_id = ?"
            " ORDER BY area_km2 DESC",
            (request.taskId, user["tenantId"]),
        ).fetchall()]
        scene_count = conn.execute(
            "SELECT COUNT(*) AS c FROM task_scenes WHERE task_id = ?",
            (request.taskId,),
        ).fetchone()["c"]

        report_id = f"report-{uuid.uuid4().hex[:10]}"
        generated_at = _now()
        sections = _build_sections(task, aoi, patches, scene_count)
        conn.execute(
            "INSERT INTO reports(id, tenant_id, task_id, generated_at, sections)"
            " VALUES (?,?,?,?,?)",
            (report_id, user["tenantId"], request.taskId, generated_at,
             json.dumps(sections, ensure_ascii=False)),
        )
    return {"id": report_id, "taskId": request.taskId,
            "generatedAt": generated_at, "sections": sections}


@router.get("")
@assemble_response
async def list_reports(user: dict = Depends(current_user)):
    """本租户报告列表（时间倒序）。"""
    with db() as conn:
        rows = conn.execute(
            "SELECT r.id, r.task_id, r.generated_at, t.name AS task_name FROM reports r"
            " JOIN tasks t ON t.id = r.task_id"
            " WHERE r.tenant_id = ? ORDER BY r.generated_at DESC",
            (user["tenantId"],),
        ).fetchall()
    return [{
        "id": r["id"],
        "taskId": r["task_id"],
        "taskName": r["task_name"],
        "generatedAt": r["generated_at"],
    } for r in rows]


@router.get("/{report_id}")
@assemble_response
async def get_report(report_id: str, user: dict = Depends(current_user)):
    """报告详情（完整 sections）。"""
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM reports WHERE id = ? AND tenant_id = ?",
            (report_id, user["tenantId"]),
        ).fetchone()
        if row is None:
            raise ApiHTTPException(
                status_code=404, code=StatusCode.RESOURCE_NOT_FOUND, msg="报告不存在")
    return {
        "id": row["id"],
        "taskId": row["task_id"],
        "generatedAt": row["generated_at"],
        "sections": json.loads(row["sections"]),
    }
