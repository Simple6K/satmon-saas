"""认证端点（契约 §1）：POST /api/auth/login、GET /api/me。"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.api.common.exceptions import ApiHTTPException
from app.api.common.response import StatusCode, assemble_response
from app.api.deps import current_user, make_token
from app.db.sqlite import db

router = APIRouter(tags=["auth"])


class LoginRequest(BaseModel):
    username: str


def _user_view(user: dict) -> dict:
    return {
        "id": user["id"],
        "name": user["name"],
        "role": user["role"],
        "tenantId": user["tenantId"],
        "tenantName": user["tenantName"],
    }


@router.post("/auth/login")
@assemble_response
async def login(request: LoginRequest):
    """MVP 免密登录：用户名须在种子表内，否则 401。"""
    with db() as conn:
        rows = conn.execute(
            "SELECT u.id, u.tenant_id, u.username, u.name, u.role, t.name AS tenant_name"
            " FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.username = ?",
            (request.username.strip(),),
        ).fetchall()
    if not rows:
        raise ApiHTTPException(
            status_code=401, code=StatusCode.AUTH_REQUIRED, msg="用户名不存在或未在本组织内"
        )
    r = rows[0]
    token = make_token(r["tenant_id"], r["id"], r["role"], r["username"])
    return {
        "token": token,
        "user": {
            "id": r["id"], "name": r["name"], "role": r["role"],
            "tenantId": r["tenant_id"], "tenantName": r["tenant_name"],
        },
    }


@router.get("/me")
@assemble_response
async def me(user: dict = Depends(current_user)):
    """当前登录用户信息（与 login 返回的 user 同构）。"""
    return _user_view(user)
