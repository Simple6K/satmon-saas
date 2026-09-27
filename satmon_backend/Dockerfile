FROM python:3.12-slim

WORKDIR /app

# 安装 uv（走公网 PyPI 镜像，避免 ghcr.io 在部分网络不可达）
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple uv

# 先复制依赖清单以利用构建缓存
COPY pyproject.toml uv.lock ./

# 源码：app + vendored 内部包 + 入口 + 配置（README 为 hatchling 必需）
COPY app/ app/
COPY anntoconfig/ anntoconfig/
COPY anntologger/ anntologger/
COPY satmon_backend.py README.md ./
COPY config_files/ config_files/

# 安装依赖（索引源在 pyproject [[tool.uv.index]] 已指向公网镜像）
RUN uv sync --frozen --no-dev

# SQLite 与日志由 volume 持久化（/app/data、/app/logs）
VOLUME ["/app/data", "/app/logs"]

EXPOSE 8000

# 容器内必须前台运行：app.sh 的 nohup 后台模式会让 PID 1 退出
ENV ENV_NAME=prod
CMD ["/app/.venv/bin/uvicorn", "satmon_backend:app", "--host", "0.0.0.0", "--port", "8000"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/app/.venv/bin/python", "-c", "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/api/health/live', timeout=4)"]
