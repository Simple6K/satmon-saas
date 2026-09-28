# 卫星遥感监测 SaaS 平台

面向政府客户（中东城市场景：迪拜、利雅得）的多租户区域监测订阅服务。
客户圈定关注区域（AOI）按月订阅，平台自动检索公开卫星影像、执行变化检测、
产出告警与可导出报告——**无需自建遥感团队**。

> 演示环境：双租户（迪拜市政厅 / 沙特 MEWA）× 三级角色，数据为种子数据
> 叠加真实公开卫星影像（Copernicus / NASA GIBS / USGS / Esri，全部免登录）。

## 快速启动（Docker 一条命令）

前置要求：Docker Engine 24+ 与 Docker Compose v2（Linux 原生安装，macOS 经
Docker Desktop / OrbStack / colima 均可）。

```bash
git clone <本仓库地址> && cd 卫星遥感监测SaaS平台MVP   # 或直接进入已获取的项目目录
docker compose up -d --build
```

启动完成后访问 **http://localhost:8080**（首次构建需拉取基础镜像与 npm/uv 依赖，
视网络 3–10 分钟；容器内已含编译好的前端与全部后端依赖，不依赖宿主机任何环境）。

## 演示账号（登录页点击即进入）

| 账号 | 租户 | 角色 | 看点 |
|---|---|---|---|
| **Ahmed** | 迪拜市政厅 · 规划监察 | 监测分析师 | 全功能主链路（推荐由此开始） |
| Khalid | 迪拜市政厅 · 规划监察 | 租户管理员 | 订阅/成员/审计日志 |
| Fatima | 迪拜市政厅 · 规划监察 | 决策审批者（只读） | 写操作 403 拦截演示 |
| Sameer / Nora | 沙特 MEWA · 利雅得 | 分析师 / 管理员 | 数据隔离对比（跨租户 404） |

**推荐体验路线**：Ahmed 登录 → 工作台 → 监测任务三步向导（「预估可用影像」
真实调用 Copernicus，可切「模拟 OData 超时」看降级链）→ 结果查看（斑块举证）→
报告中心（统计矩阵 + 前后时相真实影像 + PDF 导出）→ 订阅管理（隔离一键自检）。

## 常用命令

```bash
docker compose ps                  # 状态（backend 应显示 healthy）
docker compose logs -f backend     # 后端日志（前端日志：frontend）
docker compose restart             # 重启
docker compose down                # 停止（数据保留在 named volume）
docker compose down -v             # 停止并清空数据（重新灌种子数据）

# 改代码后更新容器（容器内是编译产物快照，不会热更新）
docker compose build frontend && docker compose up -d frontend
docker compose build backend  && docker compose up -d backend
```

## 本地开发模式（不用 Docker）

后端（Python 3.12 + uv）：

```bash
cd satmon_backend
uv sync
bash app.sh start --env local       # :8000，测试：ENV_NAME=local .venv/bin/python -m pytest tests/ -q
```

前端（Node 20+）：

```bash
cd frontend
npm install
npm run dev                          # :5173，/api 自动代理到 :8000
```

## 仓库结构

```
satmon_backend/   FastAPI + SQLite + APScheduler（含 vendored anntoconfig/anntologger）
frontend/         React 19 + Vite 7 + AntD 6 + Leaflet（GIBS/Esri 影像，瓦片并发≤6）
docker-compose.yml / satmon_backend/Dockerfile / frontend/Dockerfile+nginx.conf
API-CONTRACT.md   前后端接口契约（改动须两侧同步）
PRD-卫星遥感监测SaaS平台MVP.md    产品需求文档（用户画像/故事/架构/流程）
技术选型报告.md   技术栈决策与实测依据
产品介绍.md       对外介绍（9 章节 + 截图）
```

## 已知边界（如实说明）

- **登录为 mock 演示账号**（无密码），不可直接对公网开放；正式部署需先接入真实认证。
- 报告举证影像的「Esri Wayback 高清历史层」按网络自动探测：部分网络不可达时
  自动降级 GIBS MODIS 250m 并在界面明确标注（功能不受损）。
- 变化检测结果为演示种子数据（真实像素级分析属 V2 范围，见 PRD MVP 裁剪逻辑）；
  影像检索、底图、举证影像均为真实公开数据源实时调用。
- 后端 APScheduler 为进程内单例，部署必须单 worker（compose/Dockerfile 已按此配置）。

## 环境说明

容器内后端以 `ENV_NAME=prod` 运行（叠加 `config_files/application_prod.yaml`）；
本地开发用 `--env local`。数据源超时/降级策略、SLA 实测数字见《技术选型报告.md》。
