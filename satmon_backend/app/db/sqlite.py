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
-- 在此定义建表语句，例如：
-- CREATE TABLE IF NOT EXISTS example_items (
--   id TEXT PRIMARY KEY, payload TEXT NOT NULL DEFAULT '', created_at TEXT
-- );
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
