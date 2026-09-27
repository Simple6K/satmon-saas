"""结果与报告测试（契约 §5/§6）：stats 结构、举证详情、跨租户 404、报告 sections。"""


async def _token(client, username: str) -> str:
    resp = await client.post("/api/auth/login", json={"username": username})
    return resp.json()["data"]["token"]


async def test_results_stats_and_geojson(client):
    """task-a-1 结果：斑块数/总面积/byType 与 FeatureCollection 结构。"""
    token = await _token(client, "ahmed")
    resp = await client.get("/api/tasks/task-a-1/results",
                            headers={"Authorization": f"Bearer {token}"})
    data = resp.json()["data"]
    assert data["taskId"] == "task-a-1"
    assert data["stats"]["patchCount"] == 8
    assert data["stats"]["totalAreaKm2"] > 5  # 8 斑块合计（含 3.2km² 大斑块）
    assert "新增建设" in data["stats"]["byType"]
    fc = data["geojson"]
    assert fc["type"] == "FeatureCollection"
    assert len(fc["features"]) == 8
    props = fc["features"][0]["properties"]
    for key in ("patchId", "areaKm2", "confidence", "changeType", "beforeDate",
                "afterDate", "alertLevel"):
        assert key in props
    # 坐标落在迪拜演示区（55.05-55.30E / 24.95-25.25N）
    ring = fc["features"][0]["geometry"]["coordinates"][0]
    assert all(55.0 < lon < 55.35 and 24.9 < lat < 25.3 for lon, lat in ring)
    # 面积在契约要求的 0.1-3km² 量级
    areas = [f["properties"]["areaKm2"] for f in fc["features"]]
    assert min(areas) >= 0.1 and max(areas) <= 3.3


async def test_patch_detail_context_layers(client):
    """斑块举证详情：contextLayers 按 §5 固定标注，poi 不可用。"""
    token = await _token(client, "ahmed")
    resp = await client.get("/api/tasks/task-a-1/results/patch-a-1",
                            headers={"Authorization": f"Bearer {token}"})
    data = resp.json()["data"]
    assert data["patchId"] == "patch-a-1"
    assert data["contextLayers"] == {
        "worldcover": "available", "worldpop": "available",
        "imerg": "available_2km", "poi": "unavailable",
    }
    # 斑块不存在 / 告警关联的斑块可点通（举证链路）
    resp404 = await client.get("/api/tasks/task-a-1/results/patch-nope",
                               headers={"Authorization": f"Bearer {token}"})
    assert resp404.status_code == 404
    assert resp404.json()["code"] == 2001


async def test_cross_tenant_results_404(client):
    """跨租户 results：任务与斑块双层 404（US-11 不泄露存在性）。"""
    token = await _token(client, "sameer")  # 租户 B 访问租户 A 的任务
    for url in ("/api/tasks/task-a-1/results", "/api/tasks/task-a-1/results/patch-a-1",
                "/api/tasks/task-a-1"):
        resp = await client.get(url, headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 404, url
        assert resp.json()["code"] == 2001
    # 反向：租户 A 访问租户 B 任务同样 404
    token_a = await _token(client, "ahmed")
    resp = await client.get("/api/tasks/task-b-1/results",
                            headers={"Authorization": f"Bearer {token_a}"})
    assert resp.status_code == 404


async def test_report_generation_and_sections(client):
    """报告：概览/统计表（byType+Top10）/方法学附注三段齐全，可重复生成。"""
    token = await _token(client, "fatima")  # approver 可生成报告（US-09 画像 B）
    resp = await client.post("/api/reports", headers={"Authorization": f"Bearer {token}"},
                             json={"taskId": "task-a-1"})
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["taskId"] == "task-a-1"

    s = data["sections"]
    assert s["overview"]["taskName"] == "迪拜海岸带城市扩张监测（9 月）"
    assert s["overview"]["timeWindow"] == {"start": "2025-09-01", "end": "2026-09-01"}
    assert s["overview"]["aoiGeojson"]["type"] == "Polygon"
    assert s["stats"]["patchCount"] == 8
    assert len(s["stats"]["byType"]) >= 3
    assert len(s["stats"]["top10Patches"]) == 8  # 斑块不足 10 取全量
    assert s["stats"]["top10Patches"][0]["areaKm2"] >= s["stats"]["top10Patches"][-1]["areaKm2"]
    assert "Sentinel-2 L2A 10m" in s["methodology"]["note"]
    assert "局限" in s["methodology"]["note"] or "限制" in s["methodology"]["note"]

    # 列表与详情
    lst = (await client.get("/api/reports",
                            headers={"Authorization": f"Bearer {token}"})).json()["data"]
    assert any(r["taskId"] == "task-a-1" for r in lst)
    detail = (await client.get(f"/api/reports/{data['id']}",
                               headers={"Authorization": f"Bearer {token}"})).json()["data"]
    assert detail["sections"]["stats"]["patchCount"] == 8

    # 跨租户任务 → 404；跨租户报告详情 → 404
    token_b = await _token(client, "nora")
    resp = await client.post("/api/reports", headers={"Authorization": f"Bearer {token_b}"},
                             json={"taskId": "task-a-1"})
    assert resp.status_code == 404
    resp = await client.get(f"/api/reports/{data['id']}",
                            headers={"Authorization": f"Bearer {token_b}"})
    assert resp.status_code == 404
