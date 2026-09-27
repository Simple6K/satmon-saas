"""租户隔离测试（契约 §0 / US-11）：跨租户资源 ID 返回 404 code 2001。"""


async def _token(client, username: str) -> str:
    resp = await client.post("/api/auth/login", json={"username": username})
    return resp.json()["data"]["token"]


async def test_aoi_list_tenant_scoped(client):
    """租户 B 只能看到自己的 1 个 AOI。"""
    token = await _token(client, "sameer")
    resp = await client.get("/api/aois", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    aois = resp.json()["data"]
    assert len(aois) == 1
    assert aois[0]["id"] == "aoi-b-1"


async def test_cross_tenant_aoi_404(client):
    """租户 B 用户直接访问租户 A 的 AOI ID：404 + code 2001（不泄露存在性）。"""
    token = await _token(client, "sameer")
    # 契约 §3 仅定义 PUT/DELETE 单资源端点（GET 列表已按租户过滤）
    for method, kwargs in [
        ("PUT", {"json": {"name": "越权改名"}}),
        ("DELETE", {}),
    ]:
        resp = await getattr(client, method.lower())(
            "/api/aois/aoi-a-1", headers={"Authorization": f"Bearer {token}"}, **kwargs
        )
        assert resp.status_code == 404, method
        assert resp.json()["code"] == 2001


async def test_members_tenant_scoped(client):
    """成员列表只含本租户成员。"""
    token = await _token(client, "nora")
    resp = await client.get("/api/subscription/members",
                            headers={"Authorization": f"Bearer {token}"})
    names = {m["id"] for m in resp.json()["data"]}
    assert names == {"user-sameer", "user-nora"}


async def test_audit_logs_tenant_scoped(client):
    """审计日志只含本租户记录。"""
    token = await _token(client, "nora")
    resp = await client.get("/api/audit-logs", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    # 租户 B 种子未灌审计日志；即便租户 A 有 6 条，这里也应为空
    assert resp.json()["data"] == []


async def test_new_member_only_sees_own_tenant(client):
    """新邀请成员登录后仅见本租户数据（US-02 验收）。"""
    admin_token = await _token(client, "khalid")
    resp = await client.post(
        "/api/subscription/members",
        json={"name": "Test Analyst", "role": "analyst"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert resp.status_code == 200
    username = "test_analyst"
    login = await client.post("/api/auth/login", json={"username": username})
    assert login.status_code == 200
    token = login.json()["data"]["token"]
    aois = (await client.get("/api/aois", headers={"Authorization": f"Bearer {token}"})).json()["data"]
    assert {a["id"] for a in aois} == {"aoi-a-1", "aoi-a-2"}
