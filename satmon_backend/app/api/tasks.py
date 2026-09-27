"""监测任务端点（契约 §4）：创建 / 列表 / 详情 / 取消 / 影像检索预演（estimate）。

- 租户隔离：一切查询按 token tenantId 过滤，跨租户任务 ID 返回 404（US-11）
- estimate 走 OData → STAC 降级链（PRD 5.2），X-Debug-Fail 头模拟外部源超时
  用于现场一键演示降级路径
- 并发配额：非终态任务数达套餐上限时 400 并带 usage（联动 US-03 验收）
"""

import json
import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from app.adapters import copernicus_odata, usgs_stac
from app.adapters.copernicus_odata import search_scenes as odata_search
from app.adapters.usgs_stac import search_scenes as stac_search
from app.api.common.exceptions import ApiHTTPException
from app.api.common.response import StatusCode, assemble_response
from app.api.deps import current_user, require_writer
from app.db.sqlite import db
from app.utils.geo import centroid_and_bbox, mgrs_tile

router = APIRouter(prefix="/tasks", tags=["tasks"])

MONITOR_TYPES = ("illegal_construction", "farmland_non_agri", "urban_expansion", "surface_change")

_TASK_STATUSES = ("queued", "retrieving", "analyzing", "completed", "failed", "cancelled")
_RUNNING = ("queued", "retrieving", "analyzing")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_audit(conn, tenant_id: str, actor: str, action: str, detail: str) -> None:
    # 与 subscription 模块的 _write_audit 同形；两处各自演进，暂不抽公共模块
    conn.execute(
        "INSERT INTO audit_logs(id, tenant_id, at, actor, action, detail) VALUES (?,?,?,?,?,?)",
        (f"audit-{uuid.uuid4().hex[:12]}", tenant_id, _now(), actor, action, detail),
    )


def _get_tenant_task(conn, tenant_id: str, task_id: str):
    row = conn.execute(
        "SELECT * FROM tasks WHERE id = ? AND tenant_id = ?", (task_id, tenant_id)
    ).fetchone()
    if row is None:
        raise ApiHTTPException(
            status_code=404, code=StatusCode.RESOURCE_NOT_FOUND, msg="任务不存在"
        )
    return row


def _stage(raw) -> dict:
    try:
        stage = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        stage = {}
    return stage if isinstance(stage, dict) else {}


class TaskCreateRequest(BaseModel):
    name: str
    aoiId: str          # noqa: N815 字段名对齐契约 §4
    monitorType: str    # noqa: N815
    startDate: str      # noqa: N815
    endDate: str        # noqa: N815
    cloudMaxPct: int    # noqa: N815


@router.post("")
@assemble_response
async def create_task(request: TaskCreateRequest, user: dict = Depends(require_writer)):
    """创建监测任务：AOI 归属 / 枚举 / 时间窗 / 并发配额校验，成功置 queued。"""
    if not request.name.strip():
        raise ApiHTTPException(
            status_code=400, code=StatusCode.PARAM_INVALID, msg="任务名称不能为空")
    if request.monitorType not in MONITOR_TYPES:
        raise ApiHTTPException(
            status_code=400, code=StatusCode.PARAM_INVALID,
            msg="monitorType 必须为 " + " / ".join(MONITOR_TYPES))
    if not _DATE_RE.match(request.startDate) or not _DATE_RE.match(request.endDate):
        raise ApiHTTPException(
            status_code=400, code=StatusCode.PARAM_INVALID,
            msg="startDate/endDate 须为 YYYY-MM-DD 格式")
    if request.startDate >= request.endDate:
        raise ApiHTTPException(
            status_code=400, code=StatusCode.PARAM_INVALID, msg="startDate 必须早于 endDate")
    if not 0 <= request.cloudMaxPct <= 100:
        raise ApiHTTPException(
            status_code=400, code=StatusCode.PARAM_INVALID,
            msg="cloudMaxPct 须在 0-100 之间")

    with db() as conn:
        aoi = conn.execute(
            "SELECT * FROM aois WHERE id = ? AND tenant_id = ?",
            (request.aoiId, user["tenantId"]),
        ).fetchone()
        if aoi is None:
            raise ApiHTTPException(
                status_code=404, code=StatusCode.RESOURCE_NOT_FOUND,
                msg="AOI 不存在（跨租户资源不可见）")

        plan = conn.execute(
            "SELECT p.max_concurrent_tasks AS mct, p.area_limit_km2 AS alimit"
            " FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = ?",
            (user["tenantId"],),
        ).fetchone()
        running = conn.execute(
            "SELECT COUNT(*) AS c FROM tasks WHERE tenant_id = ? AND status IN (?,?,?)",
            (user["tenantId"], *_RUNNING),
        ).fetchone()["c"]
        aoi_area = conn.execute(
            "SELECT COALESCE(SUM(area_km2), 0) AS s FROM aois WHERE tenant_id = ?",
            (user["tenantId"],),
        ).fetchone()["s"]
        usage = {
            "concurrentTasks": running,
            "concurrentLimit": plan["mct"],
            "aoiAreaKm2": round(aoi_area, 4),
            "aoiAreaLimitKm2": plan["alimit"],
        }
        if running >= plan["mct"]:
            raise ApiHTTPException(
                status_code=400, code=StatusCode.PARAM_INVALID,
                msg=f"并发任务数已达上限（{running}/{plan['mct']}），"
                    f"请等待任务完成或升级套餐",
                data={"usage": usage},
            )
        if aoi_area > plan["alimit"]:
            raise ApiHTTPException(
                status_code=400, code=StatusCode.PARAM_INVALID,
                msg=f"AOI 总面积 {aoi_area:.2f} km² 超出套餐上限 {plan['alimit']:.0f} km²",
                data={"usage": usage},
            )

        task_id = f"task-{uuid.uuid4().hex[:10]}"
        now = _now()
        conn.execute(
            "INSERT INTO tasks(id, tenant_id, aoi_id, name, monitor_type, status, start_date,"
            " end_date, cloud_max_pct, stage, degraded, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (task_id, user["tenantId"], request.aoiId, request.name.strip(),
             request.monitorType, "queued", request.startDate, request.endDate,
             request.cloudMaxPct, json.dumps({"retrievalMs": 0, "analysisMs": 0,
                                              "current": "queued"}), 0, now, now),
        )
        _write_audit(conn, user["tenantId"], user["username"], "任务创建",
                     f"创建任务「{request.name.strip()}」（AOI：{aoi['name']}，"
                     f"时间窗 {request.startDate} ~ {request.endDate}）")
        row = conn.execute(
            "SELECT t.*, a.name AS aoi_name, a.monitor_type AS aoi_monitor_type,"
            " a.geojson AS aoi_geojson FROM tasks t"
            " JOIN aois a ON a.id = t.aoi_id"
            " WHERE t.id = ? AND t.tenant_id = ?",
            (task_id, user["tenantId"]),
        ).fetchone()
    return _task_detail_view(row, conn_scenes=True)


@router.get("")
@assemble_response
async def list_tasks(status: str = "", user: dict = Depends(current_user)):
    """本租户任务列表（可按状态过滤）。"""
    with db() as conn:
        if status:
            if status not in _TASK_STATUSES:
                raise ApiHTTPException(
                    status_code=400, code=StatusCode.PARAM_INVALID,
                    msg="status 必须为 " + "/".join(_TASK_STATUSES))
            rows = conn.execute(
                "SELECT t.*, a.name AS aoi_name FROM tasks t"
                " JOIN aois a ON a.id = t.aoi_id"
                " WHERE t.tenant_id = ? AND t.status = ? ORDER BY t.created_at DESC",
                (user["tenantId"], status),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT t.*, a.name AS aoi_name FROM tasks t"
                " JOIN aois a ON a.id = t.aoi_id"
                " WHERE t.tenant_id = ? ORDER BY t.created_at DESC",
                (user["tenantId"],),
            ).fetchall()
    return [{
        "id": r["id"],
        "name": r["name"],
        "monitorType": r["monitor_type"],
        "aoiName": r["aoi_name"],
        "status": r["status"],
        "createdAt": r["created_at"],
        "stage": _stage(r["stage"]),
        "degraded": bool(r["degraded"]),
    } for r in rows]


def _task_detail_view(row, conn_scenes: bool = True) -> dict:
    """任务详情视图：AOI 几何 + 时间窗 + 数据源结果摘要（task_scenes 聚合）。"""
    view = {
        "id": row["id"],
        "name": row["name"],
        "monitorType": row["monitor_type"],
        "status": row["status"],
        "stage": _stage(row["stage"]),
        "degraded": bool(row["degraded"]),
        "startDate": row["start_date"],
        "endDate": row["end_date"],
        "cloudMaxPct": row["cloud_max_pct"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }
    if "aoi_name" in row.keys():
        view["aoi"] = {
            "id": row["aoi_id"],
            "name": row["aoi_name"],
            "monitorType": row["aoi_monitor_type"] if "aoi_monitor_type" in row.keys() else None,
            "geojson": json.loads(row["aoi_geojson"]) if "aoi_geojson" in row.keys() else None,
        }
    if conn_scenes:
        with db() as conn:
            scenes = conn.execute(
                "SELECT source, sensing_date, cloud_pct, tile_id FROM task_scenes"
                " WHERE task_id = ? ORDER BY sensing_date DESC",
                (row["id"],),
            ).fetchall()
        view["scenesSummary"] = {
            "count": len(scenes),
            "sources": sorted({s["source"] for s in scenes}),
            "latestSensingDate": scenes[0]["sensing_date"] if scenes else None,
        }
    return view


@router.get("/{task_id}")
@assemble_response
async def get_task(task_id: str, user: dict = Depends(current_user)):
    """任务详情（含 AOI geojson、时间窗、数据源结果摘要）。"""
    with db() as conn:
        row = conn.execute(
            "SELECT t.*, a.name AS aoi_name, a.monitor_type AS aoi_monitor_type,"
            " a.geojson AS aoi_geojson FROM tasks t"
            " JOIN aois a ON a.id = t.aoi_id"
            " WHERE t.id = ? AND t.tenant_id = ?",
            (task_id, user["tenantId"]),
        ).fetchone()
        if row is None:
            raise ApiHTTPException(
                status_code=404, code=StatusCode.RESOURCE_NOT_FOUND, msg="任务不存在")
    return _task_detail_view(row, conn_scenes=True)


@router.post("/{task_id}/cancel")
@assemble_response
async def cancel_task(task_id: str, user: dict = Depends(require_writer)):
    """取消任务：仅 queued/retrieving 可取消（3s 内生效、即时释放并发配额语义）。"""
    with db() as conn:
        row = _get_tenant_task(conn, user["tenantId"], task_id)
        if row["status"] not in ("queued", "retrieving"):
            raise ApiHTTPException(
                status_code=400, code=StatusCode.PARAM_INVALID,
                msg=f"任务当前状态为 {row['status']}，仅排队中/检索中的任务可取消")
        conn.execute(
            "UPDATE tasks SET status = 'cancelled',"
            " stage = ?, updated_at = ? WHERE id = ?",
            (json.dumps({**_stage(row["stage"]), "current": "cancelled"}), _now(), task_id),
        )
        _write_audit(conn, user["tenantId"], user["username"], "任务取消",
                     f"取消任务「{row['name']}」（{task_id}）")
        row = _get_tenant_task(conn, user["tenantId"], task_id)
    return _task_detail_view(row, conn_scenes=False)


def _scene_view(s) -> dict:
    return {
        "id": s.id,
        "sensingDate": s.sensing_date,
        "cloudPct": s.cloud_pct,
        "tileId": s.tile_id,
    }


async def _estimate(task_row, aoi_geojson: dict, debug_fail: str) -> dict:
    """OData → STAC 降级链（PRD 5.2）。

    debug_fail 为请求头 X-Debug-Fail 的值（odata|stac|all，支持逗号分隔）：
    命中的源不发起真实请求，直接按超时处理，用于现场一键演示降级。
    """
    fails = {v.strip() for v in debug_fail.split(",") if v.strip()}
    fail_odata = "odata" in fails or "all" in fails
    fail_stac = "stac" in fails or "all" in fails

    (lon, lat), bbox = centroid_and_bbox(aoi_geojson)
    mgrs = mgrs_tile(lon, lat)
    start, end = task_row["start_date"], task_row["end_date"]
    cloud = task_row["cloud_max_pct"]

    odata_reason = None
    if not fail_odata:
        try:
            scenes = await odata_search(start, end, cloud, mgrs)
            return {
                "source": "odata", "totalScenes": len(scenes),
                "scenes": [_scene_view(s) for s in scenes],
                "degraded": False, "fallbackUsed": False,
            }
        except copernicus_odata.SourceUnavailable as e:
            odata_reason = str(e)
    else:
        odata_reason = "模拟超时（X-Debug-Fail: odata）"

    stac_reason = None
    if not fail_stac:
        try:
            scenes = await stac_search(bbox, start, end, cloud, mgrs)
            return {
                "source": "stac", "totalScenes": len(scenes),
                "scenes": [_scene_view(s) for s in scenes],
                "degraded": True, "fallbackUsed": True, "reason": odata_reason,
            }
        except usgs_stac.SourceUnavailable as e:
            stac_reason = str(e)
    else:
        stac_reason = "模拟超时（X-Debug-Fail: stac）"

    # 双败兜底（契约 §4）：如实标注两源不可达，提供 reason，不做任何静默缓存
    return {
        "source": None, "totalScenes": 0, "scenes": [],
        "degraded": True, "fallbackUsed": True,
        "reason": f"{odata_reason}；{stac_reason}",
    }


@router.post("/{task_id}/estimate")
@assemble_response
async def estimate_task(task_id: str, request: Request,
                        user: dict = Depends(current_user)):
    """影像检索预演：真实调 Copernicus OData，失败降级 USGS STAC，双败兜底。

    approver 只读但 estimate 不改变任何状态（纯预演），故所有角色可调用。
    """
    with db() as conn:
        row = conn.execute(
            "SELECT t.*, a.geojson AS aoi_geojson FROM tasks t"
            " JOIN aois a ON a.id = t.aoi_id"
            " WHERE t.id = ? AND t.tenant_id = ?",
            (task_id, user["tenantId"]),
        ).fetchone()
        if row is None:
            raise ApiHTTPException(
                status_code=404, code=StatusCode.RESOURCE_NOT_FOUND, msg="任务不存在")
        aoi_geojson = json.loads(row["aoi_geojson"])
    return await _estimate(row, aoi_geojson, request.headers.get("X-Debug-Fail", ""))
