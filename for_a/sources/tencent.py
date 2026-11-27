"""腾讯行情适配器（``qt.gtimg.cn``）。

零成本、秒级、五档盘口，是免费源里字段最全的一个：除常规行情外还带涨跌停价、
换手率、量比、振幅等。限制是港股/美股为延迟档，A 股才是实时。
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Dict, List

from ..http import HttpClient
from ..models import Quote, tencent_symbol
from .base import QuoteSource

logger = logging.getLogger(__name__)

ENDPOINT = "https://qt.gtimg.cn/q={symbols}"
_PAYLOAD_RE = re.compile(r'v_(?P<symbol>[a-z]{2}\d+)="(?P<body>[^"]*)"')

# 腾讯 A 股字段下标（0 基），已按实测报文核对
_F_NAME = 1
_F_CODE = 2
_F_PRICE = 3
_F_PREV_CLOSE = 4
_F_OPEN = 5
_F_VOLUME_HAND = 6
_F_BID1 = 9
_F_ASK1 = 19
_F_TIME = 30
_F_CHANGE = 31
_F_CHANGE_PCT = 32
_F_HIGH = 33
_F_LOW = 34
_F_AMOUNT_WAN = 37
_F_TURNOVER = 38
_F_PE = 39
_F_AMPLITUDE = 43
_F_FLOAT_MV = 44
_F_TOTAL_MV = 45
_F_PB = 46
_F_LIMIT_UP = 47
_F_LIMIT_DOWN = 48


def _to_float(raw: str) -> float:
    try:
        return float(raw)
    except (TypeError, ValueError):
        return 0.0


def parse_tencent_line(symbol: str, body: str) -> Quote | None:
    """解析单条腾讯报文，返回 ``None`` 表示该代码无有效数据。"""
    fields = body.split("~")
    if len(fields) < 49 or not fields[_F_CODE]:
        return None

    def f(index: int) -> float:
        return _to_float(fields[index]) if index < len(fields) else 0.0

    def opt(index: int) -> float | None:
        if index >= len(fields):
            return None
        value = _to_float(fields[index])
        return value or None

    quote_time = None
    if len(fields) > _F_TIME and len(fields[_F_TIME]) >= 14:
        try:
            quote_time = datetime.strptime(fields[_F_TIME][:14], "%Y%m%d%H%M%S")
        except ValueError:
            quote_time = None

    bids = []
    asks = []
    for i in range(5):
        bid_price = f(_F_BID1 + i * 2)
        bid_vol = f(_F_BID1 + i * 2 + 1)
        ask_price = f(_F_ASK1 + i * 2)
        ask_vol = f(_F_ASK1 + i * 2 + 1)
        if bid_price:
            bids.append((bid_price, bid_vol * 100))
        if ask_price:
            asks.append((ask_price, ask_vol * 100))

    market = symbol[:2].upper()
    code = f"{fields[_F_CODE]}.{market}"

    return Quote(
        code=code,
        name=fields[_F_NAME],
        price=f(_F_PRICE),
        prev_close=f(_F_PREV_CLOSE),
        open=f(_F_OPEN),
        high=f(_F_HIGH),
        low=f(_F_LOW),
        volume=f(_F_VOLUME_HAND) * 100,
        amount=f(_F_AMOUNT_WAN) * 10_000,
        change=f(_F_CHANGE),
        change_pct=f(_F_CHANGE_PCT),
        turnover=f(_F_TURNOVER),
        amplitude=f(_F_AMPLITUDE),
        pe=f(_F_PE),
        pb=f(_F_PB),
        total_mv=f(_F_TOTAL_MV) * 100_000_000,
        float_mv=f(_F_FLOAT_MV) * 100_000_000,
        limit_up=opt(_F_LIMIT_UP),
        limit_down=opt(_F_LIMIT_DOWN),
        bids=bids,
        asks=asks,
        quote_time=quote_time,
        source="tencent",
    )


class TencentSource(QuoteSource):
    name = "tencent"

    def __init__(self, client: HttpClient) -> None:
        self.client = client

    def fetch(self, codes: List[str]) -> Dict[str, Quote]:
        if not codes:
            return {}
        symbols = [tencent_symbol(code) for code in codes]
        url = ENDPOINT.format(symbols=",".join(symbols))
        text = self.client.get_text(url, encoding="gbk")
        result: Dict[str, Quote] = {}
        for match in _PAYLOAD_RE.finditer(text):
            quote = parse_tencent_line(match.group("symbol"), match.group("body"))
            if quote is not None:
                result[quote.code] = quote
        return result
