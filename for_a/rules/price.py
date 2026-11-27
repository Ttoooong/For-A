"""价格类规则：涨跌幅、涨跌停、换手率、放量。

每条规则都维护自己的状态（存在 :class:`~for_a.storage.Storage` 的
``rule_states`` 表里），只在**状态发生变化**时产出告警。这样一只股票从
+5% 慢慢涨到 +10% 只会推一条，而不是每个 0.1% 推一条。
"""

from __future__ import annotations

from datetime import datetime
from typing import List

from ..models import Alert, Quote
from .base import Rule, RuleContext, make_alert


class _StatefulRule(Rule):
    """带状态机的规则基类。

    子类实现 :meth:`current_state`，基类负责比较新旧状态、决定要不要告警。
    """

    def state_key(self, quote: Quote) -> str:
        return f"{self.name}:{quote.code}"

    def current_state(self, quote: Quote) -> str:
        """返回当前状态；空串表示「未触发」。"""
        raise NotImplementedError

    def build_alert(self, quote: Quote, state: str) -> Alert:
        raise NotImplementedError

    def evaluate(self, quote: Quote, ctx: RuleContext) -> List[Alert]:
        state = self.current_state(quote)
        key = self.state_key(quote)
        previous = ctx.storage.get_state(key)
        if previous == state:
            return []
        ctx.storage.set_state(key, state)
        if not state:
            # 从「触发过」回落到未触发：复位，不告警
            return []
        return [self.build_alert(quote, state)]


class PriceChangeRule(_StatefulRule):
    """涨跌幅超过阈值。

    只在穿越阈值时告警一次：涨过阈值推一条，继续上涨不再重复推；
    跌回阈值以下后再次涨破才会重新推送。
    """

    name = "price_change"

    def __init__(self, threshold_pct: float = 5.0, level: str = "warning") -> None:
        self.threshold_pct = threshold_pct
        self.level = level

    def current_state(self, quote: Quote) -> str:
        if quote.change_pct >= self.threshold_pct:
            return "up"
        if quote.change_pct <= -self.threshold_pct:
            return "down"
        return ""

    def build_alert(self, quote: Quote, state: str) -> Alert:
        direction = "涨" if state == "up" else "跌"
        message = (
            f"{quote.name}({quote.code}) {direction} {quote.change_pct:+.2f}%，"
            f"现价 {quote.price:.2f} 元"
        )
        return make_alert(
            self.name,
            quote,
            message,
            self.level,
            {"change_pct": quote.change_pct, "price": quote.price, "state": state},
        )


class LimitRule(_StatefulRule):
    """触及涨停或跌停。

    源端提供涨跌停价时直接比较；否则按板块幅度（主板 10%、双创 20%、北交所 30%）
    推算，容忍 0.3 个百分点的误差。封住期间不重复推送，开板后再次封板才重推。
    """

    name = "limit"

    def __init__(self, level: str = "critical") -> None:
        self.level = level

    def current_state(self, quote: Quote) -> str:
        if quote.is_limit_up:
            return "limit_up"
        if quote.is_limit_down:
            return "limit_down"
        return ""

    def build_alert(self, quote: Quote, state: str) -> Alert:
        if state == "limit_up":
            message = f"{quote.name}({quote.code}) 触及涨停，现价 {quote.price:.2f} 元"
        else:
            message = f"{quote.name}({quote.code}) 触及跌停，现价 {quote.price:.2f} 元"
        return make_alert(self.name, quote, message, self.level, {"state": state})


class TurnoverRule(_StatefulRule):
    """换手率超过阈值（资金活跃度信号）。

    每 5% 换手一档：换手率一路走高时分档提醒，而不是每刷新一次算一条新事件。
    """

    name = "turnover"

    def __init__(self, threshold_pct: float = 10.0, level: str = "info") -> None:
        self.threshold_pct = threshold_pct
        self.level = level

    def current_state(self, quote: Quote) -> str:
        if quote.turnover < self.threshold_pct:
            return ""
        return str(int(quote.turnover // 5))

    def build_alert(self, quote: Quote, state: str) -> Alert:
        message = (
            f"{quote.name}({quote.code}) 换手率 {quote.turnover:.2f}% "
            f"超过阈值 {self.threshold_pct:.2f}%"
        )
        return make_alert(
            self.name,
            quote,
            message,
            self.level,
            {"turnover": quote.turnover, "state": state},
        )


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

        # 以行情时间戳分桶（而不是本地时钟），同一个 5 分钟窗口内只推一次
        stamp = quote.quote_time or ctx.now
        bucket = int(stamp.timestamp() // 300)
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
                {"ratio": round(actual_ratio, 2), "volume_delta": delta, "bucket": bucket},
            )
        ]
