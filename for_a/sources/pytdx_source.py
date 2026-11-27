"""通达信协议适配器（可选依赖 ``pytdx``）。

直连通达信行情服务器，能拿到**逐笔成交与盘口**，是免费源里唯一接近 tick 级的
通道，且不需要注册。需要本机安装通达信客户端（数据文件在 ``mootdx`` 里更常用，
协议直连则不依赖本地客户端）。

未安装 ``pytdx`` 时构造会抛 :class:`PytdxUnavailable`，调用方据此跳过。
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Dict, List

from ..models import Quote, split_code
from .base import QuoteSource

logger = logging.getLogger(__name__)

# 通达信行情服务器，按延迟从低到高轮换
DEFAULT_HOSTS = [
    ("119.147.212.81", 7709),
    ("218.108.98.244", 7709),
    ("123.125.108.14", 7709),
    ("115.238.56.198", 7709),
    ("124.71.187.122", 7709),
]

# 通达信市场号
_MARKET_SH = 1
_MARKET_SZ = 0


class PytdxUnavailable(RuntimeError):
    """未安装 pytdx。"""


def _import_pytdx():
    try:
        from pytdx.hq import TdxHq_API  # type: ignore
    except ImportError as exc:  # pragma: no cover - 取决于运行环境
        raise PytdxUnavailable(
            "未安装 pytdx，执行 `pip install pytdx` 后再启用通达信源"
        ) from exc
    return TdxHq_API


class PytdxSource(QuoteSource):
    name = "pytdx"

    def __init__(self, hosts: List[tuple[str, int]] | None = None) -> None:
        self.hosts = hosts or DEFAULT_HOSTS
        self._api = None
        self._api_key = None

    def _connect(self):
        if self._api is not None:
            return self._api
        TdxHq_API = _import_pytdx()
        for host, port in self.hosts:
            try:
                api = TdxHq_API(heartbeat=True)
                if api.connect(host, port, time_out=3):
                    logger.info("通达信已连接 %s:%s", host, port)
                    self._api = api
                    self._api_key = (host, port)
                    return api
            except Exception as exc:  # noqa: BLE001
                logger.warning("通达信连接失败 %s:%s —— %s", host, port, exc)
        raise RuntimeError("所有通达信行情服务器均连接失败")

    def fetch(self, codes: List[str]) -> Dict[str, Quote]:
        if not codes:
            return {}
        api = self._connect()
        result: Dict[str, Quote] = {}
        for code in codes:
            digits, market = split_code(code)
            market_id = _MARKET_SH if market == "SH" else _MARKET_SZ
            try:
                data = api.get_security_quotes([(market_id, digits)])
            except Exception as exc:  # noqa: BLE001
                logger.warning("通达信取数失败 %s: %s", code, exc)
                continue
            if not data:
                continue
            item = data[0]
            price = float(item.get("price") or 0)
            prev_close = float(item.get("last_close") or 0)
            change = round(price - prev_close, 4) if prev_close else 0.0
            change_pct = round(change / prev_close * 100, 4) if prev_close else 0.0
            result[code] = Quote(
                code=code,
                name=str(item.get("name") or ""),
                price=price,
                prev_close=prev_close,
                open=float(item.get("open") or 0),
                high=float(item.get("high") or 0),
                low=float(item.get("low") or 0),
                volume=float(item.get("vol") or 0) * 100,
                amount=float(item.get("amount") or 0),
                change=change,
                change_pct=change_pct,
                quote_time=datetime.now(),
                source="pytdx",
            )
        return result

    def close(self) -> None:
        if self._api is not None:
            try:
                self._api.disconnect()
            except Exception:  # noqa: BLE001
                pass
            self._api = None
