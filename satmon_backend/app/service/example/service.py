from app.log.log import logger
from app.service.example.schema import ExampleRequest, ExampleResponse


async def create_example(request: ExampleRequest) -> ExampleResponse:
    """示例业务逻辑：创建示例条目。"""
    logger.info(f"创建示例: {request.name}")
    return ExampleResponse(
        id=1,
        name=request.name,
        description=request.description,
    )


async def get_example(example_id: int) -> ExampleResponse:
    """示例业务逻辑：根据 ID 获取示例。"""
    logger.info(f"获取示例: {example_id}")
    return ExampleResponse(
        id=example_id,
        name="example",
        description="An example entry",
    )
