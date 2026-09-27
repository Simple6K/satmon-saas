"""
中间件目录（Middlewares）

用于存放 FastAPI/Starlette 中间件，常见示例：
- 公共字段自动捕获（user_id / timestamp / request_id）
- 接口用时记录（X-Response-Time）
- Body 记录 + 启停控制

使用方式：在 app/server/app.py 中通过 app.add_middleware() 注册。
"""
