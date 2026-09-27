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


class ApiHTTPException(Exception):
    """携带业务码与 data 的 HTTP 异常。

    与 BusinessException（HTTP 200 返回）不同，本异常保留真实 HTTP 状态码，
    用于契约要求「400 带 usage」「跨租户 404」「权限 403」等场景，
    使前端既拿到状态码又拿到统一信封 {code, msg, data}。
    """

    def __init__(self, status_code: int, code: int, msg: str, data=None):
        self.status_code = status_code
        self.code = code
        self.msg = msg
        self.data = data
        super().__init__(msg)
