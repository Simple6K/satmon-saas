"""本地 SQLite 存储层（stdlib sqlite3，零外部依赖）。

适用：本地汇总/缓存类数据（提取缓存、判定缓存、指标汇总），不适用高并发写入。
实战约定（源自指标服务项目）：
- WAL 模式 + busy_timeout，短连接上下文自动 commit/rollback/close
- 建表全部 CREATE TABLE IF NOT EXISTS，init_schema() 幂等，可在应用启动（lifespan）时调用
- 查询函数一律接收 conn 作为第一参数，由调用方开 with db() 上下文
- 测试用 monkeypatch DB_PATH 到 tmp_path 实现库隔离（见 tests/conftest.py 的 temp_db fixture）
"""

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path("data") / "app.db"

_SCHEMA = """
-- 多租户业务表。约定：一切租户资源表均带 tenant_id，查询一律按 token 的
-- tenantId 过滤；跨租户资源 ID 由 API 层统一返回 404（code 2001，契约 §0）。
-- AOI 与变化斑块的 GeoJSON 以文本存储（MVP 不引入空间扩展）。

CREATE TABLE IF NOT EXISTS tenants (
  id         TEXT PRIMARY KEY,            -- 如 dubai_municipality
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  username  TEXT NOT NULL UNIQUE,          -- MVP 免密登录的用户名（契约 §1）
  name      TEXT NOT NULL,
  role      TEXT NOT NULL CHECK (role IN ('tenant_admin', 'analyst', 'approver')),
  joined_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

CREATE TABLE IF NOT EXISTS plans (
  id                   TEXT PRIMARY KEY,   -- basic / pro / flagship
  name                 TEXT NOT NULL,
  area_limit_km2       REAL NOT NULL,      -- AOI 总面积上限
  monitor_type_count   INTEGER NOT NULL,   -- 可选监测类型数
  monitor_types        TEXT NOT NULL,      -- 类型说明（逗号分隔）
  revisit              TEXT NOT NULL,      -- 重访频率
  seats                INTEGER NOT NULL,   -- 席位数
  max_concurrent_tasks INTEGER NOT NULL,   -- 并发任务上限
  data_source_note     TEXT NOT NULL       -- 数据源能力披露（对齐 US-01 验收）
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  plan_id    TEXT NOT NULL REFERENCES plans(id),
  status     TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL,
  renewal_at TEXT NOT NULL
);
-- 一个租户一条当前订阅（MVP 无续费历史表，变更历史走审计日志）
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_tenant ON subscriptions(tenant_id);

CREATE TABLE IF NOT EXISTS aois (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  name         TEXT NOT NULL,
  monitor_type TEXT NOT NULL CHECK (monitor_type IN
    ('illegal_construction', 'farmland_non_agri', 'urban_expansion', 'surface_change')),
  area_km2     REAL NOT NULL,
  geojson      TEXT NOT NULL,              -- Polygon GeoJSON 文本
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aois_tenant ON aois(tenant_id);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  aoi_id        TEXT NOT NULL REFERENCES aois(id),
  name          TEXT NOT NULL,
  monitor_type  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN
    ('queued', 'retrieving', 'analyzing', 'completed', 'failed', 'cancelled')),
  start_date    TEXT NOT NULL,             -- 监测时间窗起
  end_date      TEXT NOT NULL,             -- 监测时间窗止
  cloud_max_pct INTEGER NOT NULL DEFAULT 20,
  stage         TEXT NOT NULL DEFAULT '{}', -- 分阶段耗时 JSON（retrievalMs/analysisMs/current）
  degraded      INTEGER NOT NULL DEFAULT 0, -- 是否处于降级态
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS task_scenes (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  source       TEXT NOT NULL,              -- odata / stac
  scene_id     TEXT NOT NULL,
  sensing_date TEXT NOT NULL,
  cloud_pct    REAL NOT NULL,
  tile_id      TEXT NOT NULL               -- MGRS：迪拜 42RVR、利雅得 38RKR/38RKS
);
CREATE INDEX IF NOT EXISTS idx_task_scenes_task ON task_scenes(task_id);

CREATE TABLE IF NOT EXISTS patches (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  area_km2    REAL NOT NULL,
  confidence  REAL NOT NULL,               -- 0-1
  change_type TEXT NOT NULL,
  before_date TEXT NOT NULL,
  after_date  TEXT NOT NULL,
  alert_level TEXT NOT NULL,               -- 如 high/medium/low
  geojson     TEXT NOT NULL                -- 斑块 Polygon GeoJSON 文本
);
CREATE INDEX IF NOT EXISTS idx_patches_task ON patches(task_id);

CREATE TABLE IF NOT EXISTS alerts (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  patch_id    TEXT NOT NULL,
  area_km2    REAL NOT NULL,
  change_type TEXT NOT NULL,
  level       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'field_check', 'dismissed')),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_tenant ON alerts(tenant_id);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  user_id    TEXT,                         -- NULL 表示租户内广播
  type       TEXT NOT NULL CHECK (type IN ('alert', 'system', 'task')),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  read       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  at        TEXT NOT NULL,
  actor     TEXT NOT NULL,                 -- 操作人用户名
  action    TEXT NOT NULL,                 -- 如 订阅变更/任务创建/告警处置
  detail    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant ON audit_logs(tenant_id);

CREATE TABLE IF NOT EXISTS reports (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  generated_at TEXT NOT NULL,
  sections     TEXT NOT NULL               -- 报告章节 JSON（概览/统计表/方法学附注，契约 §6）
);
CREATE INDEX IF NOT EXISTS idx_reports_tenant ON reports(tenant_id);
"""


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


@contextmanager
def db():
    """短连接上下文；写入自动提交，异常回滚。"""
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_schema() -> None:
    with db() as conn:
        conn.executescript(_SCHEMA)


def query_all(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> list[dict]:
    """SELECT 帮手：返回 list[dict]（sqlite3.Row 转字典）。"""
    return [dict(r) for r in conn.execute(sql, params)]


def atomic_replace(path: Path, text: str) -> None:
    """原子写文件（先写 .tmp 再 mv），避免读方看到半截内容。"""
    tmp = path.with_suffix(path.suffix + ".tmp")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)
