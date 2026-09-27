"""AOI 端点（契约 §3）：列表 / 创建 / 更新 / 删除。

租户隔离：查询一律按 token 的 tenantId 过滤；跨租户 AOI ID 返回 404
（code 2001，不泄露存在性，对齐 US-11）。
面积配额：shapely 校验 + 4326 球面面积，超出订阅剩余额度返回 400 并带 usage。
"""

import json
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.api.common.exceptions import ApiHTTPException
from app.api.common.response import StatusCode, assemble_response
from app.api.deps import current_user, require_writer
from app.db.sqlite import db
from app.utils.geo import validate_polygon

router = APIRouter(prefix="/aois", tags=["aoi"])

MONITOR_TYPES = ("illegal_construction", "farmland_non_agri", "urban_expansion", "surface_change")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _aoi_view(r) -> dict:
    return {
        "id": r["id"],
        "name": r["name"],
        "areaKm2": round(r["area_km2"], 4),
        "monitorType": r["monitor_type"],
        "createdAt": r["created_at"],
        "geojson": json.loads(r["geojson"]),
    }


def _get_tenant_aoi(conn, tenant_id: str, aoi_id: str):
    """按租户取 AOI；不存在或跨租户一律 404（不泄露存在性）。"""
    row = conn.execute(
        "SELECT * FROM aois WHERE id = ? AND tenant_id = ?", (aoi_id, tenant_id)
    ).fetchone()
    if row is None:
        raise ApiHTTPException(
            status_code=404, code=StatusCode.RESOURCE_NOT_FOUND, msg="AOI 不存在"
        )
    return row


def _quota_usage(conn, tenant_id: str, exclude_aoi_id: str | None = None) -> dict:
    """当前租户 AOI 用量（exclude_aoi_id 用于更新场景：不把自身旧面积计入已用）。"""
    limit = conn.execute(
        "SELECT p.area_limit_km2 AS l FROM subscriptions s JOIN plans p ON p.id = s.plan_id"
        " WHERE s.tenant_id = ?",
        (tenant_id,),
    ).fetchone()["l"]
    if exclude_aoi_id:
        used = conn.execute(
            "SELECT COALESCE(SUM(area_km2), 0) AS s FROM aois"
            " WHERE tenant_id = ? AND id != ?",
            (tenant_id, exclude_aoi_id),
        ).fetchone()["s"]
    else:
        used = conn.execute(
            "SELECT COALESCE(SUM(area_km2), 0) AS s FROM aois WHERE tenant_id = ?",
            (tenant_id,),
        ).fetchone()["s"]
    return {"usedKm2": round(used, 4), "limitKm2": limit, "remainingKm2": round(limit - used, 4)}


class AoiCreateRequest(BaseModel):
    name: str
    monitorType: str  # noqa: N815 字段名对齐契约 §3
    geojson: dict


@router.get("")
@assemble_response
async def list_aois(user: dict = Depends(current_user)):
    """本租户 AOI 库。"""
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM aois WHERE tenant_id = ? ORDER BY created_at DESC",
            (user["tenantId"],),
        ).fetchall()
    return [_aoi_view(r) for r in rows]


@router.post("")
@assemble_response
async def create_aoi(request: AoiCreateRequest, user: dict = Depends(require_writer)):
    """创建 AOI：几何校验 + 面积配额校验。"""
    if not request.name.strip():
        raise ApiHTTPException(
            status_code=400, code=StatusCode.PARAM_INVALID, msg="AOI 名称不能为空"
        )
    if request.monitorType not in MONITOR_TYPES:
        raise ApiHTTPException(
            status_code=400, code=StatusCode.PARAM_INVALID,
            msg="monitorType 必须为 " + " / ".join(MONITOR_TYPES),
        )
    try:
        _, area_km2 = validate_polygon(request.geojson)
    except ValueError as e:
        raise ApiHTTPException(
            status_code=400, code=StatusCode.PARAM_INVALID, msg=str(e)
        )

    aoi_id = f"aoi-{uuid.uuid4().hex[:10]}"
    with db() as conn:
        usage = _quota_usage(conn, user["tenantId"])
        if area_km2 > usage["remainingKm2"]:
            raise ApiHTTPException(
                status_code=400, code=StatusCode.PARAM_INVALID,
                msg=f"AOI 面积 {area_km2:.2f} km² 超出订阅剩余额度"
                    f" {usage['remainingKm2']:.2f} km²，请缩减范围或升级套餐",
                data={"usage": usage},
            )
        conn.execute(
            "INSERT INTO aois(id, tenant_id, name, monitor_type, area_km2, geojson, created_by,"
            " created_at) VALUES (?,?,?,?,?,?,?,?)",
            (aoi_id, user["tenantId"], request.name.strip(), request.monitorType, area_km2,
             json.dumps(request.geojson), user["id"], _now()),
        )
        row = _get_tenant_aoi(conn, user["tenantId"], aoi_id)
    return _aoi_view(row)


class AoiUpdateRequest(BaseModel):
    name: str | None = None
    monitorType: str | None = None  # noqa: N815 字段名对齐契约 §3
    geojson: dict | None = None


@router.put("/{aoi_id}")
@assemble_response
async def update_aoi(aoi_id: str, request: AoiUpdateRequest,
                     user: dict = Depends(require_writer)):
    """更新 AOI：提供 geojson 时重新走几何 + 配额校验（自身旧面积不计入已用）。"""
    with db() as conn:
        row = _get_tenant_aoi(conn, user["tenantId"], aoi_id)

        name = row["name"] if request.name is None else request.name.strip()
        if not name:
            raise ApiHTTPException(
                status_code=400, code=StatusCode.PARAM_INVALID, msg="AOI 名称不能为空"
            )
        monitor_type = row["monitor_type"] if request.monitorType is None else request.monitorType
        if monitor_type not in MONITOR_TYPES:
            raise ApiHTTPException(
                status_code=400, code=StatusCode.PARAM_INVALID,
                msg="monitorType 必须为 " + " / ".join(MONITOR_TYPES),
            )

        if request.geojson is None:
            area_km2, geojson_text = row["area_km2"], row["geojson"]
        else:
            try:
                _, area_km2 = validate_polygon(request.geojson)
            except ValueError as e:
                raise ApiHTTPException(
                    status_code=400, code=StatusCode.PARAM_INVALID, msg=str(e)
                )
            usage = _quota_usage(conn, user["tenantId"], exclude_aoi_id=aoi_id)
            if area_km2 > usage["remainingKm2"]:
                raise ApiHTTPException(
                    status_code=400, code=StatusCode.PARAM_INVALID,
                    msg=f"AOI 面积 {area_km2:.2f} km² 超出订阅剩余额度"
                        f" {usage['remainingKm2']:.2f} km²，请缩减范围或升级套餐",
                    data={"usage": usage},
                )
            geojson_text = json.dumps(request.geojson)

        conn.execute(
            "UPDATE aois SET name = ?, monitor_type = ?, area_km2 = ?, geojson = ? WHERE id = ?",
            (name, monitor_type, area_km2, geojson_text, aoi_id),
        )
        row = _get_tenant_aoi(conn, user["tenantId"], aoi_id)
    return _aoi_view(row)


@router.delete("/{aoi_id}")
@assemble_response
async def delete_aoi(aoi_id: str, user: dict = Depends(require_writer)):
    """删除 AOI（analyst/tenant_admin 可删，approver 403）。"""
    with db() as conn:
        _get_tenant_aoi(conn, user["tenantId"], aoi_id)
        conn.execute("DELETE FROM aois WHERE id = ? AND tenant_id = ?", (aoi_id, user["tenantId"]))
    return {"id": aoi_id, "deleted": True}
