"""任务端点与状态机测试（契约 §4）：创建/配额/取消/scheduler 推进/完成产物。"""

from app.service.task_engine import advance_tasks


async def _token(client, username: str) -> str:
    resp = await client.post("/api/auth/login", json={"username": username})
    return resp.json()["data"]["token"]


async def _auth(client, username: str) -> dict:
    return {"Authorization": f"Bearer {await _token(client, username)}"}


async def test_create_task_queued(client):
    """创建成功：状态 queued、stage.current=queued、写审计。"""
    headers = await _auth(client, "ahmed")
    resp = await client.post("/api/tasks", headers=headers, json={
        "name": "海岸带复核任务", "aoiId": "aoi-a-1", "monitorType": "urban_expansion",
        "startDate": "2026-01-01", "endDate": "2026-09-01", "cloudMaxPct": 20,
    })
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["status"] == "queued"
    assert data["stage"]["current"] == "queued"
    assert data["aoi"]["name"] == "迪拜海岸带"

    audits = (await client.get("/api/audit-logs", headers=headers)).json()["data"]
    assert any(a["action"] == "任务创建" and "海岸带复核任务" in a["detail"] for a in audits)


async def test_create_task_validations(client):
    headers = await _auth(client, "ahmed")
    base = {"name": "x", "aoiId": "aoi-a-1", "monitorType": "urban_expansion",
            "startDate": "2026-01-01", "endDate": "2026-09-01", "cloudMaxPct": 20}
    # 跨租户 AOI
    bad = dict(base, aoiId="aoi-b-1")
    assert (await client.post("/api/tasks", headers=headers, json=bad)).status_code == 404
    # 非法枚举 / 时间窗 / 云量
    assert (await client.post(
        "/api/tasks", headers=headers, json=dict(base, monitorType="bad"))).status_code == 400
    assert (await client.post(
        "/api/tasks", headers=headers,
        json=dict(base, startDate="2026-09-01", endDate="2026-01-01"))).status_code == 400
    assert (await client.post(
        "/api/tasks", headers=headers, json=dict(base, cloudMaxPct=120))).status_code == 400
    # approver 只读
    ro = await _auth(client, "fatima")
    assert (await client.post("/api/tasks", headers=ro, json=base)).status_code == 403


async def test_create_task_concurrent_quota(client):
    """pro 套餐并发上限 4：已有 2 个运行中，再建 2 个后第 3 个 400 且带 usage。"""
    headers = await _auth(client, "ahmed")
    for i in range(2):
        resp = await client.post("/api/tasks", headers=headers, json={
            "name": f"配额测试 {i}", "aoiId": "aoi-a-1", "monitorType": "surface_change",
            "startDate": "2026-01-01", "endDate": "2026-09-01", "cloudMaxPct": 30,
        })
        assert resp.status_code == 200
    resp = await client.post("/api/tasks", headers=headers, json={
        "name": "超限", "aoiId": "aoi-a-2", "monitorType": "illegal_construction",
        "startDate": "2026-01-01", "endDate": "2026-09-01", "cloudMaxPct": 20,
    })
    assert resp.status_code == 400
    body = resp.json()
    assert body["code"] == 1003
    usage = body["data"]["usage"]
    assert usage["concurrentTasks"] == 4
    assert usage["concurrentLimit"] == 4


async def test_task_list_and_filter(client):
    headers = await _auth(client, "ahmed")
    resp = await client.get("/api/tasks", headers=headers)
    tasks = resp.json()["data"]
    assert {t["id"] for t in tasks} == {"task-a-1", "task-a-2", "task-a-3"}
    assert all(t["aoiName"] for t in tasks)
    resp = await client.get("/api/tasks", headers=headers, params={"status": "completed"})
    assert [t["id"] for t in resp.json()["data"]] == ["task-a-1"]
    # 无效状态过滤
    assert (await client.get(
        "/api/tasks", headers=headers, params={"status": "running"})).status_code == 400
    # 租户 B 只见自己的任务
    hb = await _auth(client, "sameer")
    tb = (await client.get("/api/tasks", headers=hb)).json()["data"]
    assert [t["id"] for t in tb] == ["task-b-1"]


async def test_cancel_rules(client):
    headers = await _auth(client, "ahmed")
    # completed 任务不可取消
    resp = await client.post("/api/tasks/task-a-1/cancel", headers=headers)
    assert resp.status_code == 400
    # queued 可取消
    resp = await client.post("/api/tasks/task-a-3/cancel", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["data"]["status"] == "cancelled"
    # 取消后释放并发额度：原 queued 1 个已移出运行态
    sub = (await client.get("/api/subscription", headers=headers)).json()["data"]
    assert sub["usage"]["concurrentTasks"] == 1  # 仅剩 task-a-2(retrieving)


async def test_state_machine_advances_to_completed(client):
    """状态机：每 tick 一步 queued→retrieving→analyzing→completed，产物齐全。"""
    headers = await _auth(client, "ahmed")
    task_id = (await client.post("/api/tasks", headers=headers, json={
        "name": "状态机全流程", "aoiId": "aoi-a-1", "monitorType": "urban_expansion",
        "startDate": "2026-01-01", "endDate": "2026-09-01", "cloudMaxPct": 20,
    })).json()["data"]["id"]

    advance_tasks()  # queued → retrieving
    detail = (await client.get(f"/api/tasks/{task_id}", headers=headers)).json()["data"]
    assert detail["status"] == "retrieving"
    assert detail["stage"]["current"] == "retrieving"
    assert detail["scenesSummary"]["count"] == 14  # 迪拜景 fixtures
    assert detail["scenesSummary"]["sources"] == ["odata"]
    assert detail["scenesSummary"]["latestSensingDate"] == "2026-09-22"

    advance_tasks()  # retrieving → analyzing
    detail = (await client.get(f"/api/tasks/{task_id}", headers=headers)).json()["data"]
    assert detail["status"] == "analyzing"
    assert detail["stage"]["retrievalMs"] > 0

    advance_tasks()  # analyzing → completed：斑块/告警/消息齐活
    detail = (await client.get(f"/api/tasks/{task_id}", headers=headers)).json()["data"]
    assert detail["status"] == "completed"
    assert detail["stage"]["analysisMs"] > 0

    results = (await client.get(f"/api/tasks/{task_id}/results",
                                headers=headers)).json()["data"]
    assert results["stats"]["patchCount"] == 8  # 迪拜斑块 fixtures
    alerts = (await client.get("/api/alerts", headers=headers)).json()["data"]
    assert any(a["taskId"] == task_id and a["status"] == "pending" for a in alerts)
    messages = (await client.get("/api/messages", headers=headers)).json()["data"]
    assert any("任务完成" in m["title"] and task_id in m["body"] for m in messages)

    advance_tasks()  # 终态后不再迁移
    detail = (await client.get(f"/api/tasks/{task_id}", headers=headers)).json()["data"]
    assert detail["status"] == "completed"


async def test_cancelled_task_not_resurrected(client):
    """取消后状态机不再推进（以库内状态为准）。"""
    headers = await _auth(client, "ahmed")
    await client.post("/api/tasks/task-a-3/cancel", headers=headers)
    advance_tasks()
    detail = (await client.get("/api/tasks/task-a-3", headers=headers)).json()["data"]
    assert detail["status"] == "cancelled"
