"""告警处置闭环与消息中心测试（契约 §5 / US-10）。"""


async def _token(client, username: str) -> str:
    resp = await client.post("/api/auth/login", json={"username": username})
    return resp.json()["data"]["token"]


async def test_alerts_list_tenant_scoped(client):
    token_a = await _token(client, "ahmed")
    alerts = (await client.get("/api/alerts",
                               headers={"Authorization": f"Bearer {token_a}"})).json()["data"]
    assert {a["id"] for a in alerts} == {"alert-a-1", "alert-a-2"}
    # 告警关联的种子斑块可点通（告警 → 举证链路）
    assert all(a["patchId"].startswith("patch-a-") for a in alerts)

    token_b = await _token(client, "sameer")
    alerts_b = (await client.get("/api/alerts",
                                 headers={"Authorization": f"Bearer {token_b}"})).json()["data"]
    assert [a["id"] for a in alerts_b] == ["alert-b-1"]


async def test_alert_status_closure_loop(client):
    """处置闭环：pending→confirmed→field_check（含审计）；非法状态/重复处置 400。"""
    token = await _token(client, "fatima")  # approver 可确认处置状态（US-11）

    resp = await client.put("/api/alerts/alert-a-1/status",
                            headers={"Authorization": f"Bearer {token}"},
                            json={"status": "confirmed"})
    assert resp.status_code == 200
    assert resp.json()["data"]["status"] == "confirmed"

    # 重复置同状态 → 400
    resp = await client.put("/api/alerts/alert-a-1/status",
                            headers={"Authorization": f"Bearer {token}"},
                            json={"status": "confirmed"})
    assert resp.status_code == 400

    # 再流转到现场核查
    resp = await client.put("/api/alerts/alert-a-1/status",
                            headers={"Authorization": f"Bearer {token}"},
                            json={"status": "field_check"})
    assert resp.status_code == 200

    # 非法状态
    resp = await client.put("/api/alerts/alert-a-2/status",
                            headers={"Authorization": f"Bearer {token}"},
                            json={"status": "closed"})
    assert resp.status_code == 400

    # 审计已记录两次处置
    admin_token = await _token(client, "khalid")
    audits = (await client.get("/api/audit-logs",
                               headers={"Authorization": f"Bearer {admin_token}"})).json()["data"]
    closure = [a for a in audits if a["action"] == "告警处置" and "alert-a-1" in a["detail"]]
    assert len(closure) == 2
    assert closure[0]["actor"] == "fatima"


async def test_alert_cross_tenant_404(client):
    token = await _token(client, "sameer")
    resp = await client.put("/api/alerts/alert-a-1/status",
                            headers={"Authorization": f"Bearer {token}"},
                            json={"status": "confirmed"})
    assert resp.status_code == 404
    assert resp.json()["code"] == 2001


async def test_messages_visibility_and_read(client):
    """消息可见范围 = 本人 + 租户广播；已读标记幂等。"""
    token = await _token(client, "ahmed")
    msgs = (await client.get("/api/messages",
                             headers={"Authorization": f"Bearer {token}"})).json()["data"]
    ids = {m["id"] for m in msgs}
    assert {"msg-a-1", "msg-a-2", "msg-a-4"} <= ids    # 本人消息 + 租户广播
    assert "msg-a-3" not in ids                        # 他人私信不可见
    assert "msg-a-5" not in ids                        # 发给 khalid 的私信不可见
    assert "msg-b-1" not in ids                        # 跨租户不可见

    unread = next(m for m in msgs if not m["read"])
    resp = await client.put(f"/api/messages/{unread['id']}/read",
                            headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert resp.json()["data"]["read"] is True
    # 幂等
    assert (await client.put(f"/api/messages/{unread['id']}/read",
                             headers={"Authorization": f"Bearer {token}"})).status_code == 200
    # 跨租户消息 → 404
    token_b = await _token(client, "nora")
    assert (await client.put(f"/api/messages/{unread['id']}/read",
                             headers={"Authorization": f"Bearer {token_b}"})).status_code == 404
