"""告警出口抽象。"""

from __future__ import annotations

import abc
from typing import List

from ..models import Alert


class Alerter(abc.ABC):
    """告警投递通道。"""

    name: str = "alerter"

    @abc.abstractmethod
    def send(self, alerts: List[Alert]) -> None:
        """投递告警；失败应记录日志而不是抛出，避免中断监控循环。"""
