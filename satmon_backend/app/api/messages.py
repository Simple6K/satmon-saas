"""消息中心端点（契约 §5 / US-06/US-10）：列表与已读标记。

可见范围：发给本人（user_id 命中）+ 租户内广播（user_id 为 NULL）。
"""

from fastapi import APIRouter, Depends

from app.api.common.exceptions import ApiHTTPException
from app.api.common.response import StatusCode, assemble_response
from app.api.deps import current_user
from app.db.sqlite import db

router = APIRouter(prefix="/messages", tags=["messages"])


@router.get("")
@assemble_response
async def list_messages(user: dict = Depends(current_user)):
    """本人可见消息（时间倒序）。"""
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM messages WHERE tenant_id = ? AND (user_id IS NULL OR user_id = ?)"
            " ORDER BY created_at DESC",
            (user["tenantId"], user["id"]),
        ).fetchall()
    return [{
        "id": r["id"],
        "type": r["type"],
        "title": r["title"],
        "body": r["body"],
        "read": bool(r["read"]),
        "createdAt": r["created_at"],
    } for r in rows]


@router.put("/{message_id}/read")
@assemble_response
async def mark_read(message_id: str, user: dict = Depends(current_user)):
    """标记已读（幂等）。"""
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM messages WHERE id = ? AND tenant_id = ?"
            " AND (user_id IS NULL OR user_id = ?)",
            (message_id, user["tenantId"], user["id"]),
        ).fetchone()
        if row is None:
            raise ApiHTTPException(
                status_code=404, code=StatusCode.RESOURCE_NOT_FOUND, msg="消息不存在")
        conn.execute("UPDATE messages SET read = 1 WHERE id = ?", (message_id,))
    return {"id": message_id, "read": True}
