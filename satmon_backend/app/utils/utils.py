import hashlib
import json
from typing import Any


def compute_hash(data: Any) -> str:
    """计算任意 JSON 可序列化数据的 MD5 哈希值。"""
    raw = json.dumps(data, sort_keys=True, default=str)
    return hashlib.md5(raw.encode()).hexdigest()
