"""新浪行情适配器（``hq.sinajs.cn``）。

零成本、秒级。**必须带 Referer**，否则直接 403。
港股实时价需要 ``rt_`` 前缀（如 ``rt_hk00700``），写成 ``hk00700`` 会掉进延迟档。
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Dict, List

from ..http import HttpClient
from ..models import Quote, sina_symbol
from .base import QuoteSource

logger = logging.getLogger(__name__)

ENDPOINT = "https://hq.sinajs.cn/list={symbols}"
REFERER = "https://finance.sina.com.cn"
_PAYLOAD_RE = re.compile(r'var hq_str_(?P<symbol>[a-z0-9_]+)="(?P<body>[^"]*)"')

# 新浪 A 股字段下标（0 基），已按实测报文核对
_F_NAME = 0
_F_OPEN = 1
_F_PREV_CLOSE = 2
_F_PRICE = 3
_F_HIGH = 4
_F_LOW = 5
_F_VOLUME_SHARE = 8
_F_AMOUNT = 9
_F_BID1_PRICE = 11
_F_ASK1_PRICE = 21
_F_DATE = 30
_F_TIME = 31


def _to_float(raw: str) -> float:
    try:
        return float(raw)
    except (TypeError, ValueError):
        return 0.0


def parse_sina_line(symbol: str, body: str) -> Quote | None:
    """解析单条新浪报文。"""
    fields = body.split(",")
    if len(fields) < 32 or not fields[_F_NAME]:
        return None

    def f(index: int) -> float:
        return _to_float(fields[index]) if index < len(fields) else 0.0

    quote_time = None
    try:
        quote_time = datetime.strptime(
            f"{fields[_F_DATE]} {fields[_F_TIME]}", "%Y-%m-%d %H:%M:%S"
        )
    except (ValueError, IndexError):
        quote_time = None

    bids = []
    asks = []
    for i in range(5):
        bid_vol = f(10 + i * 2)
        bid_price = f(11 + i * 2)
        ask_vol = f(20 + i * 2)
        ask_price = f(21 + i * 2)
        if bid_price:
            bids.append((bid_price, bid_vol))
        if ask_price:
            asks.append((ask_price, ask_vol))

    price = f(_F_PRICE)
    prev_close = f(_F_PREV_CLOSE)
    change = round(price - prev_close, 4) if prev_close else 0.0
    change_pct = round(change / prev_close * 100, 4) if prev_close else 0.0

    market = symbol[:2].upper()
    digits = symbol[2:]
    code = f"{digits}.{market}"

    return Quote(
        code=code,
        name=fields[_F_NAME],
        price=price,
        prev_close=prev_close,
        open=f(_F_OPEN),
        high=f(_F_HIGH),
        low=f(_F_LOW),
        volume=f(_F_VOLUME_SHARE),
        amount=f(_F_AMOUNT),
        change=change,
        change_pct=change_pct,
        quote_time=quote_time,
        bids=bids,
        asks=asks,
        source="sina",
    )


class SinaSource(QuoteSource):
    name = "sina"

    def __init__(self, client: HttpClient) -> None:
        self.client = client

    def fetch(self, codes: List[str]) -> Dict[str, Quote]:
        if not codes:
            return {}
        symbols = [sina_symbol(code) for code in codes]
        url = ENDPOINT.format(symbols=",".join(symbols))
        text = self.client.get_text(
            url, encoding="gbk", headers={"Referer": REFERER, "User-Agent": self.client.session.headers["User-Agent"]}
        )
        result: Dict[str, Quote] = {}
        for match in _PAYLOAD_RE.finditer(text):
            quote = parse_sina_line(match.group("symbol"), match.group("body"))
            if quote is not None:
                result[quote.code] = quote
        return result
