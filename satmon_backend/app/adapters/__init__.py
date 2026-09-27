"""外部数据源适配层（契约 §8）。

职责边界：每个适配器只做一件事——把某个外部源的原始 DTO 在边界处
校验并转换为统一的 Scene 领域模型，向上层隐藏源差异。外部响应视为
不可信：字段缺失 / 类型异常的条目直接丢弃（跳过），绝不让脏数据击穿
到业务层，也不让适配器本身抛出非 SourceUnavailable 的异常。

两源共用 Scene 与 SourceUnavailable，此外不共享任何实现（在线源只有
2 个，不为想象的第三个源预先抽象公共客户端基类）。
"""

from dataclasses import dataclass


@dataclass
class Scene:
    """检索到的影像景（领域模型，契约 §4 estimate 的 scenes 单条对应体）。"""

    id: str
    sensing_date: str          # YYYY-MM-DD
    cloud_pct: float | None    # 外部源可能缺失云量字段，允许 None
    tile_id: str               # MGRS：迪拜 42RVR、利雅得 38RKR/38RKS


class SourceUnavailable(Exception):  # noqa: N818 域语义命名（数据源不可达），不用 Error 后缀
    """外部数据源不可达 / 超时 / 5xx / 响应体不可解析。

    适配器对外唯一异常类型；上层据此走降级链，绝不在此内部重试
    （契约 §8：禁止无边界重试）。
    """
