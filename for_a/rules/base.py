"""规则引擎基类。"""

from __future__ import annotations

import abc
from dataclasses import dataclass
from datetime import datetime
from typing import List, Optional

from ..models import Alert, Announcement, Quote
from ..storage import Storage


@dataclass
class RuleContext:
    """规则执行上下文。"""

    storage: Storage
    now: datetime


class Rule(abc.ABC):
    """针对行情快照的规则。"""

    name: str = "rule"
    level: str = "info"

    @abc.abstractmethod
    def evaluate(self, quote: Quote, ctx: RuleContext) -> List[Alert]:
        """返回命中的告警列表（未命中返回空列表）。"""


class AnnouncementRule(abc.ABC):
    """针对公告的规则。"""

    name: str = "announcement_rule"
    level: str = "info"

    @abc.abstractmethod
    def evaluate(self, announcement: Announcement, ctx: RuleContext) -> List[Alert]:
        """返回命中的告警列表（未命中返回空列表）。"""


def make_alert(
    rule: str,
    quote: Quote,
    message: str,
    level: str,
    payload: Optional[dict] = None,
) -> Alert:
    return Alert(
        rule=rule,
        code=quote.code,
        name=quote.name,
        message=message,
        level=level,
        quote_time=quote.quote_time,
        payload=payload or {},
    )
