"""USGS Landsat Look STAC 适配器（契约 §8 / PRD 5.2 降级备源）。

- POST https://landsatlook.usgs.gov/stac-server/search（服务端转发，无 CORS 限制）
- 8s 超时，重试 0 次；仅在 OData 主源失败后由降级链调用
- 返回景标注为 Landsat 15-30m（相对 Sentinel-2 10m 属分辨率降级，
  上层据此置 degraded=true）

实测结论：该端点仅允许自身 origin（浏览器直连被 CORS 拒绝），
故降级链必须经服务端本模块转发。
"""

import httpx

from app.adapters import Scene, SourceUnavailable

STAC_URL = "https://landsatlook.usgs.gov/stac-server/search"

MAX_SCENES = 20


async def search_scenes(bbox: tuple[float, float, float, float],
                        start: str, end: str, cloud_max: int, mgrs: str) -> list[Scene]:
    """按 bbox + 时间窗 + 云量检索 Landsat C2 L2 景列表（STAC search）。

    失败抛 SourceUnavailable，不重试。mgrs 用作 tile 兜底值——
    Landsat WRS 分幅与 MGRS 不是一套编号，仅当响应给出 grid:code 时采用响应值。
    """
    body = {
        "collections": ["landsat-c2l2-sr"],
        "bbox": list(bbox),
        "datetime": f"{start}T00:00:00Z/{end}T23:59:59Z",
        "limit": MAX_SCENES,
        "query": {"eo:cloud_cover": {"lt": int(cloud_max)}},
    }
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.post(STAC_URL, json=body)
            resp.raise_for_status()
            data = resp.json()
    except (httpx.HTTPError, ValueError) as e:
        raise SourceUnavailable(f"USGS STAC 不可达（{type(e).__name__}）") from e

    if not isinstance(data, dict):
        raise SourceUnavailable("STAC 响应结构异常（顶层非对象）")

    scenes: list[Scene] = []
    for feature in data.get("features") or []:
        if not isinstance(feature, dict):
            continue
        fid = feature.get("id")
        if not isinstance(fid, str) or not fid:
            continue
        props = feature.get("properties")
        props = props if isinstance(props, dict) else {}
        sensing = props.get("datetime")
        if not isinstance(sensing, str) or not sensing:
            continue
        cloud = None
        try:
            if props.get("eo:cloud_cover") is not None:
                cloud = float(props["eo:cloud_cover"])
        except (TypeError, ValueError):
            cloud = None
        grid = props.get("grid:code") if isinstance(props.get("grid:code"), str) else None
        scenes.append(Scene(
            id=fid,
            sensing_date=sensing[:10],
            cloud_pct=cloud,
            tile_id=grid.replace("MGRS-", "") if grid else mgrs,
        ))
        if len(scenes) >= MAX_SCENES:
            break
    return scenes
