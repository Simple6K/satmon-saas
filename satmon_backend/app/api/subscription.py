"""订阅端点（契约 §2）：套餐、当前订阅与用量、套餐变更、成员管理、审计日志。"""

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.api.common.exceptions import ApiHTTPException
from app.api.common.response import StatusCode, assemble_response
from app.api.deps import current_user, require_tenant_admin, require_writer
from app.db.sqlite import db

router = APIRouter(tags=["subscription"])

# 非终态：占并发配额；completed 计入 activeTaskCount 但不占并发
_RUNNING = ("queued", "retrieving", "analyzing")
_ACTIVE = _RUNNING + ("completed",)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _usage_view(conn, tenant_id: str) -> dict:
    """租户用量视图：AOI 总面积 / 并发任务 / 活跃任务数。"""
    plan = conn.execute(
        "SELECT p.* FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = ?",
        (tenant_id,),
    ).fetchone()
    if plan is None:
        return {}
    aoi_area = conn.execute(
        "SELECT COALESCE(SUM(area_km2), 0) AS s FROM aois WHERE tenant_id = ?", (tenant_id,)
    ).fetchone()["s"]
    running = conn.execute(
        "SELECT COUNT(*) AS c FROM tasks WHERE tenant_id = ? AND status IN (?,?,?)",
        (tenant_id, *_RUNNING),
    ).fetchone()["c"]
    active = conn.execute(
        "SELECT COUNT(*) AS c FROM tasks WHERE tenant_id = ? AND status IN (?,?,?,?)",
        (tenant_id, *_ACTIVE),
    ).fetchone()["c"]
    return {
        "aoiAreaKm2": round(aoi_area, 4),
        "aoiAreaLimitKm2": plan["area_limit_km2"],
        "concurrentTasks": running,
        "concurrentLimit": plan["max_concurrent_tasks"],
        "activeTaskCount": active,
    }


def _write_audit(conn, tenant_id: str, actor: str, action: str, detail: str) -> None:
    conn.execute(
        "INSERT INTO audit_logs(id, tenant_id, at, actor, action, detail) VALUES (?,?,?,?,?,?)",
        (f"audit-{uuid.uuid4().hex[:12]}", tenant_id, _now(), actor, action, detail),
    )


def _plan_view(p) -> dict:
    return {
        "id": p["id"],
        "name": p["name"],
        "areaLimitKm2": p["area_limit_km2"],
        "monitorTypeCount": p["monitor_type_count"],
        "monitorTypes": p["monitor_types"],
        "revisit": p["revisit"],
        "seats": p["seats"],
        "maxConcurrentTasks": p["max_concurrent_tasks"],
        "dataSourceNote": p["data_source_note"],
    }


@router.get("/plans")
@assemble_response
async def list_plans():
    """三档套餐目录（登录即可见，各租户共享同一价目表）。"""
    with db() as conn:
        rows = conn.execute("SELECT * FROM plans ORDER BY area_limit_km2").fetchall()
    return [_plan_view(p) for p in rows]


@router.get("/subscription")
@assemble_response
async def get_subscription(user: dict = Depends(current_user)):
    """当前租户订阅与实时用量。"""
    with db() as conn:
        sub = conn.execute(
            "SELECT s.*, p.name AS plan_name FROM subscriptions s"
            " JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = ?",
            (user["tenantId"],),
        ).fetchone()
        usage = _usage_view(conn, user["tenantId"])
    return {
        "planId": sub["plan_id"],
        "planName": sub["plan_name"],
        "status": sub["status"],
        "startedAt": sub["started_at"],
        "renewalAt": sub["renewal_at"],
        "usage": usage,
    }


class PlanChangeRequest(BaseModel):
    planId: str  # noqa: N815 字段名对齐契约 §2


@router.put("/subscription/plan")
@assemble_response
async def change_plan(request: PlanChangeRequest, user: dict = Depends(require_writer)):
    """变更套餐：配额立即按新套餐刷新，已有任务不受影响；写审计日志。"""
    with db() as conn:
        plan = conn.execute("SELECT * FROM plans WHERE id = ?", (request.planId,)).fetchone()
        if plan is None:
            raise ApiHTTPException(
                status_code=404, code=StatusCode.RESOURCE_NOT_FOUND, msg="套餐不存在"
            )
        old = conn.execute(
            "SELECT plan_id FROM subscriptions WHERE tenant_id = ?", (user["tenantId"],)
        ).fetchone()["plan_id"]
        conn.execute(
            "UPDATE subscriptions SET plan_id = ? WHERE tenant_id = ?",
            (request.planId, user["tenantId"]),
        )
        _write_audit(conn, user["tenantId"], user["username"], "订阅变更",
                     f"套餐由 {old} 变更为 {request.planId}")
        sub = conn.execute(
            "SELECT s.*, p.name AS plan_name FROM subscriptions s"
            " JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = ?",
            (user["tenantId"],),
        ).fetchone()
        usage = _usage_view(conn, user["tenantId"])
    return {
        "planId": sub["plan_id"],
        "planName": sub["plan_name"],
        "status": sub["status"],
        "startedAt": sub["started_at"],
        "renewalAt": sub["renewal_at"],
        "usage": usage,
    }


@router.get("/subscription/members")
@assemble_response
async def list_members(user: dict = Depends(current_user)):
    """本租户成员列表（仅本租户可见）。"""
    with db() as conn:
        rows = conn.execute(
            "SELECT id, name, role, joined_at FROM users WHERE tenant_id = ? ORDER BY joined_at",
            (user["tenantId"],),
        ).fetchall()
    return [
        {"id": r["id"], "name": r["name"], "role": r["role"], "joinedAt": r["joined_at"]}
        for r in rows
    ]


class MemberCreateRequest(BaseModel):
    name: str
    role: str


@router.post("/subscription/members")
@assemble_response
async def create_member(request: MemberCreateRequest, user: dict = Depends(require_tenant_admin)):
    """邀请新成员（tenant_admin 专属）；写审计。"""
    if request.role not in ("tenant_admin", "analyst", "approver"):
        raise ApiHTTPException(
            status_code=400, code=StatusCode.PARAM_INVALID,
            msg="role 必须为 tenant_admin / analyst / approver 之一",
        )
    username = request.name.strip().lower().replace(" ", "_")
    if not username:
        raise ApiHTTPException(
            status_code=400, code=StatusCode.PARAM_INVALID, msg="成员姓名不能为空"
        )
    user_id = f"user-{uuid.uuid4().hex[:10]}"
    with db() as conn:
        exists = conn.execute(
            "SELECT 1 FROM users WHERE username = ?", (username,)
        ).fetchone()
        if exists:
            raise ApiHTTPException(
                status_code=400, code=StatusCode.PARAM_INVALID,
                msg=f"用户名 {username} 已存在（登录用户名按姓名生成，请换名重试）",
            )
        conn.execute(
            "INSERT INTO users(id, tenant_id, username, name, role, joined_at)"
            " VALUES (?,?,?,?,?,?)",
            (user_id, user["tenantId"], username, request.name.strip(), request.role, _now()),
        )
        _write_audit(conn, user["tenantId"], user["username"], "成员邀请",
                     f"邀请 {request.name}（{request.role}）加入组织，登录用户名 {username}")
    return {"id": user_id, "name": request.name.strip(), "role": request.role,
            "joinedAt": _now()}


@router.get("/audit-logs")
@assemble_response
async def list_audit_logs(limit: int = Query(50, ge=1, le=200),
                          user: dict = Depends(require_tenant_admin)):
    """本租户审计日志（按时间倒序）。PRD US-12：审计日志仅租户管理员可见。"""
    with db() as conn:
        rows = conn.execute(
            "SELECT at, actor, action, detail FROM audit_logs WHERE tenant_id = ?"
            " ORDER BY at DESC LIMIT ?",
            (user["tenantId"], limit),
        ).fetchall()
    return [
        {"at": r["at"], "actor": r["actor"], "action": r["action"], "detail": r["detail"]}
        for r in rows
    ]
