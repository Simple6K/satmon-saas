# satmon_backend

卫星遥感监测 SaaS 平台后端（多租户订阅/监测任务/影像检索/变化检测/报告）

## Quick Start

```bash
# Install dependencies
uv sync

# Start development server
bash app.sh start --env local

# Health check
curl http://localhost:8000/health/live
```

## Project Structure

```
satmon_backend/
├── pyproject.toml          # Project config & dependencies
├── Dockerfile              # Container build
├── app.sh                  # Ops script (start/stop/restart/status)
├── config_files/           # Multi-environment configs
├── app/
│   ├── api/                # API layer (routes, response, exceptions)
│   ├── core/               # Core layer (middlewares, utils)
│   ├── config/             # Config management (anntoconfig)
│   ├── log/                # Logging (anntologger)
│   ├── server/             # FastAPI instance & router
│   ├── service/            # Business logic
│   └── utils/              # Project utilities
└── tests/                  # Test cases
```

## API

- `GET /health/live` - Liveness check
- `GET /health/ready` - Readiness check

## Environment Config

| Env   | Config File              |
|-------|--------------------------|
| local | application.yaml         |
| ver   | application_ver.yaml     |
| sit   | application_sit.yaml     |
| uat   | application_uat.yaml     |
| prod  | application_prod.yaml    |

## Operations

```bash
bash app.sh start   --env <local|ver|sit|uat|prod>
bash app.sh stop
bash app.sh restart --env <local|ver|sit|uat|prod>
bash app.sh status
```
