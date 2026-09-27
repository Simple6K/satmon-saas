from app.api.common.response import StatusCode


class BusinessException(Exception):
    """业务异常基类。"""

    def __init__(self, code: int = StatusCode.BUSINESS_ERROR, msg: str = "业务异常"):
        self.code = code
        self.msg = msg
        super().__init__(msg)


class ExampleException(BusinessException):
    """示例业务异常。"""

    def __init__(self, msg: str = "示例业务异常"):
        super().__init__(code=StatusCode.BUSINESS_ERROR, msg=msg)
