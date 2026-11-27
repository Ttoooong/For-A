"""行情源抽象。"""

from __future__ import annotations

import abc
from typing import Dict, List

from ..models import Quote


class QuoteSource(abc.ABC):
    """所有行情适配器的统一接口。

    实现约定：

    * ``fetch`` 接受统一格式的代码（``600519.SH``），返回 ``{code: Quote}``；
    * 单个代码失败不要抛出，应跳过并在 ``Aggregator`` 里记录错误；
    * 时间戳一律换算成本地时间，不做时区转换。
    """

    name: str = "base"

    @abc.abstractmethod
    def fetch(self, codes: List[str]) -> Dict[str, Quote]:
        """批量拉取行情。"""

    def close(self) -> None:
        """释放底层连接。"""
