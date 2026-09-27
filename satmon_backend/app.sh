#!/bin/bash
# satmon_backend - Operations Script
# Usage: bash app.sh {start|stop|restart|status} [--env <env>]

APP_NAME="satmon_backend"
APP_MODULE="satmon_backend:app"
HOST="${APP_HOST:-0.0.0.0}"
PORT="${APP_PORT:-8000}"
PID_FILE="${APP_NAME}.pid"
LOG_FILE="${APP_NAME}.log"

# 优先用项目 .venv 的 uvicorn（依赖只装在 .venv），不存在则回退全局并告警
UVICORN_BIN=".venv/bin/uvicorn"
if [[ ! -x "$UVICORN_BIN" ]]; then
    UVICORN_BIN="uvicorn"
    echo "[$APP_NAME] WARN: .venv/bin/uvicorn 不存在，回退全局 uvicorn"
fi

# Default environment
ENV="local"

# Parse arguments
ACTION=""
while [[ $# -gt 0 ]]; do
    case $1 in
        start|stop|restart|status)
            ACTION=$1
            shift
            ;;
        --env)
            ENV=$2
            shift 2
            ;;
        *)
            echo "Unknown argument: $1"
            exit 1
            ;;
    esac
done

if [[ -z "$ACTION" ]]; then
    echo "Usage: bash app.sh {start|stop|restart|status} [--env <local|ver|sit|uat|prod>]"
    exit 1
fi

export APP_ENV="$ENV"
# anntoconfig 需要 ENV_NAME 指明环境；local 不叠加 overlay 配置文件
if [[ -z "${ENV_NAME:-}" ]]; then
    case "$ENV" in
        local) export ENV_NAME="local" ;;
        *) export ENV_NAME="$ENV" ;;
    esac
fi

start() {
    if [[ -f "$PID_FILE" ]]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "[$APP_NAME] Already running (PID: $PID)"
            return 1
        fi
        rm -f "$PID_FILE"
    fi

    echo "[$APP_NAME] Starting with env=$ENV on $HOST:$PORT ..."
    nohup "$UVICORN_BIN" "$APP_MODULE" \
        --host "$HOST" \
        --port "$PORT" \
        > "$LOG_FILE" 2>&1 &

    echo $! > "$PID_FILE"
    sleep 1

    if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "[$APP_NAME] Started (PID: $(cat "$PID_FILE"))"
    else
        echo "[$APP_NAME] Failed to start. Check $LOG_FILE for details."
        rm -f "$PID_FILE"
        return 1
    fi
}

stop() {
    if [[ -f "$PID_FILE" ]]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "[$APP_NAME] Stopping (PID: $PID) ..."
            kill "$PID"
            sleep 2
            if kill -0 "$PID" 2>/dev/null; then
                kill -9 "$PID"
            fi
            rm -f "$PID_FILE"
            echo "[$APP_NAME] Stopped"
        else
            echo "[$APP_NAME] Process not found (PID: $PID)"
            rm -f "$PID_FILE"
        fi
    else
        echo "[$APP_NAME] Not running (no PID file)"
    fi
}

status() {
    if [[ -f "$PID_FILE" ]]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "[$APP_NAME] Running (PID: $PID, env: $ENV)"
        else
            echo "[$APP_NAME] Not running (stale PID: $PID)"
        fi
    else
        echo "[$APP_NAME] Not running"
    fi
}

case "$ACTION" in
    start)
        start
        ;;
    stop)
        stop
        ;;
    restart)
        stop
        start
        ;;
    status)
        status
        ;;
esac
