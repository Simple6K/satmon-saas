"""Copernicus Data Space OData 目录适配器（契约 §8 / PRD 5.2 主源）。

- GET https://catalogue.dataspace.copernicus.eu/odata/v1/Products
- $filter 必含：ContentDate（时间窗）、CloudCover（云量上限）、Online eq true，
  另加 contains(Name, MGRS) 分幅过滤与 contains(Name,'MSIL2A') 产品族过滤
- httpx AsyncClient，8s 硬超时，重试 0 次（禁止无边界重试）
- 免登录可达（实测），现场演示主链路唯一真实检索源

实测结论（任务说明与数据源确认报告）：该端点响应头
access-control-allow-origin: *；本模块为服务端调用，无 CORS 顾虑。
"""

import re

import httpx

from app.adapters import Scene, SourceUnavailable

ODATA_URL = "https://catalogue.dataspace.copernicus.eu/odata/v1/Products"

# Sentinel-2 产品名内的 MGRS 分幅，如 "..._T42RVR_..."
_MGRS_IN_NAME = re.compile(r"_T(\d{2}[A-Z]{3})_")

# 预演返回条数上限（$top 与本地截断一致，防止外部返回异常巨量数据）
MAX_SCENES = 20


def _mgrs_from_name(name: str) -> str | None:
    m = _MGRS_IN_NAME.search(name)
    return m.group(1) if m else None


def _cloud_from_attributes(attrs) -> float | None:
    """从 $expand=Attributes 列表提取 cloudCover；缺失/类型异常返回 None。"""
    if not isinstance(attrs, list):
        return None
    for a in attrs:
        if isinstance(a, dict) and a.get("Name") == "cloudCover":
            try:
                return float(a.get("Value"))
            except (TypeError, ValueError):
                return None
    return None


async def search_scenes(start: str, end: str, cloud_max: int, mgrs: str) -> list[Scene]:
    """按时间窗（YYYY-MM-DD）/ 云量上限 / MGRS 分幅检索 Sentinel-2 L2A 景列表。

    失败（超时 / 网络错误 / 5xx / 响应体非 JSON）抛 SourceUnavailable，
    由上层决定降级；本函数不重试。
    """
    odata_filter = (
        # 实测结论（2026-09）：CDSE 已把 cloudCover 迁到类型化 DoubleAttribute，
        # 旧文档的 StringAttribute + lt 写法会被 400 拒绝
        # （"Cannot apply 'Lt()' to 'String/Integer'"），此处照实测可用形式写死
        f"Attributes/OData.CSC.DoubleAttribute/any(att:att/Name eq 'cloudCover'"
        f" and att/OData.CSC.DoubleAttribute/Value lt {int(cloud_max)})"
        f" and ContentDate/Start gt {start}T00:00:00.000Z"
        f" and ContentDate/End lt {end}T23:59:59.999Z"
        f" and Online eq true"
        f" and contains(Name,'MSIL2A')"
        f" and contains(Name,'{mgrs}')"
    )
    params = {
        "$filter": odata_filter,
        "$orderby": "ContentDate/Start desc",
        "$top": MAX_SCENES,
        "$expand": "Attributes",
    }
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(ODATA_URL, params=params)
            resp.raise_for_status()
            data = resp.json()
    except (httpx.HTTPError, ValueError) as e:
        # httpx.HTTPError 覆盖超时/连接/HTTP 状态错误；ValueError 覆盖非 JSON 响应体
        raise SourceUnavailable(f"OData 目录不可达（{type(e).__name__}）") from e

    if not isinstance(data, dict):
        raise SourceUnavailable("OData 响应结构异常（顶层非对象）")

    # DTO → 领域模型：逐条防御式解析，脏条目跳过不崩溃
    scenes: list[Scene] = []
    for item in data.get("value") or []:
        if not isinstance(item, dict):
            continue
        scene_id, name = item.get("Id"), item.get("Name")
        if not isinstance(scene_id, str) or not scene_id or not isinstance(name, str):
            continue
        content_date = item.get("ContentDate")
        sensing = content_date.get("Start") if isinstance(content_date, dict) else None
        if not isinstance(sensing, str) or not sensing:
            continue
        tile = _mgrs_from_name(name) or mgrs
        scenes.append(Scene(
            id=scene_id,
            sensing_date=sensing[:10],
            cloud_pct=_cloud_from_attributes(item.get("Attributes")),
            tile_id=tile,
        ))
        if len(scenes) >= MAX_SCENES:
            break
    return scenes
