"""认证端点测试（契约 §1）。"""


async def _login(client, username: str):
    return await client.post("/api/auth/login", json={"username": username})


async def test_login_success(client):
    """种子用户 ahmed 免密登录成功，返回 token 与完整 user 结构。"""
    resp = await _login(client, "ahmed")
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == 0
    assert body["data"]["token"]
    user = body["data"]["user"]
    assert user["id"] == "user-ahmed"
    assert user["role"] == "analyst"
    assert user["tenantId"] == "dubai_municipality"
    assert user["tenantName"] == "迪拜市政厅·规划监察"


async def test_login_unknown_user_401(client):
    """不在种子表内的用户名返回 401 + 信封错误码 1004。"""
    resp = await _login(client, "no_such_user")
    assert resp.status_code == 401
    body = resp.json()
    assert body["code"] == 1004
    assert body["data"] is None


async def test_me_with_token(client):
    """携带合法 token 获取当前用户。"""
    token = (await _login(client, "khalid")).json()["data"]["token"]
    resp = await client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    user = resp.json()["data"]
    assert user["id"] == "user-khalid"
    assert user["role"] == "tenant_admin"


async def test_me_without_token_401(client):
    """缺 token 访问 /api/me 返回 401。"""
    resp = await client.get("/api/me")
    assert resp.status_code == 401
    assert resp.json()["code"] == 1004


async def test_me_with_garbage_token_401(client):
    """伪造 token 返回 401。"""
    resp = await client.get("/api/me", headers={"Authorization": "Bearer not-a-token"})
    assert resp.status_code == 401


async def test_me_with_deleted_user_token_401(client):
    """用户被移除后旧 token 立即失效（对齐 US-02 验收）。"""
    token = (await _login(client, "fatima")).json()["data"]["token"]
    from app.db.sqlite import db
    with db() as conn:
        conn.execute("DELETE FROM users WHERE username = 'fatima'")
    resp = await client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 401
