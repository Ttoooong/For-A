"""多源交叉校验。

免费公开接口没有 SLA，唯一可行的准确性验证就是同时打两三个源比对。
聚合器负责：选主源、算分歧度、识别某个源是否卡住。
"""

from __future__ import annotations

import logging
from typing import Dict, Iterable, List

from .http import HttpClient
from .models import AggregatedQuote, Quote
from .sources import build_source

logger = logging.getLogger(__name__)


class Aggregator:
    """按主源 + 校验源拉取行情并交叉比对。"""

    def __init__(
        self,
        client: HttpClient,
        primary: str = "eastmoney",
        verify: Iterable[str] = ("tencent", "sina"),
        divergence_tolerance: float = 0.005,
        stale_seconds: float = 120.0,
    ) -> None:
        self.client = client
        self.primary = primary
        self.verify = [name for name in verify if name != primary]
        self.divergence_tolerance = divergence_tolerance
        self.stale_seconds = stale_seconds
        self._sources: Dict[str, object] = {}

    def _source(self, name: str):
        if name not in self._sources:
            self._sources[name] = build_source(name, self.client)
        return self._sources[name]

    def fetch(self, codes: List[str]) -> Dict[str, AggregatedQuote]:
        """拉取全部源并聚合。"""
        per_source: Dict[str, Dict[str, Quote]] = {}
        errors: Dict[str, str] = {}

        for name in [self.primary] + self.verify:
            try:
                per_source[name] = self._source(name).fetch(codes)  # type: ignore[attr-defined]
            except Exception as exc:  # noqa: BLE001
                logger.warning("数据源 %s 拉取失败: %s", name, exc)
                errors[name] = str(exc)
                per_source[name] = {}

        result: Dict[str, AggregatedQuote] = {}
        for code in codes:
            quotes: Dict[str, Quote] = {}
            for name, mapping in per_source.items():
                quote = mapping.get(code)
                if quote is not None:
                    quotes[name] = quote
            result[code] = self._aggregate(code, quotes, errors)
        return result

    def _aggregate(
        self, code: str, quotes: Dict[str, Quote], errors: Dict[str, str]
    ) -> AggregatedQuote:
        if not quotes:
            return AggregatedQuote(
                code=code,
                name="",
                quote=None,
                quotes={},
                divergence=0.0,
                stale=True,
                errors=dict(errors),
            )

        primary_quote = quotes.get(self.primary)
        chosen = primary_quote or next(iter(quotes.values()))
        name = chosen.name

        prices = [q.price for q in quotes.values() if q.price]
        divergence = 0.0
        if len(prices) >= 2:
            hi, lo = max(prices), min(prices)
            divergence = (hi - lo) / hi if hi else 0.0

        # 某个源的时间戳明显落后于其它源，说明该源卡住了
        stale = False
        times = [q.quote_time for q in quotes.values() if q.quote_time]
        if times:
            newest = max(times)
            for quote in quotes.values():
                if quote.quote_time and (newest - quote.quote_time).total_seconds() > self.stale_seconds:
                    stale = True
                    logger.warning(
                        "数据源 %s 行情时间戳落后 %s 秒（最新 %s）",
                        quote.source,
                        (newest - quote.quote_time).total_seconds(),
                        newest,
                    )

        return AggregatedQuote(
            code=code,
            name=name,
            quote=chosen,
            quotes=quotes,
            divergence=divergence,
            stale=stale,
            errors=dict(errors),
        )

    def close(self) -> None:
        for source in self._sources.values():
            close = getattr(source, "close", None)
            if callable(close):
                close()
