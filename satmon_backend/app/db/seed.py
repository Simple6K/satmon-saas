"""种子数据（契约 §7）：启动时幂等灌入 SQLite。

幂等方式：所有行使用固定 ID + INSERT OR IGNORE，重复启动不重复插入、
不覆盖已有数据。变化斑块（patches）由变化检测功能代理预缓存 fixtures 补齐，
本模块不灌入（契约 §7 允许）。

时间统一为 ISO8601 UTC 字符串；种子时间取固定值（相对 2026-09 演示日），
保证演示与测试输出稳定。
"""

import json

from app.db.sqlite import db
from app.log.log import logger
from app.utils.geo import validate_polygon

# ---- 固定种子时间（ISO8601 UTC）----
T0 = "2026-01-15T00:00:00Z"      # 租户/订阅创建
T1 = "2026-06-01T00:00:00Z"      # AOI / 任务
T2 = "2026-09-20T00:00:00Z"      # 告警 / 消息 / 审计
RENEWAL = "2027-01-15T00:00:00Z"  # 续费日


def _rect(lon0: float, lat0: float, dlon: float, dlat: float) -> dict:
    """以 (lon0, lat0) 为左下角的矩形 Polygon GeoJSON（首尾闭合）。"""
    ring = [
        [lon0, lat0],
        [lon0 + dlon, lat0],
        [lon0 + dlon, lat0 + dlat],
        [lon0, lat0 + dlat],
        [lon0, lat0],
    ]
    return {"type": "Polygon", "coordinates": [ring]}


# 租户 A：迪拜海岸带（约 55.05E, 25.05N 周边）与城市边缘区
AOI_A1 = _rect(55.02, 25.02, 0.25, 0.22)
AOI_A2 = _rect(55.30, 25.15, 0.18, 0.18)
# 租户 B：利雅得北郊耕地片区（约 46.65E, 24.85N 周边）
AOI_B1 = _rect(46.65, 24.85, 0.16, 0.14)

PLANS = [
    {
        "id": "basic", "name": "基础版",
        "area_limit_km2": 500, "monitor_type_count": 1, "monitor_types": "任选 1 类监测类型",
        "revisit": "monthly", "seats": 5, "max_concurrent_tasks": 2,
        "data_source_note": "Sentinel-2 L2A 10m（Copernicus Data Space，影像延迟 ≤ 5 天，年内有效重访 ≥ 11 次）",
    },
    {
        "id": "pro", "name": "专业版",
        "area_limit_km2": 2500, "monitor_type_count": 2, "monitor_types": "任选 2 类监测类型",
        "revisit": "monthly+quarterly_rush", "seats": 15, "max_concurrent_tasks": 4,
        "data_source_note": "Sentinel-2 L2A 10m（Copernicus Data Space）+ Landsat 8/9 辅助（USGS STAC，15-30m）",
    },
    {
        "id": "flagship", "name": "旗舰版",
        "area_limit_km2": 10000, "monitor_type_count": 4, "monitor_types": "全部 4 类监测类型",
        "revisit": "biweekly", "seats": 50, "max_concurrent_tasks": 10,
        "data_source_note": "Sentinel-2 L2A 10m + Landsat 8/9 + GIBS 可视化全套（Copernicus/NASA/ESA 具名公开数据源）",
    },
]

USERS = [
    # (id, tenant_id, username, name, role, joined_at)
    ("user-ahmed", "dubai_municipality", "ahmed", "Ahmed Al Mansoori", "analyst", T0),
    ("user-fatima", "dubai_municipality", "fatima", "Fatima Al Zarooni", "approver", T0),
    ("user-khalid", "dubai_municipality", "khalid", "Khalid Al Marri", "tenant_admin", T0),
    ("user-sameer", "mewa_riyadh", "sameer", "Sameer Al Otaibi", "analyst", T0),
    ("user-nora", "mewa_riyadh", "nora", "Nora Al Shamrani", "tenant_admin", T0),
]

AOIS = [
    # (id, tenant_id, name, monitor_type, geojson, created_by, created_at)
    ("aoi-a-1", "dubai_municipality", "迪拜海岸带", "urban_expansion", AOI_A1, "user-ahmed", T1),
    ("aoi-a-2", "dubai_municipality", "迪拜城市边缘区", "illegal_construction", AOI_A2, "user-ahmed", T1),
    ("aoi-b-1", "mewa_riyadh", "利雅得北郊耕地片区", "farmland_non_agri", AOI_B1, "user-sameer", T1),
]

TASKS = [
    # (id, tenant_id, aoi_id, name, monitor_type, status, start/end, cloud, stage, degraded)
    ("task-a-1", "dubai_municipality", "aoi-a-1", "迪拜海岸带城市扩张监测（9 月）", "urban_expansion",
     "completed", "2025-09-01", "2026-09-01", 20,
     json.dumps({"retrievalMs": 2310, "analysisMs": 8420, "current": "completed"}), 0),
    ("task-a-2", "dubai_municipality", "aoi-a-2", "迪拜边缘区违建例行扫描", "illegal_construction",
     "retrieving", "2026-06-01", "2026-09-01", 20,
     json.dumps({"retrievalMs": 1200, "analysisMs": 0, "current": "retrieving"}), 0),
    ("task-a-3", "dubai_municipality", "aoi-a-1", "海岸带地表变化加急复核", "surface_change",
     "queued", "2026-08-01", "2026-09-20", 30, "{}", 0),
    ("task-b-1", "mewa_riyadh", "aoi-b-1", "利雅得北郊耕地非农化监测", "farmland_non_agri",
     "completed", "2025-09-01", "2026-09-01", 20,
     json.dumps({"retrievalMs": 1980, "analysisMs": 7650, "current": "completed"}), 0),
]

# 斑块由功能代理补 fixtures；告警先以占位 patch_id 关联（不影响告警列表展示）
ALERTS = [
    ("alert-a-1", "dubai_municipality", "task-a-1", "patch-a-1", 3.2, "新增建设", "high", "pending", T2),
    ("alert-a-2", "dubai_municipality", "task-a-1", "patch-a-2", 1.8, "植被减少", "medium", "confirmed", T2),
    ("alert-b-1", "mewa_riyadh", "task-b-1", "patch-b-1", 2.4, "耕地占用", "high", "pending", T2),
]

MESSAGES = [
    ("msg-a-1", "dubai_municipality", "user-ahmed", "alert", "新告警：迪拜海岸带发现 3.2km² 新增建设",
     "任务「迪拜海岸带城市扩张监测（9 月）」产出高等级告警，请前往结果页核查。", 0, T2),
    ("msg-a-2", "dubai_municipality", "user-ahmed", "task", "任务进入检索阶段",
     "「迪拜边缘区违建例行扫描」已开始检索候选影像。", 0, T2),
    ("msg-a-3", "dubai_municipality", "user-fatima", "alert", "待审批告警 2 条",
     "您所在组织有 2 条告警待处置确认。", 1, T2),
    ("msg-a-4", "dubai_municipality", None, "system", "平台例行维护通知",
     "本周六 02:00-04:00 UTC 进行例行维护，期间任务调度暂停。", 1, T2),
    ("msg-a-5", "dubai_municipality", "user-khalid", "system", "订阅配额提醒",
     "当前套餐 AOI 面积已用约 40%，接近建议水位。", 0, T2),
    ("msg-b-1", "mewa_riyadh", "user-sameer", "alert", "新告警：利雅得北郊发现 2.4km² 耕地占用",
     "任务「利雅得北郊耕地非农化监测」产出高等级告警。", 0, T2),
]

AUDIT_LOGS = [
    ("audit-a-1", "dubai_municipality", "2026-01-15T08:30:00Z", "khalid", "订阅开通",
     "开通专业版（pro），AOI 面积上限 2500km²"),
    ("audit-a-2", "dubai_municipality", "2026-01-15T08:35:00Z", "khalid", "成员邀请",
     "邀请 ahmed（监测分析师）加入组织"),
    ("audit-a-3", "dubai_municipality", "2026-01-15T08:36:00Z", "khalid", "成员邀请",
     "邀请 fatima（决策审批者·只读）加入组织"),
    ("audit-a-4", "dubai_municipality", "2026-06-01T09:00:00Z", "ahmed", "AOI 创建",
     "创建 AOI「迪拜海岸带」"),
    ("audit-a-5", "dubai_municipality", "2026-06-01T09:20:00Z", "ahmed", "任务创建",
     "创建任务「迪拜海岸带城市扩张监测（9 月）」"),
    ("audit-a-6", "dubai_municipality", "2026-09-20T10:00:00Z", "ahmed", "告警处置",
     "确认告警 alert-a-2（植被减少 1.8km²）"),
]


def seed() -> None:
    """幂等灌入种子数据；空库灌全量，已有库跳过（INSERT OR IGNORE）。"""
    with db() as conn:
        conn.executemany(
            "INSERT OR IGNORE INTO tenants(id, code, name, created_at) VALUES (?,?,?,?)",
            [
                ("dubai_municipality", "dubai_municipality", "迪拜市政厅·规划监察", T0),
                ("mewa_riyadh", "mewa_riyadh", "沙特 MEWA·利雅得", T0),
            ],
        )
        conn.executemany(
            "INSERT OR IGNORE INTO plans(id, name, area_limit_km2, monitor_type_count, monitor_types,"
            " revisit, seats, max_concurrent_tasks, data_source_note) VALUES (?,?,?,?,?,?,?,?,?)",
            [(p["id"], p["name"], p["area_limit_km2"], p["monitor_type_count"], p["monitor_types"],
              p["revisit"], p["seats"], p["max_concurrent_tasks"], p["data_source_note"]) for p in PLANS],
        )
        conn.executemany(
            "INSERT OR IGNORE INTO users(id, tenant_id, username, name, role, joined_at) VALUES (?,?,?,?,?,?)",
            USERS,
        )
        conn.executemany(
            "INSERT OR IGNORE INTO subscriptions(id, tenant_id, plan_id, status, started_at, renewal_at)"
            " VALUES (?,?,?,?,?,?)",
            [
                ("sub-a", "dubai_municipality", "pro", "active", T0, RENEWAL),
                ("sub-b", "mewa_riyadh", "basic", "active", T0, RENEWAL),
            ],
        )
        # AOI 面积由校验工具按 GeoJSON 实算，保证 usage 数字与几何一致
        for aoi_id, tenant_id, name, monitor_type, geojson, created_by, created_at in AOIS:
            _, area_km2 = validate_polygon(geojson)
            conn.execute(
                "INSERT OR IGNORE INTO aois(id, tenant_id, name, monitor_type, area_km2, geojson,"
                " created_by, created_at) VALUES (?,?,?,?,?,?,?,?)",
                (aoi_id, tenant_id, name, monitor_type, area_km2,
                 json.dumps(geojson), created_by, created_at),
            )
        conn.executemany(
            "INSERT OR IGNORE INTO tasks(id, tenant_id, aoi_id, name, monitor_type, status, start_date,"
            " end_date, cloud_max_pct, stage, degraded, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [t + (T1, T1) for t in TASKS],
        )
        conn.executemany(
            "INSERT OR IGNORE INTO alerts(id, tenant_id, task_id, patch_id, area_km2, change_type,"
            " level, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ALERTS,
        )
        conn.executemany(
            "INSERT OR IGNORE INTO messages(id, tenant_id, user_id, type, title, body, read, created_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            MESSAGES,
        )
        conn.executemany(
            "INSERT OR IGNORE INTO audit_logs(id, tenant_id, at, actor, action, detail)"
            " VALUES (?,?,?,?,?,?)",
            AUDIT_LOGS,
        )
    logger.info("种子数据已就绪（幂等）")


def init_database() -> None:
    """建表 + 种子：应用启动（lifespan）与测试 fixture 共用入口。"""
    from app.db.sqlite import init_schema
    from app.fixtures.change_results import seed_task_fixtures
    init_schema()
    seed()
    # 变化斑块与影像景 fixtures（契约 §7 允许由功能层补齐）：为种子任务幂等灌入
    seed_task_fixtures()
