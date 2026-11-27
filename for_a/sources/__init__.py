"""行情/公告数据源注册表。"""

from __future__ import annotations

from typing import Dict, Type

from .base import QuoteSource
from .cninfo import CninfoSource
from .eastmoney import EastmoneySource
from .sina import SinaSource
from .tencent import TencentSource

__all__ = [
    "QuoteSource",
    "TencentSource",
    "SinaSource",
    "EastmoneySource",
    "CninfoSource",
    "build_source",
    "SOURCE_NAMES",
]

SOURCE_NAMES = ("tencent", "sina", "eastmoney", "cninfo")


def build_source(name: str, client) -> QuoteSource:
    """按名称构造数据源实例。"""
    registry: Dict[str, Type[QuoteSource]] = {
        "tencent": TencentSource,
        "sina": SinaSource,
        "eastmoney": EastmoneySource,
        "cninfo": CninfoSource,
    }
    if name not in registry:
        raise ValueError(f"未知数据源: {name}，可选: {', '.join(SOURCE_NAMES)}")
    return registry[name](client)
