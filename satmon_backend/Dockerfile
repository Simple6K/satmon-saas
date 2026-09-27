FROM python:3.12-slim

WORKDIR /app

# 安装 uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# 复制项目文件
COPY pyproject.toml .
COPY app/ app/
COPY config_files/ config_files/
COPY satmon_backend.py .
COPY app.sh .

# 安装依赖（镜像源已在 pyproject.toml 的 [[tool.uv.index]] 中配置）
RUN uv sync --no-dev

EXPOSE 8000

CMD ["bash", "app.sh", "start", "--env", "prod"]
