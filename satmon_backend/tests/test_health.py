async def test_liveness(client):
    """测试存活探针接口。"""
    response = await client.get("/api/health/live")
    assert response.status_code == 200
    data = response.json()
    assert data["code"] == 0
    assert data["data"]["status"] == "alive"


async def test_readiness(client):
    """测试就绪探针接口。"""
    response = await client.get("/api/health/ready")
    assert response.status_code == 200
    data = response.json()
    assert data["code"] == 0
    assert data["data"]["status"] == "ready"
