"""AOI 端点测试（契约 §3）：校验拒绝路径 + 配额 + 权限。"""


async def _token(client, username: str) -> str:
    resp = await client.post("/api/auth/login", json={"username": username})
    return resp.json()["data"]["token"]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _rect(lon0: float, lat0: float, dlon: float, dlat: float) -> dict:
    ring = [
        [lon0, lat0],
        [lon0 + dlon, lat0],
        [lon0 + dlon, lat0 + dlat],
        [lon0, lat0 + dlat],
        [lon0, lat0],
    ]
    return {"type": "Polygon", "coordinates": [ring]}


async def test_list_aois(client):
    """租户 A 有 2 个种子 AOI，geojson 可解析回 Polygon。"""
    token = await _token(client, "ahmed")
    resp = await client.get("/api/aois", headers=_auth(token))
    assert resp.status_code == 200
    aois = resp.json()["data"]
    assert {a["id"] for a in aois} == {"aoi-a-1", "aoi-a-2"}
    for a in aois:
        assert a["geojson"]["type"] == "Polygon"
        assert a["areaKm2"] > 0
        assert a["monitorType"] in (
            "illegal_construction", "farmland_non_agri", "urban_expansion", "surface_change")


async def test_create_aoi_success(client):
    """迪拜附近合法小多边形创建成功，面积按 4326 球面计算。"""
    token = await _token(client, "ahmed")
    geojson = _rect(55.10, 25.10, 0.05, 0.05)  # 约 28 km²
    resp = await client.post("/api/aois", headers=_auth(token),
                             json={"name": "测试小片区", "monitorType": "surface_change",
                                   "geojson": geojson})
    assert resp.status_code == 200
    aoi = resp.json()["data"]
    assert aoi["areaKm2"] == 28.0 or abs(aoi["areaKm2"] - 28.0) < 1.0
    # 面积进入用量
    sub = (await client.get("/api/subscription", headers=_auth(token))).json()["data"]
    assert sub["usage"]["aoiAreaKm2"] > 1000


async def test_create_aoi_invalid_geometry_400(client):
    """自相交蝴蝶结多边形：400 + 具体原因。"""
    token = await _token(client, "ahmed")
    bowtie = {"type": "Polygon", "coordinates": [[
        [55.0, 25.0], [55.1, 25.1], [55.1, 25.0], [55.0, 25.1], [55.0, 25.0]
    ]]}
    resp = await client.post("/api/aois", headers=_auth(token),
                             json={"name": "坏几何", "monitorType": "urban_expansion",
                                   "geojson": bowtie})
    assert resp.status_code == 400
    body = resp.json()
    assert body["code"] == 1003
    assert "多边形无效" in body["msg"]


async def test_create_aoi_unclosed_ring_400(client):
    """未闭合环：shapely 视为无效。"""
    token = await _token(client, "ahmed")
    unclosed = {"type": "Polygon", "coordinates": [[
        [55.0, 25.0], [55.1, 25.0], [55.1, 25.1], [55.0, 25.1]
    ]]}
    resp = await client.post("/api/aois", headers=_auth(token),
                             json={"name": "未闭合", "monitorType": "urban_expansion",
                                   "geojson": unclosed})
    assert resp.status_code == 400


async def test_create_aoi_wrong_type_400(client):
    """非 Polygon 类型（如 Point）：400。"""
    token = await _token(client, "ahmed")
    resp = await client.post("/api/aois", headers=_auth(token),
                             json={"name": "点", "monitorType": "urban_expansion",
                                   "geojson": {"type": "Point", "coordinates": [55.1, 25.0]}})
    assert resp.status_code == 400
    assert "Polygon" in resp.json()["msg"]


async def test_create_aoi_bad_monitor_type_400(client):
    token = await _token(client, "ahmed")
    resp = await client.post("/api/aois", headers=_auth(token),
                             json={"name": "x", "monitorType": "mining",
                                   "geojson": _rect(55.1, 25.1, 0.01, 0.01)})
    assert resp.status_code == 400
    assert resp.json()["code"] == 1003


async def test_create_aoi_quota_exceeded_400_with_usage(client):
    """面积超订阅额度：400 且 data.usage 含剩余额度（租户 B basic 限 500）。"""
    token = await _token(client, "sameer")
    # 0.7° x 0.7° 在 24.9°N 约 4900 km²，远超 basic 剩余额度
    resp = await client.post("/api/aois", headers=_auth(token),
                             json={"name": "超大范围", "monitorType": "farmland_non_agri",
                                   "geojson": _rect(46.7, 24.8, 0.7, 0.7)})
    assert resp.status_code == 400
    body = resp.json()
    assert body["code"] == 1003
    assert "超出订阅剩余额度" in body["msg"]
    usage = body["data"]["usage"]
    assert usage["limitKm2"] == 500
    assert usage["usedKm2"] > 0
    assert 0 < usage["remainingKm2"] < 500


async def test_create_aoi_approver_403(client):
    """approver 只读：创建 AOI 被拒。"""
    token = await _token(client, "fatima")
    resp = await client.post("/api/aois", headers=_auth(token),
                             json={"name": "只读尝试", "monitorType": "urban_expansion",
                                   "geojson": _rect(55.1, 25.1, 0.01, 0.01)})
    assert resp.status_code == 403
    assert resp.json()["code"] == 2003


async def test_update_and_delete_aoi(client):
    token = await _token(client, "ahmed")
    # 更新名称与几何（缩小）
    resp = await client.put("/api/aois/aoi-a-2", headers=_auth(token),
                            json={"name": "迪拜城市边缘区（修正）",
                                  "geojson": _rect(55.30, 25.15, 0.05, 0.05)})
    assert resp.status_code == 200
    aoi = resp.json()["data"]
    assert aoi["name"] == "迪拜城市边缘区（修正）"
    assert aoi["areaKm2"] < 40

    # 更新为非法几何被拒，原数据不变
    resp = await client.put("/api/aois/aoi-a-2", headers=_auth(token),
                            json={"geojson": {"type": "Point", "coordinates": [55.3, 25.2]}})
    assert resp.status_code == 400
    still = (await client.get("/api/aois", headers=_auth(token))).json()["data"]
    target = [a for a in still if a["id"] == "aoi-a-2"][0]
    assert target["geojson"]["type"] == "Polygon"

    # 删除
    resp = await client.delete("/api/aois/aoi-a-2", headers=_auth(token))
    assert resp.status_code == 200
    assert resp.json()["data"]["deleted"] is True
    after = (await client.get("/api/aois", headers=_auth(token))).json()["data"]
    assert {a["id"] for a in after} == {"aoi-a-1"}


async def test_delete_aoi_approver_403(client):
    token = await _token(client, "fatima")
    resp = await client.delete("/api/aois/aoi-a-1", headers=_auth(token))
    assert resp.status_code == 403
    assert resp.json()["code"] == 2003


async def test_aoi_not_found_404(client):
    token = await _token(client, "ahmed")
    resp = await client.put("/api/aois/aoi-nope", headers=_auth(token),
                            json={"name": "不存在"})
    assert resp.status_code == 404
    assert resp.json()["code"] == 2001
