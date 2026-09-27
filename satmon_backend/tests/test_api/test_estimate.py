"""estimate 降级链测试（契约 §4 / PRD 5.2）：主源成功 / 主源失败降级 / 双败兜底 / 模拟超时。

适配器真实 HTTP 行为已在 test_adapters.py 用 MockTransport 覆盖；
本文件 monkeypatch 适配器函数以精确控制成功/失败分支，验证降级链编排。
"""

from app.adapters import Scene, SourceUnavailable

_DUBAI_SCENES = [Scene("p-1", "2026-09-22", 3.4, "42RVR"),
                 Scene("p-2", "2026-09-17", 8.1, "42RVR")]
_STAC_SCENES = [Scene("LC08-1", "2026-09-10", 5.2, "42RVR")]


async def _token(client, username: str) -> str:
    resp = await client.post("/api/auth/login", json={"username": username})
    return resp.json()["data"]["token"]


async def _estimate(client, token: str, task_id: str, debug_fail: str = "") -> dict:
    headers = {"Authorization": f"Bearer {token}"}
    if debug_fail:
        headers["X-Debug-Fail"] = debug_fail
    resp = await client.post(f"/api/tasks/{task_id}/estimate", headers=headers)
    assert resp.status_code == 200
    return resp.json()["data"]


async def test_estimate_odata_success(monkeypatch, client):
    """主源成功：source=odata、degraded=false、scenes 结构完整。"""
    async def fake_odata(start, end, cloud, mgrs):
        assert mgrs == "42RVR"  # 迪拜 AOI 质心 → MGRS 42RVR
        assert cloud == 20
        return _DUBAI_SCENES

    monkeypatch.setattr("app.api.tasks.odata_search", fake_odata)
    token = await _token(client, "ahmed")
    data = await _estimate(client, token, "task-a-1")
    assert data["source"] == "odata"
    assert data["totalScenes"] == 2
    assert data["degraded"] is False
    assert data["fallbackUsed"] is False
    assert data["scenes"][0] == {"id": "p-1", "sensingDate": "2026-09-22",
                                 "cloudPct": 3.4, "tileId": "42RVR"}


async def test_estimate_fallback_to_stac(monkeypatch, client):
    """OData 超时/失败 → 降级 STAC：source=stac、degraded=true、fallbackUsed=true。"""
    async def failing_odata(start, end, cloud, mgrs):
        raise SourceUnavailable("OData 目录不可达（ConnectTimeout）")

    async def fake_stac(bbox, start, end, cloud, mgrs):
        assert bbox[0] < 55.3 < bbox[2] + 1  # 迪拜 AOI 外接矩形
        return _STAC_SCENES

    monkeypatch.setattr("app.api.tasks.odata_search", failing_odata)
    monkeypatch.setattr("app.api.tasks.stac_search", fake_stac)
    token = await _token(client, "ahmed")
    data = await _estimate(client, token, "task-a-1")
    assert data["source"] == "stac"
    assert data["fallbackUsed"] is True
    assert data["degraded"] is True
    assert "OData" in data["reason"]
    assert data["scenes"][0]["id"] == "LC08-1"


async def test_estimate_double_fail_returns_fallback_used(monkeypatch, client):
    """双败兜底（mock httpx 双败）：source=null、fallbackUsed=true、reason 如实标注。"""
    async def failing_odata(start, end, cloud, mgrs):
        raise SourceUnavailable("OData 目录不可达（ReadTimeout）")

    async def failing_stac(bbox, start, end, cloud, mgrs):
        raise SourceUnavailable("USGS STAC 不可达（ConnectError）")

    monkeypatch.setattr("app.api.tasks.odata_search", failing_odata)
    monkeypatch.setattr("app.api.tasks.stac_search", failing_stac)
    token = await _token(client, "ahmed")
    data = await _estimate(client, token, "task-a-1")
    assert data["source"] is None
    assert data["fallbackUsed"] is True
    assert data["totalScenes"] == 0
    assert data["scenes"] == []
    assert "OData" in data["reason"] and "STAC" in data["reason"]


async def test_estimate_debug_fail_header_simulates_odata_timeout(monkeypatch, client):
    """X-Debug-Fail: odata → 主源按超时处理，直接走 STAC（现场一键降级演示）。"""
    calls = {"odata": 0, "stac": 0}

    async def spy_odata(start, end, cloud, mgrs):
        calls["odata"] += 1
        return _DUBAI_SCENES

    async def fake_stac(bbox, start, end, cloud, mgrs):
        calls["stac"] += 1
        return _STAC_SCENES

    monkeypatch.setattr("app.api.tasks.odata_search", spy_odata)
    monkeypatch.setattr("app.api.tasks.stac_search", fake_stac)
    token = await _token(client, "ahmed")
    data = await _estimate(client, token, "task-a-1", debug_fail="odata")
    assert calls["odata"] == 0          # 模拟超时：真实请求不应发出
    assert calls["stac"] == 1
    assert data["source"] == "stac"
    assert data["degraded"] is True


async def test_estimate_debug_fail_all_double_fallback(monkeypatch, client):
    """X-Debug-Fail: all → 双源均模拟超时，返回兜底结构。"""
    monkeypatch.setattr("app.api.tasks.odata_search", lambda *a: None)  # 不应被调用
    monkeypatch.setattr("app.api.tasks.stac_search", lambda *a: None)
    token = await _token(client, "ahmed")
    data = await _estimate(client, token, "task-a-1", debug_fail="all")
    assert data["source"] is None
    assert data["fallbackUsed"] is True


async def test_estimate_riyadh_uses_38rkr(monkeypatch, client):
    """利雅得 AOI 质心 → MGRS 38RKR。"""
    seen = {}

    async def fake_odata(start, end, cloud, mgrs):
        seen["mgrs"] = mgrs
        return _STAC_SCENES

    monkeypatch.setattr("app.api.tasks.odata_search", fake_odata)
    token = await _token(client, "sameer")
    data = await _estimate(client, token, "task-b-1")
    assert seen["mgrs"] == "38RKR"
    assert data["source"] == "odata"


async def test_estimate_cross_tenant_task_404(client):
    """跨租户任务的 estimate：404（不泄露存在性）。"""
    token = await _token(client, "sameer")
    resp = await client.post("/api/tasks/task-a-1/estimate",
                             headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 404
    assert resp.json()["code"] == 2001
