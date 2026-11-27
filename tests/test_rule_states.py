"""规则阈值穿越语义：一次异动只推一条，而不是每次刷新都推。"""

from datetime import datetime

import pytest

from for_a.models import Quote
from for_a.rules.base import RuleContext
from for_a.rules.price import LimitRule, PriceChangeRule, TurnoverRule
from for_a.storage import Storage


@pytest.fixture()
def storage(tmp_path):
    store = Storage(str(tmp_path / "states.db"))
    yield store
    store.close()


@pytest.fixture()
def ctx(storage):
    return RuleContext(storage=storage, now=datetime.now())


def _quote(**kwargs) -> Quote:
    base = dict(
        code="600519.SH",
        name="贵州茅台",
        price=1472.98,
        prev_close=1469.0,
        volume=3058800,
        quote_time=datetime.now(),
    )
    base.update(kwargs)
    return Quote(**base)


def test_price_change_fires_once_while_trending_up(ctx):
    """+5% 一路涨到 +10%：只推一条，而不是每个 0.1% 一条。"""
    rule = PriceChangeRule(threshold_pct=5.0)
    alerts = []
    for i in range(51):
        alerts.extend(rule.evaluate(_quote(change_pct=5.0 + i * 0.1), ctx))
    assert len(alerts) == 1


def test_price_change_refires_after_falling_back(ctx):
    rule = PriceChangeRule(threshold_pct=5.0)
    assert rule.evaluate(_quote(change_pct=6.0), ctx)
    assert rule.evaluate(_quote(change_pct=6.5), ctx) == []
    assert rule.evaluate(_quote(change_pct=3.0), ctx) == []  # 回落复位，不告警
    assert rule.evaluate(_quote(change_pct=7.0), ctx)  # 再次突破，重新推送


def test_price_change_separates_up_and_down(ctx):
    rule = PriceChangeRule(threshold_pct=5.0)
    assert rule.evaluate(_quote(change_pct=-6.0), ctx)
    assert rule.evaluate(_quote(change_pct=6.0), ctx)


def test_turnover_is_bucketed(ctx):
    """换手率 1% -> 30%：按 5% 一档提醒，不是每 1% 一条。"""
    rule = TurnoverRule(threshold_pct=10.0)
    alerts = []
    for value in range(1, 31):
        alerts.extend(rule.evaluate(_quote(turnover=float(value)), ctx))
    assert len(alerts) <= 6


def test_limit_refires_again_after_opening(ctx):
    rule = LimitRule()
    sealed = dict(price=1615.90, limit_up=1615.90, change_pct=10.0)
    assert rule.evaluate(_quote(**sealed), ctx)
    assert rule.evaluate(_quote(**sealed), ctx) == []  # 还在封板，不重复推
    assert (
        rule.evaluate(_quote(price=1500.0, limit_up=1615.90, change_pct=2.0), ctx) == []
    )  # 开板复位
    assert rule.evaluate(_quote(**sealed), ctx)  # 再次封板，重新推送


def test_state_survives_a_new_rule_instance(ctx):
    """状态存在库里，换一个规则实例也不会重复推送。"""
    first = PriceChangeRule(threshold_pct=5.0)
    assert first.evaluate(_quote(change_pct=6.0), ctx)
    second = PriceChangeRule(threshold_pct=5.0)
    assert second.evaluate(_quote(change_pct=6.5), ctx) == []
