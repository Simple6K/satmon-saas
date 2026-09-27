# API 契约（前后端共同遵守，改动须经双方在场）

> v1.0 · 2026-09-27 · 依据 PRD 与技术选型报告定稿
> 后端：satmon_backend（FastAPI，前缀 `/api`）；前端：frontend（仅经此契约访问后端，禁止直 fetch 后端未契约化路径）

## 0. 通用约定

- **信封**：`{code, msg, data, timestamp}`；`code=0` 成功；错误码沿用脚手架 handler（400→1003、404→2001 等），HTTP 状态码保留
- **认证**：`Authorization: Bearer <token>`；MVP 用 mock token（见 §7 种子账号）。token 内含 tenantId+userId+role
- **租户隔离**：一切资源按 token 的 tenantId 过滤；跨租户资源 ID 返回 **404**（不泄露存在性，对齐 PRD US-11）
- **角色**：`tenant_admin` / `analyst` / `approver`（只读）。写操作（POST/PUT/DELETE 任务、AOI、成员、订阅变更）要求 analyst 或 tenant_admin；approver 仅 GET
- **降级演示**：请求头 `X-Debug-Fail: odata|stac|all` 使对应外部源适配器模拟超时（返回降级路径结果），用于现场一键演示 PRD 5.2
- **时间**：ISO8601 UTC 字符串
- **CORS**：后端允许 `http://localhost:5173`（Vite dev）

## 1. 认证

- `POST /api/auth/login` `{username}` → `{token, user: {id, name, role, tenantId, tenantName}}`（MVP 免密，用户名须在种子表内，否则 401）
- `GET /api/me` → 同 login 的 user

## 2. 订阅（PRD 3.1 US-01/02/12）

- `GET /api/plans` → 三档：`basic`（≤500km²、1 类监测、月度重访）/ `pro`（≤2500km²、2 类、月度+季度加急）/ `flagship`（≤10000km²、4 类、双周）；各含 `seats`、`maxConcurrentTasks` 附属配额
- `GET /api/subscription` → 当前租户订阅：`{planId, status, startedAt, renewalAt, usage: {aoiAreaKm2, aoiAreaLimitKm2, concurrentTasks, concurrentLimit, activeTaskCount}}`
- `PUT /api/subscription/plan` `{planId}` → 变更后的 subscription（写审计日志）
- `GET /api/subscription/members` → `[{id, name, role, joinedAt}]`
- `POST /api/subscription/members` `{name, role}` → 新成员（tenant_admin 专属）
- `GET /api/audit-logs?limit=50` → `[{at, actor, action, detail}]`（订阅变更/任务创建/告警处置等）

## 3. AOI（US-03）

- `GET /api/aois` → `[{id, name, areaKm2, monitorType, createdAt, geojson}]`（Polygon GeoJSON）
- `POST /api/aois` `{name, monitorType, geojson}` → 创建；服务端用 shapely 校验：有效闭合多边形、面积 ≤ 剩余额度（4326 面积计算），不合法返回 400 + 具体原因
- `PUT /api/aois/{id}` / `DELETE /api/aois/{id}` 同理
- `monitorType` 枚举：`illegal_construction` | `farmland_non_agri` | `urban_expansion` | `surface_change`（四类，对齐 PRD 1.3）

## 4. 监测任务（US-04/05/06）

- `POST /api/tasks` `{name, aoiId, monitorType, startDate, endDate, cloudMaxPct}` → 任务 `{id, status: "queued"}`；校验并发/面积配额，超限 400 带 usage
- `GET /api/tasks?status=` → `[{id, name, monitorType, aoiName, status, createdAt, stage, degraded}]`；status 枚举 `queued/retrieving/analyzing/completed/failed/cancelled`；`stage` 为 `{retrievalMs, analysisMs, current}` 分阶段耗时
- `GET /api/tasks/{id}` → 详情（含 AOI geojson、时间窗、数据源结果摘要）
- `POST /api/tasks/{id}/cancel` → 取消（仅 queued/retrieving 可取消，3s 内生效语义）
- `POST /api/tasks/{id}/estimate` → **真实检索预演**：调 Copernicus OData（8s 硬超时，`X-Debug-Fail: odata` 时直接超时）→ 失败降级 USGS STAC（经服务端转发，无 CORS 问题）→ 双败返回 `{source: null, fallbackUsed: true, reason}`；成功返回 `{source: "odata"|"stac", totalScenes, scenes: [{id, sensingDate, cloudPct, tileId}], degraded: bool}`。MGRS：迪拜 42RVR、利雅得 38RKR/38RKS（由 AOI 质心判定）
- 任务执行：APScheduler 每 30s 扫 queued 任务推进状态机（retrieving→analyzing→completed），变化检测结果来自**预缓存 fixtures**（像素级分析不做，对齐 MVP Out-of-Scope）

## 5. 结果与告警（US-07/08/10/11）

- `GET /api/tasks/{id}/results` → `{taskId, stats: {patchCount, totalAreaKm2, byType}, geojson: FeatureCollection}`；斑块属性 `{patchId, areaKm2, confidence(0-1), changeType, beforeDate, afterDate, alertLevel}`；坐标围绕迪拜（55.1,25.0 附近）/利雅得（46.7,24.8 附近）手工构造
- `GET /api/tasks/{id}/results/{patchId}` → 举证详情 `{contextLayers: {worldcover: "available", worldpop: "available", imerg: "available_2km", poi: "unavailable"}}`（POI 标记不可用即降级演示点）
- `GET /api/alerts` → `[{id, taskId, patchId, areaKm2, changeType, level, status, createdAt}]`；status: `pending/confirmed/field_check/dismissed`
- `PUT /api/alerts/{id}/status` `{status}` → 处置闭环（写审计）
- `GET /api/messages` → 消息中心 `[{id, type: "alert|system|task", title, body, read, createdAt}]`
- `PUT /api/messages/{id}/read`

## 6. 报告（US-09）

- `POST /api/reports` `{taskId}` → `{id, taskId, generatedAt, sections}`；sections 含：概览（任务信息/时间窗/数据源）、统计表（byType 面积与数量、Top10 斑块）、方法学附注（数据源+分辨率+局限）。PDF 由前端 print-CSS/jsPDF 生成，后端只供数据
- `GET /api/reports` / `GET /api/reports/{id}`

## 7. 种子数据（SQL/fixture 于启动时幂等灌入 SQLite）

租户 A `dubai_municipality`（迪拜市政厅·规划监察）：用户 ahmed(analyst)/fatima(approver)/khalid(tenant_admin)；订阅 pro；AOI 2 个（迪拜海岸带、城市边缘区）；任务 3 个（1 completed 含结果、1 retrieving、1 queued）；告警 2 条；消息 5 条；审计 6 条。
租户 B `mewa_riyadh`（沙特 MEWA·利雅得）：用户 sameer(analyst)/nora(tenant_admin)；订阅 basic；AOI 1 个（利雅得北郊耕地片区）；任务 1 个 completed；告警 1 条。
计划任务状态机、消息提醒由 scheduler 驱动。

## 8. 外部数据源适配（服务端）

- Copernicus OData：`https://catalogue.dataspace.copernicus.eu/odata/v1/Products`，GET，`$filter` 含 ContentDate、CloudCover、Online eq true；httpx AsyncClient，8s 超时，重试 0 次
- USGS STAC：`https://landsatlook.usgs.gov/stac-server/search`，POST search，8s 超时（服务端转发无 CORS 限制）
- 禁止无边界重试；失败逐级降级并如实标注 `degraded/fallbackUsed`（对齐 PRD 5.2 与工程原则 4）
- IMERG 必须 2km、VIIRS PNG 无日期、Overpass 用 maps.mail.ru 镜像——这些约束出现在任何前端图层常量时照抄，不得改参
