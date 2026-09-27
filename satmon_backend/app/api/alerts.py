"""告警端点（契约 §5 / US-10）：列表与处置闭环。

处置（PUT status）允许 approver：契约 §0 的写操作白名单（任务/AOI/成员/
订阅变更）不含告警处置，且 US-11 明确决策审批者「可查看与确认处置状态」。
"""

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.api.common.exceptions import ApiHTTPException
from app.api.common.response import StatusCode, assemble_response
from app.api.deps import current_user
from app.db.sqlite import db

router = APIRouter(prefix="/alerts", tags=["alerts"])

ALERT_STATUSES = ("pending", "confirmed", "field_check", "dismissed")

_STATUS_LABELS = {
    "confirmed": "确认变化", "field_check": "转现场核查", "dismissed": "误报排除",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_audit(conn, tenant_id: str, actor: str, action: str, detail: str) -> None:
    # 与 subscription 模块的 _write_audit 同形；两处各自演进，暂不抽公共模块
    conn.execute(
        "INSERT INTO audit_logs(id, tenant_id, at, actor, action, detail) VALUES (?,?,?,?,?,?)",
        (f"audit-{uuid.uuid4().hex[:12]}", tenant_id, _now(), actor, action, detail),
    )


@router.get("")
@assemble_response
async def list_alerts(user: dict = Depends(current_user)):
    """本租户告警列表（时间倒序）。"""
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM alerts WHERE tenant_id = ? ORDER BY created_at DESC",
            (user["tenantId"],),
        ).fetchall()
    return [{
        "id": r["id"],
        "taskId": r["task_id"],
        "patchId": r["patch_id"],
        "areaKm2": round(r["area_km2"], 4),
        "changeType": r["change_type"],
        "level": r["level"],
        "status": r["status"],
        "createdAt": r["created_at"],
    } for r in rows]


class AlertStatusRequest(BaseModel):
    status: str


@router.put("/{alert_id}/status")
@assemble_response
async def update_alert_status(alert_id: str, request: AlertStatusRequest,
                              user: dict = Depends(current_user)):
    """告警处置闭环：pending → confirmed / field_check / dismissed（写审计）。"""
    if request.status not in ALERT_STATUSES:
        raise ApiHTTPException(
            status_code=400, code=StatusCode.PARAM_INVALID,
            msg="status 必须为 " + "/".join(ALERT_STATUSES))
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM alerts WHERE id = ? AND tenant_id = ?",
            (alert_id, user["tenantId"]),
        ).fetchone()
        if row is None:
            raise ApiHTTPException(
                status_code=404, code=StatusCode.RESOURCE_NOT_FOUND, msg="告警不存在")
        if row["status"] == request.status:
            raise ApiHTTPException(
                status_code=400, code=StatusCode.PARAM_INVALID,
                msg=f"告警已处于 {request.status} 状态，无需重复处置")
        conn.execute(
            "UPDATE alerts SET status = ? WHERE id = ?", (request.status, alert_id))
        _write_audit(conn, user["tenantId"], user["username"], "告警处置",
                     f"{_STATUS_LABELS.get(request.status, request.status)}"
                     f"告警 {alert_id}（{row['change_type']} {row['area_km2']:.2f}km²）")
        row = conn.execute(
            "SELECT * FROM alerts WHERE id = ?", (alert_id,)).fetchone()
    return {
        "id": row["id"],
        "status": row["status"],
        "taskId": row["task_id"],
        "patchId": row["patch_id"],
    }
