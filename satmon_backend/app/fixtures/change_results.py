"""变化检测结果与影像景 fixtures（预缓存演示数据，对齐 PRD「像素级分析不做」的 MVP 边界）。

- 斑块坐标手工构造：迪拜 55.05-55.30E / 24.95-25.25N，利雅得 46.6-46.8E / 24.7-24.9N
- 面积 0.1-3km²、confidence 0-1、beforeDate/afterDate 取 2025-2026 真实感 Sentinel-2 重访日期
- 面积不硬编码：按几何用 4326 球面公式实算（与 AOI 面积同一算法），
  保证 stats.totalAreaKm2 与斑块面积之和自洽
- 种子任务的斑块 id 与 app/db/seed.py 的告警（patch-a-1/patch-a-2/patch-b-1）对齐，
  使告警 → 斑块举证链路可点通
"""

import json

from app.utils.geo import validate_polygon

# ---- 斑块模板：{锚点经度, 锚点纬度, 宽度deg, 高度deg, confidence, changeType,
#      beforeDate, afterDate, alertLevel}。面积由几何实算。----
_DUBAI_PATCHES = [
    # 迪拜 task-a-1（城市扩张监测）：Jebel Ali / Al Qudra / 城市边缘带
    (55.075, 25.045, 0.0160, 0.0172, 0.92, "新增建设", "2025-11-02", "2026-09-22", "high"),
    (55.118, 24.978, 0.0128, 0.0129, 0.81, "植被减少", "2025-12-08", "2026-09-18", "medium"),
    (55.176, 25.098, 0.0074, 0.0082, 0.62, "新增建设", "2026-01-15", "2026-09-10", "low"),
    (55.221, 25.178, 0.0104, 0.0110, 0.74, "地表变化", "2025-10-20", "2026-08-30", "medium"),
    (55.058, 25.198, 0.0148, 0.0135, 0.88, "新增建设", "2025-11-26", "2026-09-05", "high"),
    (55.148, 25.228, 0.0057, 0.0060, 0.55, "植被减少", "2026-02-11", "2026-09-14", "low"),
    (55.256, 25.032, 0.0090, 0.0096, 0.71, "新增建设", "2026-03-02", "2026-09-19", "medium"),
    (55.102, 25.132, 0.0037, 0.0040, 0.48, "地表变化", "2026-04-18", "2026-09-12", "low"),
]

_RIYADH_PATCHES = [
    # 利雅得 task-b-1（耕地非农化监测）：北郊耕地片区
    (46.662, 24.742, 0.0164, 0.0132, 0.90, "耕地占用", "2025-11-14", "2026-09-16", "high"),
    (46.718, 24.778, 0.0112, 0.0090, 0.76, "植被减少", "2025-12-30", "2026-09-08", "medium"),
    (46.678, 24.822, 0.0086, 0.0069, 0.68, "耕地占用", "2026-01-22", "2026-09-20", "medium"),
    (46.748, 24.858, 0.0066, 0.0053, 0.52, "新增建设", "2026-03-15", "2026-09-11", "low"),
    (46.618, 24.762, 0.0134, 0.0108, 0.85, "耕地占用", "2026-02-09", "2026-09-17", "high"),
    (46.788, 24.878, 0.0052, 0.0042, 0.47, "植被减少", "2026-04-27", "2026-09-06", "low"),
]

# ---- 影像景 fixtures（任务 retrieving 阶段写入 task_scenes，演示「已检索到 N 景候选」）----
# 产品 ID 形态仿 OData UUID；日期为 2026 年时间窗内的 Sentinel-2 5 天重访节奏。
_DUBAI_SCENES = [
    ("4f1e2a71-9b30-4c2e-8f1a-2d3b4c5d6e01", "2026-09-22", 2.1),
    ("4f1e2a71-9b30-4c2e-8f1a-2d3b4c5d6e02", "2026-09-17", 8.4),
    ("4f1e2a71-9b30-4c2e-8f1a-2d3b4c5d6e03", "2026-09-12", 15.7),
    ("4f1e2a71-9b30-4c2e-8f1a-2d3b4c5d6e04", "2026-09-07", 4.3),
    ("4f1e2a71-9b30-4c2e-8f1a-2d3b4c5d6e05", "2026-08-28", 11.9),
    ("4f1e2a71-9b30-4c2e-8f1a-2d3b4c5d6e06", "2026-08-18", 6.6),
    ("4f1e2a71-9b30-4c2e-8f1a-2d3b4c5d6e07", "2026-08-08", 18.2),
    ("4f1e2a71-9b30-4c2e-8f1a-2d3b4c5d6e08", "2026-07-29", 9.8),
    ("4f1e2a71-9b30-4c2e-8f1a-2d3b4c5d6e09", "2026-07-14", 3.5),
    ("4f1e2a71-9b30-4c2e-8f1a-2d3b4c5d6e0a", "2026-07-04", 12.4),
    ("4f1e2a71-9b30-4c2e-8f1a-2d3b4c5d6e0b", "2026-06-19", 7.2),
    ("4f1e2a71-9b30-4c2e-8f1a-2d3b4c5d6e0c", "2026-06-09", 16.8),
    ("4f1e2a71-9b30-4c2e-8f1a-2d3b4c5d6e0d", "2026-05-30", 5.1),
    ("4f1e2a71-9b30-4c2e-8f1a-2d3b4c5d6e0e", "2026-05-15", 10.6),
]

_RIYADH_SCENES = [
    ("8a3c51d2-e04f-4b19-a7c6-5e7f8a9b0c01", "2026-09-20", 1.4),
    ("8a3c51d2-e04f-4b19-a7c6-5e7f8a9b0c02", "2026-09-15", 6.9),
    ("8a3c51d2-e04f-4b19-a7c6-5e7f8a9b0c03", "2026-09-05", 13.2),
    ("8a3c51d2-e04f-4b19-a7c6-5e7f8a9b0c04", "2026-08-26", 4.7),
    ("8a3c51d2-e04f-4b19-a7c6-5e7f8a9b0c05", "2026-08-16", 17.5),
    ("8a3c51d2-e04f-4b19-a7c6-5e7f8a9b0c06", "2026-08-01", 8.3),
    ("8a3c51d2-e04f-4b19-a7c6-5e7f8a9b0c07", "2026-07-22", 2.8),
    ("8a3c51d2-e04f-4b19-a7c6-5e7f8a9b0c08", "2026-07-07", 14.1),
    ("8a3c51d2-e04f-4b19-a7c6-5e7f8a9b0c09", "2026-06-22", 9.6),
    ("8a3c51d2-e04f-4b19-a7c6-5e7f8a9b0c0a", "2026-06-07", 5.4),
]


def region_of(lon: float, lat: float) -> str:
    """按 AOI 质心判定演示区域：dubai / riyadh（仅覆盖两演示城市，不做通用判定）。"""
    return "dubai" if lon >= 50.0 else "riyadh"


def _polygon(lon: float, lat: float, w: float, h: float) -> dict:
    """以 (lon, lat) 为左下角的矩形 Polygon GeoJSON。"""
    ring = [
        [lon, lat], [lon + w, lat], [lon + w, lat + h],
        [lon, lat + h], [lon, lat],
    ]
    return {"type": "Polygon", "coordinates": [ring]}


def build_patches(region: str, id_prefix: str) -> list[dict]:
    """构造某区域的斑块行列表（不含 tenant_id/task_id，由调用方补）。

    id_prefix 为空时返回不带 id 的模板（运行期生成任务结果时由调用方起 id）。
    """
    templates = _DUBAI_PATCHES if region == "dubai" else _RIYADH_PATCHES
    rows = []
    for i, (lon, lat, w, h, conf, ctype, before, after, level) in enumerate(templates, 1):
        geojson = _polygon(lon, lat, w, h)
        _, area_km2 = validate_polygon(geojson)
        rows.append({
            "id": f"{id_prefix}-{i}" if id_prefix else None,
            "area_km2": area_km2,
            "confidence": conf,
            "change_type": ctype,
            "before_date": before,
            "after_date": after,
            "alert_level": level,
            "geojson": geojson,
        })
    return rows


def scenes_for_region(region: str) -> list[tuple[str, str, float, str]]:
    """某区域的影像景 fixtures：[(scene_id, sensing_date, cloud_pct, tile_id)]。"""
    tile = "42RVR" if region == "dubai" else "38RKR"
    scenes = _DUBAI_SCENES if region == "dubai" else _RIYADH_SCENES
    return [(sid, date, cloud, tile) for sid, date, cloud in scenes]


def seed_task_fixtures() -> None:
    """为种子任务幂等灌入斑块与影像景（契约 §7：变化斑块 fixtures 于启动时补齐）。

    种子任务固定 ID：task-a-1（迪拜，8 斑块）/ task-b-1（利雅得，6 斑块）。
    已完成种子任务同时补 task_scenes，使详情页与报告的「数据源结果摘要」非空。
    运行期新建任务的结果由 task_engine 在完成时另行生成（id 规则不同）。
    """
    from app.db.sqlite import db

    seeded = [
        ("task-a-1", "dubai_municipality", "dubai", "patch-a"),
        ("task-b-1", "mewa_riyadh", "riyadh", "patch-b"),
    ]
    with db() as conn:
        for task_id, tenant_id, region, prefix in seeded:
            has_patches = conn.execute(
                "SELECT 1 FROM patches WHERE task_id = ? LIMIT 1", (task_id,)
            ).fetchone()
            if not has_patches:
                for p in build_patches(region, prefix):
                    conn.execute(
                        "INSERT INTO patches(id, tenant_id, task_id, area_km2, confidence,"
                        " change_type, before_date, after_date, alert_level, geojson)"
                        " VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (p["id"], tenant_id, task_id, p["area_km2"], p["confidence"],
                         p["change_type"], p["before_date"], p["after_date"],
                         p["alert_level"], json.dumps(p["geojson"])),
                    )
            # 已完成的种子任务同步补影像景（幂等：已有景则跳过）
            has_scenes = conn.execute(
                "SELECT 1 FROM task_scenes WHERE task_id = ? LIMIT 1", (task_id,)
            ).fetchone()
            if not has_scenes:
                for sid, date, cloud, tile in scenes_for_region(region):
                    conn.execute(
                        "INSERT INTO task_scenes(id, tenant_id, task_id, source, scene_id,"
                        " sensing_date, cloud_pct, tile_id) VALUES (?,?,?,?,?,?,?,?)",
                        (f"scene-{task_id}-{sid[-6:]}", tenant_id, task_id, "odata",
                         sid, date, cloud, tile),
                    )
