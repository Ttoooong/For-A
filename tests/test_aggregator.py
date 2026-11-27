"""多源交叉校验与规则引擎测试（不依赖网络）。"""

from datetime import datetime, timedelta

import pytest

from for_a.aggregator import Aggregator
from for_a.models import Alert, Quote
from for_a.rules.price import LimitRule, PriceChangeRule, TurnoverRule, VolumeSurgeRule
from for_a.rules.base import RuleContext
from for_a.storage import Storage


def _quote(**kwargs) -> Quote:
    base = dict(
        code="600519.SH",
        name="贵州茅台",
        price=1472.98,
        prev_close=1469.00,
        open=1469.99,
        high=1481.41,
        low=1452.99,
        change=3.98,
        change_pct=0.27,
        turnover=0.24,
        volume=3058800,
        quote_time=datetime.now(),
        source="tencent",
    )
    base.update(kwargs)
    return Quote(**base)


class _FakeSource:
    def __init__(self, payload):
        self.payload = payload
        self.name = "fake"

    def fetch(self, codes):
        return {code: q for code, q in self.payload.items() if code in codes}


def _aggregator(primary_payload, verify_payloads):
    """构造一个注入假数据源的聚合器。

    ``primary_payload`` 是主源返回的 ``{code: Quote}``，``verify_payloads`` 是
    ``{源名: {code: Quote}}``。
    """
    agg = Aggregator(
        client=None, primary="primary", verify=list(verify_payloads.keys())
    )
    agg._sources["primary"] = _FakeSource(primary_payload)
    for name, payload in verify_payloads.items():
        agg._sources[name] = _FakeSource(payload)
    return agg


def test_divergence_detected():
    agg = _aggregator(
        {"600519.SH": _quote(price=1472.98)},
        {"sina": {"600519.SH": _quote(price=1475.00, source="sina")}},
    )
    result = agg.fetch(["600519.SH"])["600519.SH"]
    assert result.divergence > 0.001
    assert result.quote is not None
    assert result.quote.source == "tencent"


def test_no_divergence_when_sources_agree():
    agg = _aggregator(
        {"600519.SH": _quote(price=1472.98)},
        {"sina": {"600519.SH": _quote(price=1472.98, source="sina")}},
    )
    result = agg.fetch(["600519.SH"])["600519.SH"]
    assert result.divergence == 0.0


def test_primary_source_failure_falls_back():
    class _Empty(_FakeSource):
        def fetch(self, codes):
            return {}

    agg = Aggregator(client=None, primary="eastmoney", verify=["sina"])
    agg._sources["eastmoney"] = _Empty({})
    agg._sources["sina"] = _FakeSource({"600519.SH": _quote(price=1472.98, source="sina")})
    result = agg.fetch(["600519.SH"])["600519.SH"]
    assert result.ok
    assert result.quote.source == "sina"


def test_stuck_primary_source_is_demoted():
    """主源时间戳卡住时必须降级到最新的源，并在结果上标记出来。"""
    now = datetime.now()
    stuck = _quote(price=1472.0, quote_time=now - timedelta(seconds=600), source="eastmoney")
    fresh = _quote(price=1478.9, quote_time=now, source="tencent")
    agg = Aggregator(client=None, primary="eastmoney", verify=["tencent"])
    agg._sources["eastmoney"] = _FakeSource({"600519.SH": stuck})
    agg._sources["tencent"] = _FakeSource({"600519.SH": fresh})
    result = agg.fetch(["600519.SH"])["600519.SH"]
    assert result.stale
    assert result.stale_source == "eastmoney"
    assert result.stale_lag > 500
    assert result.quote.source == "tencent"
    assert result.quote.price == 1478.9


def test_fresh_primary_source_is_kept():
    now = datetime.now()
    agg = _aggregator(
        {"600519.SH": _quote(price=1472.98, quote_time=now, source="eastmoney")},
        {"tencent": {"600519.SH": _quote(price=1472.99, quote_time=now, source="tencent")}},
    )
    result = agg.fetch(["600519.SH"])["600519.SH"]
    assert not result.stale
    assert result.stale_source == ""
    assert result.quote.source == "eastmoney"


@pytest.fixture()
def storage(tmp_path):
    store = Storage(str(tmp_path / "test.db"))
    yield store
    store.close()


@pytest.fixture()
def ctx(storage):
    return RuleContext(storage=storage, now=datetime.now())


def test_price_change_rule(ctx):
    rule = PriceChangeRule(threshold_pct=5.0)
    assert rule.evaluate(_quote(change_pct=1.0), ctx) == []
    alerts = rule.evaluate(_quote(change_pct=6.5), ctx)
    assert len(alerts) == 1
    assert alerts[0].level == "warning"
    assert "涨" in alerts[0].message


def test_limit_rule_uses_source_limit_prices(ctx):
    rule = LimitRule()
    assert rule.evaluate(_quote(price=1615.90, limit_up=1615.90, change_pct=10.0), ctx)
    assert rule.evaluate(_quote(price=1322.10, limit_down=1322.10, change_pct=-10.0), ctx)
    assert rule.evaluate(_quote(price=1472.98), ctx) == []


def test_limit_rule_falls_back_to_board_percentage(ctx):
    rule = LimitRule()
    up = _quote(code="300750.SZ", price=120.0, change_pct=20.0)
    assert rule.evaluate(up, ctx)
    down = _quote(code="300750.SZ", price=80.0, change_pct=-20.0)
    assert rule.evaluate(down, ctx)


def test_turnover_rule(ctx):
    rule = TurnoverRule(threshold_pct=10.0)
    assert rule.evaluate(_quote(turnover=3.0), ctx) == []
    assert len(rule.evaluate(_quote(turnover=15.0), ctx)) == 1


def test_volume_surge_rule_needs_baseline(ctx, storage):
    rule = VolumeSurgeRule(ratio=3.0, min_seconds=0)
    quote = _quote(volume=1000)
    assert rule.evaluate(quote, ctx) == []

    storage.save_quote(_quote(volume=1000))
    surged = _quote(volume=5000, quote_time=datetime.now())
    alerts = rule.evaluate(surged, ctx)
    assert len(alerts) == 1
    assert alerts[0].payload["ratio"] >= 3.0


def test_alert_dedup_key_is_stable():
    from for_a.watch import Watcher

    alert = Alert(
        rule="price_change",
        code="600519.SH",
        name="贵州茅台",
        message="x",
        payload={"change_pct": 6.53},
    )
    assert Watcher._alert_key(alert) == Watcher._alert_key(alert)
