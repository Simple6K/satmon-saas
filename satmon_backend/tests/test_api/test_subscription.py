"""订阅端点测试（契约 §2）。"""


async def _token(client, username: str) -> str:
    resp = await client.post("/api/auth/login", json={"username": username})
    return resp.json()["data"]["token"]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def test_plans_three_tiers(client):
    """三档套餐：basic/pro/flagship，含 seats 与 maxConcurrentTasks。"""
    resp = await client.get("/api/plans")
    assert resp.status_code == 200
    plans = resp.json()["data"]
    assert [p["id"] for p in plans] == ["basic", "pro", "flagship"]
    by_id = {p["id"]: p for p in plans}
    assert by_id["basic"]["areaLimitKm2"] == 500
    assert by_id["pro"]["areaLimitKm2"] == 2500
    assert by_id["flagship"]["areaLimitKm2"] == 10000
    assert by_id["flagship"]["monitorTypeCount"] == 4
    assert all("seats" in p and "maxConcurrentTasks" in p for p in plans)


async def test_subscription_usage(client):
    """租户 A 订阅 pro，usage 与种子数据一致：2 个 AOI、2 个运行中任务。"""
    token = await _token(client, "ahmed")
    resp = await client.get("/api/subscription", headers=_auth(token))
    assert resp.status_code == 200
    sub = resp.json()["data"]
    assert sub["planId"] == "pro"
    assert sub["status"] == "active"
    usage = sub["usage"]
    assert usage["aoiAreaLimitKm2"] == 2500
    assert usage["aoiAreaKm2"] > 0
    assert usage["concurrentTasks"] == 2  # retrieving + queued
    assert usage["concurrentLimit"] == 4
    assert usage["activeTaskCount"] == 3


async def test_change_plan_and_audit(client):
    """管理员变更套餐：立即生效并写审计日志。"""
    token = await _token(client, "khalid")
    resp = await client.put("/api/subscription/plan", json={"planId": "flagship"},
                            headers=_auth(token))
    assert resp.status_code == 200
    assert resp.json()["data"]["planId"] == "flagship"
    assert resp.json()["data"]["usage"]["aoiAreaLimitKm2"] == 10000

    logs = (await client.get("/api/audit-logs", headers=_auth(token))).json()["data"]
    assert logs[0]["action"] == "订阅变更"
    assert "flagship" in logs[0]["detail"]

    # 改回 pro，保证幂等可重复运行（本测试库为临时库，此处仅验证二次变更）
    resp = await client.put("/api/subscription/plan", json={"planId": "pro"},
                            headers=_auth(token))
    assert resp.json()["data"]["planId"] == "pro"


async def test_change_plan_unknown_404(client):
    token = await _token(client, "khalid")
    resp = await client.put("/api/subscription/plan", json={"planId": "platinum"},
                            headers=_auth(token))
    assert resp.status_code == 404
    assert resp.json()["code"] == 2001


async def test_change_plan_approver_403(client):
    """approver 只读：变更套餐被拒（403 + code 2003）。"""
    token = await _token(client, "fatima")
    resp = await client.put("/api/subscription/plan", json={"planId": "flagship"},
                            headers=_auth(token))
    assert resp.status_code == 403
    body = resp.json()
    assert body["code"] == 2003


async def test_create_member_requires_tenant_admin(client):
    """analyst 邀请成员被拒（403 code 2003）；tenant_admin 成功。"""
    analyst_token = await _token(client, "ahmed")
    resp = await client.post("/api/subscription/members",
                             json={"name": "New Member", "role": "approver"},
                             headers=_auth(analyst_token))
    assert resp.status_code == 403
    assert resp.json()["code"] == 2003

    admin_token = await _token(client, "khalid")
    resp = await client.post("/api/subscription/members",
                             json={"name": "New Member", "role": "approver"},
                             headers=_auth(admin_token))
    assert resp.status_code == 200
    member = resp.json()["data"]
    assert member["role"] == "approver"
    assert member["joinedAt"]

    # 新成员出现在成员列表，且可登录
    members = (await client.get("/api/subscription/members",
                                headers=_auth(admin_token))).json()["data"]
    assert any(m["id"] == member["id"] for m in members)
    login = await client.post("/api/auth/login", json={"username": "new_member"})
    assert login.status_code == 200


async def test_create_member_invalid_role_400(client):
    token = await _token(client, "khalid")
    resp = await client.post("/api/subscription/members",
                             json={"name": "X", "role": "superuser"},
                             headers=_auth(token))
    assert resp.status_code == 400
    assert resp.json()["code"] == 1003


async def test_audit_logs_limit(client):
    token = await _token(client, "khalid")
    resp = await client.get("/api/audit-logs?limit=2", headers=_auth(token))
    assert resp.status_code == 200
    assert len(resp.json()["data"]) == 2
