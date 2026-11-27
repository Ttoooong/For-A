"""东方财富行情适配器（``push2``）。

零成本、秒级，返回 JSON，最适合脚本化处理。代价是**代号制字段**：
价格类字段都要 ÷100，时间戳在 ``f86``（Unix 秒）。
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Dict, List

from ..http import HttpClient
from ..models import Quote, eastmoney_secid
from .base import QuoteSource

logger = logging.getLogger(__name__)

ENDPOINT = "/api/qt/stock/get"
REFERER = "https://quote.eastmoney.com/"

# 东财有多个同构镜像。单主机在高频访问下会偶发空响应，
# 逐个降级重试可以显著降低整条链路的失败率。
HOSTS = (
    "https://push2.eastmoney.com",
    "https://push2delay.eastmoney.com",
    "https://82.push2.eastmoney.com",
    "https://48.push2.eastmoney.com",
)

FIELDS = ",".join(
    [
        "f43",  # 最新价 ×100
        "f44",  # 最高 ×100
        "f45",  # 最低 ×100
        "f46",  # 今开 ×100
        "f47",  # 成交量（手）
        "f48",  # 成交额（元）
        "f50",  # 量比 ×100
        "f51",  # 涨停价 ×100
        "f52",  # 跌停价 ×100
        "f57",  # 代码
        "f58",  # 名称
        "f60",  # 昨收 ×100
        "f86",  # 行情时间戳（Unix 秒）
        "f116",  # 总市值（元）
        "f117",  # 流通市值（元）
        "f162",  # 市盈率(动) ×100
        "f167",  # 市净率 ×100
        "f168",  # 换手率 ×100
        "f169",  # 涨跌额 ×100
        "f170",  # 涨跌幅 ×100
    ]
)

_PRICE_FIELDS = {
    "f43": "price",
    "f44": "high",
    "f45": "low",
    "f46": "open",
    "f51": "limit_up",
    "f52": "limit_down",
    "f60": "prev_close",
}
_RATIO_FIELDS = {
    "f162": "pe",
    "f167": "pb",
    "f168": "turnover",
    "f169": "change",
    "f170": "change_pct",
}


def parse_eastmoney_payload(payload: dict, fallback_code: str) -> Quote | None:
    """把 ``push2`` 的 JSON 响应转成 :class:`Quote`。"""
    data = payload.get("data")
    if not isinstance(data, dict):
        return None

    def scaled(key: str) -> float:
        raw = data.get(key)
        try:
            return float(raw) / 100.0
        except (TypeError, ValueError):
            return 0.0

    def as_float(key: str) -> float:
        raw = data.get(key)
        try:
            return float(raw)
        except (TypeError, ValueError):
            return 0.0

    digits = str(data.get("f57") or fallback_code.split(".")[0])
    market = fallback_code.split(".")[-1].upper()
    quote_time = None
    ts = data.get("f86")
    if ts:
        try:
            quote_time = datetime.fromtimestamp(float(ts))
        except (TypeError, ValueError, OSError):
            quote_time = None

    return Quote(
        code=f"{digits}.{market}",
        name=str(data.get("f58") or ""),
        price=scaled("f43"),
        prev_close=scaled("f60"),
        open=scaled("f46"),
        high=scaled("f44"),
        low=scaled("f45"),
        volume=as_float("f47") * 100,
        amount=as_float("f48"),
        turnover=scaled("f168"),
        pe=scaled("f162"),
        pb=scaled("f167"),
        total_mv=as_float("f116"),
        float_mv=as_float("f117"),
        limit_up=scaled("f51") or None,
        limit_down=scaled("f52") or None,
        change=scaled("f169"),
        change_pct=scaled("f170"),
        quote_time=quote_time,
        source="eastmoney",
    )


class EastmoneySource(QuoteSource):
    name = "eastmoney"

    def __init__(self, client: HttpClient, hosts: tuple[str, ...] = HOSTS) -> None:
        self.client = client
        self.hosts = list(hosts)

    def _get(self, code: str) -> dict:
        """按镜像顺序重试，直到某一台返回可解析的 JSON。"""
        params = {"secid": eastmoney_secid(code), "fields": FIELDS}
        last_error: Exception | None = None
        for host in self.hosts:
            try:
                payload = self.client.get_json(
                    f"{host}{ENDPOINT}",
                    params=params,
                    headers={"Referer": REFERER},
                )
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                logger.warning("东财镜像 %s 请求失败: %s", host, exc)
                continue
            if payload.get("data"):
                return payload
            last_error = RuntimeError(f"{host} 返回空 data")
        raise RuntimeError(f"东财所有镜像均失败: {last_error}")

    def fetch(self, codes: List[str]) -> Dict[str, Quote]:
        result: Dict[str, Quote] = {}
        for code in codes:
            quote = parse_eastmoney_payload(self._get(code), code)
            if quote is not None:
                result[quote.code] = quote
        return result
