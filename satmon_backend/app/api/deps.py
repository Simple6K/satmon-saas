"""认证与权限依赖注入（契约 §0/§1）。

MVP mock token：base64(json{tenantId, userId, role, username})，无过期。
每次请求按 token 中的 userId 回查用户表——用户被移除后旧 token 立即失效
（对齐 US-02 验收「停用成员旧会话下一次请求失效」）。
"""

import base64
import binascii
import json

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.api.common.exceptions import ApiHTTPException
from app.api.common.response import StatusCode
from app.db.sqlite import db

_bearer = HTTPBearer(auto_error=False)

# 可写角色：契约 §0——写操作要求 analyst 或 tenant_admin，approver 只读
WRITER_ROLES = {"analyst", "tenant_admin"}


def _unauthorized() -> ApiHTTPException:
    return ApiHTTPException(
        status_code=401, code=StatusCode.AUTH_REQUIRED, msg="未认证或认证已失效"
    )


def _forbidden() -> ApiHTTPException:
    return ApiHTTPException(
        status_code=403, code=StatusCode.PERMISSION_DENIED,
        msg="当前角色为只读（approver），无权执行该操作",
    )


def make_token(tenant_id: str, user_id: str, role: str, username: str) -> str:
    payload = json.dumps(
        {"tenantId": tenant_id, "userId": user_id, "role": role, "username": username},
        ensure_ascii=False,
    )
    return base64.b64encode(payload.encode("utf-8")).decode("ascii")


def current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict:
    """解析 Bearer token 并回查用户，返回用户上下文 dict。"""
    if credentials is None:
        raise _unauthorized()
    try:
        payload = json.loads(base64.b64decode(credentials.credentials.encode("ascii")))
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise _unauthorized()

    user_id = payload.get("userId")
    if not user_id:
        raise _unauthorized()
    with db() as conn:
        rows = conn.execute(
            "SELECT u.id, u.tenant_id, u.username, u.name, u.role, t.name AS tenant_name"
            " FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = ?",
            (user_id,),
        ).fetchall()
    if not rows:
        # 用户已不存在（被移除/停用）：旧 token 失效
        raise _unauthorized()
    r = rows[0]
    return {
        "id": r["id"],
        "tenantId": r["tenant_id"],
        "username": r["username"],
        "name": r["name"],
        "role": r["role"],
        "tenantName": r["tenant_name"],
    }


def require_writer(user: dict = Depends(current_user)) -> dict:
    """写操作角色门槛：analyst / tenant_admin；approver 返回 403（code 2003）。"""
    if user["role"] not in WRITER_ROLES:
        raise _forbidden()
    return user


def require_tenant_admin(user: dict = Depends(current_user)) -> dict:
    """租户管理员专属操作门槛（如邀请成员）。"""
    if user["role"] != "tenant_admin":
        raise ApiHTTPException(
            status_code=403, code=StatusCode.PERMISSION_DENIED,
            msg="该操作仅租户管理员（tenant_admin）可执行",
        )
    return user
