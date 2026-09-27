import pytest
from httpx import ASGITransport, AsyncClient

from app.server.app import create_app


@pytest.fixture
def app():
    return create_app()


@pytest.fixture
async def client(app):
    # ASGITransport 不触发 lifespan：调度器不会启动、库表不会初始化——
    # 需要库表的测试请配合下方 temp_db fixture（或在 fixture 中显式 init_schema()）。
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.fixture(autouse=True)
def temp_db(tmp_path, monkeypatch):
    """测试库指向临时目录，避免污染真实 data/*.db。

    注意：DB_PATH 必须经模块属性访问（db 模块内不用 from-import 提前绑定），
    monkeypatch 才能生效。
    """
    from app.db import sqlite as sqlite_store

    monkeypatch.setattr(sqlite_store, "DB_PATH", tmp_path / "app.db")
    sqlite_store.init_schema()
    yield
