"""价格类规则：涨跌幅、涨跌停、换手率、放量。"""

from __future__ import annotations

from datetime import datetime
from typing import List

from ..models import Alert, Quote
from .base import Rule, RuleContext, make_alert


class PriceChangeRule(Rule):
    """涨跌幅超过阈值。"""

    name = "price_change"

    def __init__(self, threshold_pct: float = 5.0, level: str = "warning") -> None:
        self.threshold_pct = threshold_pct
        self.level = level

    def evaluate(self, quote: Quote, ctx: RuleContext) -> List[Alert]:
        if abs(quote.change_pct) < self.threshold_pct:
            return []
        direction = "涨" if quote.change_pct > 0 else "跌"
        message = (
            f"{quote.name}({quote.code}) {direction} {quote.change_pct:+.2f}%，"
            f"现价 {quote.price:.2f} 元"
        )
        return [
            make_alert(
                self.name,
                quote,
                message,
                self.level,
                {"change_pct": quote.change_pct, "price": quote.price},
            )
        ]


class LimitRule(Rule):
    """触及涨停或跌停。

    源端提供涨跌停价时直接比较；否则按板块幅度（主板 10%、双创 20%、北交所 30%）
    推算，容忍 0.3 个百分点的误差。
    """

    name = "limit"

    def __init__(self, level: str = "critical") -> None:
        self.level = level

    def evaluate(self, quote: Quote, ctx: RuleContext) -> List[Alert]:
        if quote.is_limit_up:
            message = f"{quote.name}({quote.code}) 触及涨停，现价 {quote.price:.2f} 元"
            state = "limit_up"
        elif quote.is_limit_down:
            message = f"{quote.name}({quote.code}) 触及跌停，现价 {quote.price:.2f} 元"
            state = "limit_down"
        else:
            return []
        return [
            make_alert(
                self.name, quote, message, self.level, {"state": state}
            )
        ]


class TurnoverRule(Rule):
    """换手率超过阈值（资金活跃度信号）。"""

    name = "turnover"

    def __init__(self, threshold_pct: float = 10.0, level: str = "info") -> None:
        self.threshold_pct = threshold_pct
        self.level = level

    def evaluate(self, quote: Quote, ctx: RuleContext) -> List[Alert]:
        if quote.turnover < self.threshold_pct:
            return []
        message = (
            f"{quote.name}({quote.code}) 换手率 {quote.turnover:.2f}% "
            f"超过阈值 {self.threshold_pct:.2f}%"
        )
        return [
            make_alert(
                self.name, quote, message, self.level, {"turnover": quote.turnover}
            )
        ]


class VolumeSurgeRule(Rule):
    """成交量相对上一次采样放大。

    以两次采样之间的成交量增量做比较（而非与 5 日均量比较），因此只依赖
    行情源自身的数据，不需要额外的历史数据源。首次采样没有基线时不触发。
    """

    name = "volume_surge"

    def __init__(
        self, ratio: float = 3.0, min_seconds: int = 60, level: str = "warning"
    ) -> None:
        self.ratio = ratio
        self.min_seconds = min_seconds
        self.level = level

    def evaluate(self, quote: Quote, ctx: RuleContext) -> List[Alert]:
        row = ctx.storage.last_quote(quote.code)
        if row is None:
            return []
        try:
            last_volume = float(row["volume"] or 0)
            last_time = datetime.fromisoformat(row["quote_time"]) if row["quote_time"] else None
        except (TypeError, ValueError):
            return []
        if last_volume <= 0:
            return []
        if last_time and quote.quote_time:
            gap = (quote.quote_time - last_time).total_seconds()
            if gap < self.min_seconds:
                return []

        delta = quote.volume - last_volume
        if delta <= 0:
            return []
        actual_ratio = delta / last_volume
        if actual_ratio < self.ratio:
            return []

        message = (
            f"{quote.name}({quote.code}) 成交量较上次采样放大 {actual_ratio:.1f} 倍"
            f"（增量 {delta / 100:,.0f} 手）"
        )
        return [
            make_alert(
                self.name,
                quote,
                message,
                self.level,
                {"ratio": round(actual_ratio, 2), "volume_delta": delta},
            )
        ]
