from pydantic import BaseModel, Field


class ExampleRequest(BaseModel):
    """示例请求模型。"""
    name: str = Field(..., description="名称", min_length=1, max_length=100)
    description: str = Field(default="", description="描述", max_length=500)


class ExampleResponse(BaseModel):
    """示例响应模型。"""
    id: int = Field(..., description="ID")
    name: str = Field(..., description="名称")
    description: str = Field(default="", description="描述")
