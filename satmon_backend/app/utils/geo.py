"""AOI 几何校验与 4326 面积计算（契约 §3）。

- 有效性校验用 shapely（自相交、未闭合等由 is_valid + explain_validity 给出具体原因）
- 面积为 WGS84 球面面积：采用与 turf.js ringArea 相同的球面盈余公式（等价于
  pyproj.Geod 的球面近似，R=6378137）。MVP 不引入 pyproj（CLAUDE.md 工程原则 6：
  单一场景直接实现，不为一个公式引入重依赖）；若后续出现第二个测地计算用例
  （如斑块面积统计需要椭球精度）再统一切换 pyproj。
"""

import math

from shapely.geometry import shape
from shapely.geometry.polygon import Polygon

_EARTH_RADIUS_M = 6378137.0


def _ring_area_m2(coords: list[list[float]]) -> float:
    """单环球面面积（|球面盈余|，turf.js ringArea 同式）。coords 为 [lon, lat] 序列。"""
    total = 0.0
    n = len(coords)
    for i in range(n):
        p1, p2 = coords[i], coords[(i + 1) % n]
        total += (math.radians(p2[0]) - math.radians(p1[0])) * (
            2 + math.sin(math.radians(p1[1])) + math.sin(math.radians(p2[1]))
        )
    return abs(total * _EARTH_RADIUS_M * _EARTH_RADIUS_M / 2.0)


def validate_polygon(geojson: dict) -> tuple[Polygon, float]:
    """校验 Polygon GeoJSON 并返回 (shapely 多边形, 面积 km²)。

    不合法时抛出 ValueError，message 为可直接返回给前端的具体原因。
    """
    if not isinstance(geojson, dict) or geojson.get("type") != "Polygon":
        raise ValueError("geojson 必须为 {type: 'Polygon', coordinates: [...]} 结构")
    coords = geojson.get("coordinates")
    if not isinstance(coords, list) or not coords or not isinstance(coords[0], list):
        raise ValueError("coordinates 结构不合法：需为非空环数组")

    # GeoJSON 规范要求环闭合（shapely 会自动补闭合，须在此显式拦截）
    for ring in coords:
        if len(ring) < 3 or ring[0] != ring[-1]:
            raise ValueError("多边形环未闭合或顶点数不足（首尾坐标必须相同且不少于 4 个点）")

    try:
        geom = shape(geojson)
    except Exception:
        raise ValueError("GeoJSON 无法解析为多边形")
    if not isinstance(geom, Polygon):
        raise ValueError("geojson 必须为单多边形（不支持 MultiPolygon/其他类型）")
    if geom.is_empty:
        raise ValueError("多边形为空")
    if not geom.is_valid:
        from shapely.validation import explain_validity
        raise ValueError(f"多边形无效：{explain_validity(geom)}")

    # 面积 = 外环 - 洞（球面）
    area_m2 = _ring_area_m2([list(c) for c in geom.exterior.coords])
    for r in geom.interiors:
        area_m2 -= _ring_area_m2(list(r.coords))
    area_km2 = max(area_m2, 0.0) / 1e6
    if area_km2 <= 0:
        raise ValueError("多边形面积必须大于 0")
    return geom, area_km2


def centroid_and_bbox(geojson: dict) -> tuple[tuple[float, float], tuple[float, float, float, float]]:
    """取 Polygon GeoJSON 的质心 (lon, lat) 与外接矩形 (minLon, minLat, maxLon, maxLat)。

    供影像检索构造 MGRS 分幅与 STAC bbox 使用；几何异常时抛 ValueError
    （调用方传入的是库内已校验的 AOI，异常只可能来自数据损坏）。
    """
    geom, _ = validate_polygon(geojson)
    c = geom.centroid
    return (c.x, c.y), geom.bounds


def mgrs_tile(lon: float, lat: float) -> str:
    """AOI 质心 → MGRS 分幅（契约 §4：迪拜 42RVR、利雅得 38RKR/38RKS）。

    非通用 MGRS 编码：MVP 演示区仅两城市，按经度阈值判定即可；
    引入完整 MGRS 网格库属推测性抽象，待第二个真实区域用例出现再换。
    """
    if lon >= 50.0:
        return "42RVR"
    # 利雅得城区横跨 38RKR/38RKS 两幅，以 46.85E 分界（西/北郊 38RKR，东郊 38RKS）
    return "38RKS" if lon >= 46.85 else "38RKR"
