"""任务状态机（契约 §4）：queued → retrieving → analyzing → completed。

由 APScheduler 每 30s 扫描推进（app/jobs/scheduler.py），每 tick 每任务
前进一步。影像景与变化检测结果取 fixtures 预缓存数据（MVP 不做像素级
分析，对齐 PRD Out-of-Scope）；分阶段耗时取演示固定值——不做真实耗时
统计，数值量级与种子任务一致（检索 ~2s、分析 ~8s）。

完成时的下游动作：写入斑块（幂等）→ 高等级斑块生成 pending 告警 →
租户内广播任务完成 / 告警消息（US-06/US-10 的消息由调度驱动）。
"""

import json
import uuid
from datetime import datetime, timezone

from app.db.sqlite import db
from app.fixtures.change_results import build_patches, region_of, scenes_for_region
from app.log.log import logger
from app.utils.geo import centroid_and_bbox

# 状态机单步迁移表；failed/cancelled/completed 为终态
NEXT_STATUS = {"queued": "retrieving", "retrieving": "analyzing", "analyzing": "completed"}

# 演示固定耗时（ms）：与种子任务同量级
_RETRIEVAL_MS = 2240
_ANALYSIS_MS = 8110

# 触发告警的斑块等级（契约 §5：告警来自高等级变化斑块）
_ALERT_LEVELS = ("high", "medium")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def advance_tasks() -> None:
    """扫描所有非终态任务，各推进一步。scheduler 与测试直接调用。"""
    with db() as conn:
        rows = conn.execute(
            "SELECT t.id, t.tenant_id, t.status FROM tasks t"
            " WHERE t.status IN ('queued','retrieving','analyzing')"
        ).fetchall()
        ids = [(r["id"], r["tenant_id"], r["status"]) for r in rows]
    for task_id, tenant_id, status in ids:
        try:
            _advance_one(task_id, tenant_id, status)
        except Exception as e:  # noqa: BLE001 单任务失败不阻断本轮其他任务
            logger.error("任务 %s 状态推进失败: %s", task_id, e)


def _advance_one(task_id: str, tenant_id: str, status: str) -> None:
    next_status = NEXT_STATUS[status]
    with db() as conn:
        # 重读状态：本轮内可能已被取消（queued/retrieving 可取消），以库内为准
        row = conn.execute(
            "SELECT status FROM tasks WHERE id = ? AND tenant_id = ?", (task_id, tenant_id)
        ).fetchone()
        if row is None or row["status"] not in NEXT_STATUS or row["status"] != status:
            return

        if next_status == "retrieving":
            _fill_scenes(conn, task_id, tenant_id)
            stage = {"retrievalMs": 0, "analysisMs": 0, "current": "retrieving"}
        elif next_status == "analyzing":
            stage = {"retrievalMs": _RETRIEVAL_MS, "analysisMs": 0, "current": "analyzing"}
        else:
            stage = {"retrievalMs": _RETRIEVAL_MS, "analysisMs": _ANALYSIS_MS,
                     "current": "completed"}
            _complete_results(conn, task_id, tenant_id)

        conn.execute(
            "UPDATE tasks SET status = ?, stage = ?, updated_at = ? WHERE id = ?",
            (next_status, json.dumps(stage), _now(), task_id),
        )
    logger.info("任务 %s: %s → %s", task_id, status, next_status)


def _task_aoi_centroid(conn, task_id: str) -> tuple[float, float]:
    row = conn.execute(
        "SELECT a.geojson FROM tasks t JOIN aois a ON a.id = t.aoi_id WHERE t.id = ?",
        (task_id,),
    ).fetchone()
    (lon, lat), _ = centroid_and_bbox(json.loads(row["geojson"]))
    return lon, lat


def _fill_scenes(conn, task_id: str, tenant_id: str) -> None:
    """retrieving 步：按 AOI 所在区域灌入影像景 fixtures（幂等，先清后插防重）。"""
    lon, lat = _task_aoi_centroid(conn, task_id)
    conn.execute("DELETE FROM task_scenes WHERE task_id = ?", (task_id,))
    for sid, date, cloud, tile in scenes_for_region(region_of(lon, lat)):
        conn.execute(
            "INSERT INTO task_scenes(id, tenant_id, task_id, source, scene_id, sensing_date,"
            " cloud_pct, tile_id) VALUES (?,?,?,?,?,?,?,?)",
            (f"scene-{uuid.uuid4().hex[:12]}", tenant_id, task_id, "odata",
             sid, date, cloud, tile),
        )


def _complete_results(conn, task_id: str, tenant_id: str) -> None:
    """completed 步：写入斑块 fixtures + 高等级斑块生成告警与消息（全部幂等）。"""
    has_patches = conn.execute(
        "SELECT 1 FROM patches WHERE task_id = ? LIMIT 1", (task_id,)
    ).fetchone()
    if not has_patches:
        lon, lat = _task_aoi_centroid(conn, task_id)
        task = conn.execute(
            "SELECT name FROM tasks WHERE id = ?", (task_id,)
        ).fetchone()
        for p in build_patches(region_of(lon, lat), f"patch-{task_id[:8]}"):
            patch_id = f"{p['id']}-{uuid.uuid4().hex[:6]}"
            conn.execute(
                "INSERT INTO patches(id, tenant_id, task_id, area_km2, confidence,"
                " change_type, before_date, after_date, alert_level, geojson)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                (patch_id, tenant_id, task_id, p["area_km2"], p["confidence"],
                 p["change_type"], p["before_date"], p["after_date"],
                 p["alert_level"], json.dumps(p["geojson"])),
            )
            _maybe_create_alert(conn, tenant_id, task_id, task["name"], patch_id, p)

    # 任务完成广播（user_id 为 NULL = 租户内广播，契约 §7：消息提醒由 scheduler 驱动）
    has_done_msg = conn.execute(
        "SELECT 1 FROM messages WHERE tenant_id = ? AND type = 'task' AND body LIKE ? LIMIT 1",
        (tenant_id, f"%{task_id}%"),
    ).fetchone()
    if not has_done_msg:
        task = conn.execute("SELECT name FROM tasks WHERE id = ?", (task_id,)).fetchone()
        conn.execute(
            "INSERT INTO messages(id, tenant_id, user_id, type, title, body, read, created_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (f"msg-{uuid.uuid4().hex[:12]}", tenant_id, None, "task",
             "任务完成：变化检测结果已生成",
             f"任务「{task['name']}」（{task_id}）已完成变化检测，请前往结果页查看。",
             0, _now()),
        )


def _maybe_create_alert(conn, tenant_id: str, task_id: str, task_name: str,
                        patch_id: str, patch: dict) -> None:
    if patch["alert_level"] not in _ALERT_LEVELS:
        return
    exists = conn.execute(
        "SELECT 1 FROM alerts WHERE task_id = ? AND patch_id = ? LIMIT 1",
        (task_id, patch_id),
    ).fetchone()
    if exists:
        return
    conn.execute(
        "INSERT INTO alerts(id, tenant_id, task_id, patch_id, area_km2, change_type,"
        " level, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (f"alert-{uuid.uuid4().hex[:12]}", tenant_id, task_id, patch_id,
         patch["area_km2"], patch["change_type"], patch["alert_level"], "pending", _now()),
    )
    conn.execute(
        "INSERT INTO messages(id, tenant_id, user_id, type, title, body, read, created_at)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (f"msg-{uuid.uuid4().hex[:12]}", tenant_id, None, "alert",
         f"新告警：{patch['change_type']} {patch['area_km2']:.2f}km²",
         f"任务「{task_name}」产出 {patch['alert_level']} 等级告警"
         f"（斑块 {patch_id}，{patch['change_type']} {patch['area_km2']:.2f}km²，"
         f"基于 {patch['after_date']} 获取的 Sentinel-2 L2A 影像），请前往核查。",
         0, _now()),
    )
