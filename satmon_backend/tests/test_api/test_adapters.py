"""适配器边界测试：外部响应视为不可信，脏数据不崩溃、失败抛 SourceUnavailable。"""

import json

import httpx
import pytest

from app.adapters import SourceUnavailable, copernicus_odata, usgs_stac


def _mock_transport(monkeypatch, module, handler):
    """把适配器内构造的 AsyncClient 替换为带 MockTransport 的等价客户端。"""
    real_client = httpx.AsyncClient

    def factory(**kwargs):
        kwargs.pop("timeout", None)
        return real_client(transport=httpx.MockTransport(handler), timeout=8.0)

    monkeypatch.setattr(module.httpx, "AsyncClient", factory)


async def test_odata_parses_and_skips_dirty_entries(monkeypatch):
    """正常条目转换为 Scene；字段缺失/类型异常的条目被跳过而非崩溃。"""

    def handler(request: httpx.Request) -> httpx.Response:
        odata_filter = request.url.params["$filter"]
        assert "Online eq true" in odata_filter
        assert "contains(Name,'42RVR')" in odata_filter
        assert "ContentDate/Start" in odata_filter
        assert "cloudCover" in odata_filter
        return httpx.Response(200, json={"value": [
            {  # 正常条目
                "Id": "p-1", "Name": "S2A_MSIL2A_20260922T073651_N0500_R062_T42RVR_20260922T101323",
                "ContentDate": {"Start": "2026-09-22T07:36:51Z", "End": "2026-09-22T07:46:51Z"},
                "Attributes": [{"Name": "cloudCover", "Value": "3.4"}],
            },
            {"Name": "no-id"},               # 缺 Id → 跳过
            {"Id": 123, "Name": "bad-type"},  # Id 类型异常 → 跳过
            {"Id": "p-4", "Name": "S2B_x_T38RKR_x"},  # 缺 ContentDate → 跳过
            "not-a-dict",                     # 非对象条目 → 跳过
        ]})

    _mock_transport(monkeypatch, copernicus_odata, handler)
    scenes = await copernicus_odata.search_scenes("2026-01-01", "2026-09-01", 20, "42RVR")
    assert len(scenes) == 1
    assert scenes[0].id == "p-1"
    assert scenes[0].sensing_date == "2026-09-22"
    assert scenes[0].cloud_pct == 3.4
    assert scenes[0].tile_id == "42RVR"


async def test_odata_network_error_raises_unavailable(monkeypatch):
    """网络错误（含超时同类）→ SourceUnavailable，不重试不吞错。"""

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    _mock_transport(monkeypatch, copernicus_odata, handler)
    with pytest.raises(SourceUnavailable):
        await copernicus_odata.search_scenes("2026-01-01", "2026-09-01", 20, "42RVR")


async def test_stac_parses_features(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        body = json.loads(request.content)
        assert body["collections"] == ["landsat-c2l2-sr"]
        assert body["bbox"] == [55.0, 25.0, 55.3, 25.3]
        return httpx.Response(200, json={"features": [
            {"id": "LC08_L2SP_1", "properties": {
                "datetime": "2026-09-10T07:20:00Z", "eo:cloud_cover": 5.2}},
            {"id": "LC09_L2SP_2", "properties": {"datetime": "2026-08-30T07:15:00Z"}},
            {"properties": {"datetime": "x"}},  # 缺 id → 跳过
        ]})

    _mock_transport(monkeypatch, usgs_stac, handler)
    scenes = await usgs_stac.search_scenes(
        (55.0, 25.0, 55.3, 25.3), "2026-01-01", "2026-09-01", 20, "42RVR")
    assert [s.id for s in scenes] == ["LC08_L2SP_1", "LC09_L2SP_2"]
    assert scenes[0].cloud_pct == 5.2
    assert scenes[1].cloud_pct is None
    assert all(s.tile_id == "42RVR" for s in scenes)  # grid:code 缺失时兜底用入参
