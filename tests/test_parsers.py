"""各数据源报文解析测试（使用实测报文，不依赖网络）。"""

from for_a.models import SymbolError
from for_a.sources.cninfo import CninfoSource
from for_a.sources.eastmoney import parse_eastmoney_payload
from for_a.sources.sina import parse_sina_line
from for_a.sources.tencent import parse_tencent_line

# 取自 2026-11-27 盘中实测报文（600519 贵州茅台）
TENCENT_BODY = (
    "1~贵州茅台~600519~1472.98~1469.00~1469.99~30588~16801~13761~1472.85~1~1472.73~1~"
    "1472.71~3~1472.66~1~1472.35~1~1472.98~2~1473.00~4~1473.49~1~1473.50~3~1473.51~11~"
    "~20261127141112~3.98~0.27~1481.41~1452.99~1472.98/30588/4486793316~30588~448679~"
    "0.24~22.41~~1481.41~1452.99~1.93~18413.45~18413.45~6.79~1615.90~1322.10~0.78~6~"
    "1466.85~21.42~22.37~~-0.07~449327.6158~0.0000~0"
)

SINA_BODY = (
    "贵州茅台,1469.990,1469.000,1472.980,1481.410,1452.990,1472.850,1472.980,3058819,"
    "4486793316.000,100,1472.850,100,1472.730,300,1472.710,100,1472.660,100,1472.350,200,"
    "1472.980,400,1473.000,100,1473.490,300,1473.500,1100,1473.510,2026-11-27,14:11:12,00,"
)

EASTMONEY_PAYLOAD = {
    "rc": 0,
    "data": {
        "f43": 147353,
        "f44": 148141,
        "f45": 145299,
        "f46": 146999,
        "f47": 30636,
        "f48": 4493865454.0,
        "f57": "600519",
        "f58": "贵州茅台",
        "f60": 146900,
        "f86": 1795759893,
        "f116": 1842032741521.53,
        "f117": 1842032741521.53,
        "f162": 2143,
        "f167": 679,
        "f168": 25,
        "f169": 453,
        "f170": 31,
        "f51": 161590,
        "f52": 132210,
    },
}


def test_tencent_parser():
    quote = parse_tencent_line("sh600519", TENCENT_BODY)
    assert quote is not None
    assert quote.code == "600519.SH"
    assert quote.name == "贵州茅台"
    assert quote.price == 1472.98
    assert quote.prev_close == 1469.00
    assert quote.open == 1469.99
    assert quote.high == 1481.41
    assert quote.low == 1452.99
    # 成交量源端是手，统一换算成股
    assert quote.volume == 30588 * 100
    # 成交额源端是万元，统一换算成元
    assert quote.amount == 448679 * 10_000
    assert quote.change == 3.98
    assert quote.change_pct == 0.27
    assert quote.turnover == 0.24
    assert quote.limit_up == 1615.90
    assert quote.limit_down == 1322.10
    assert quote.quote_time is not None
    assert quote.quote_time.strftime("%Y-%m-%d %H:%M:%S") == "2026-11-27 14:11:12"
    assert len(quote.bids) == 5
    assert len(quote.asks) == 5
    assert quote.bids[0] == (1472.85, 100)


def test_tencent_parser_rejects_empty():
    assert parse_tencent_line("sh600519", "1~贵州茅台~600519~") is None


def test_sina_parser():
    quote = parse_sina_line("sh600519", SINA_BODY)
    assert quote is not None
    assert quote.code == "600519.SH"
    assert quote.name == "贵州茅台"
    assert quote.price == 1472.98
    assert quote.prev_close == 1469.00
    assert quote.open == 1469.99
    assert quote.high == 1481.41
    assert quote.low == 1452.99
    assert quote.volume == 3058819
    assert quote.amount == 4486793316.0
    assert quote.change == 3.98
    assert round(quote.change_pct, 2) == 0.27
    assert quote.quote_time is not None
    assert quote.quote_time.strftime("%Y-%m-%d %H:%M:%S") == "2026-11-27 14:11:12"
    assert len(quote.bids) == 5
    assert len(quote.asks) == 5


def test_sina_parser_rejects_empty():
    assert parse_sina_line("sh600519", "") is None


def test_eastmoney_parser_scales_decimals():
    quote = parse_eastmoney_payload(EASTMONEY_PAYLOAD, "600519.SH")
    assert quote is not None
    assert quote.code == "600519.SH"
    assert quote.name == "贵州茅台"
    assert quote.price == 1473.53
    assert quote.prev_close == 1469.00
    assert quote.high == 1481.41
    assert quote.low == 1452.99
    assert quote.open == 1469.99
    assert quote.volume == 30636 * 100
    assert quote.amount == 4493865454.0
    assert quote.change == 4.53
    assert quote.change_pct == 0.31
    assert quote.turnover == 0.25
    assert quote.pe == 21.43
    assert quote.pb == 6.79
    assert quote.limit_up == 1615.90
    assert quote.limit_down == 1322.10
    assert quote.quote_time is not None


def test_eastmoney_parser_handles_null_data():
    assert parse_eastmoney_payload({"data": None}, "600519.SH") is None


def test_three_sources_agree_on_intraday_reference_fields():
    """三源对昨收/最高/最低/今开应当完全一致。

    最新价会随行情推进变化（腾讯报文 14:11:12、东财报文 14:11:33），
    所以这里只比对日内不随秒级波动的字段。
    """
    tencent = parse_tencent_line("sh600519", TENCENT_BODY)
    sina = parse_sina_line("sh600519", SINA_BODY)
    eastmoney = parse_eastmoney_payload(EASTMONEY_PAYLOAD, "600519.SH")
    for field in ("prev_close", "open", "high", "low"):
        values = {round(getattr(q, field), 2) for q in (tencent, sina, eastmoney)}
        assert len(values) == 1, f"{field} 分歧: {values}"


def test_symbol_error_is_value_error():
    assert issubclass(SymbolError, ValueError)
