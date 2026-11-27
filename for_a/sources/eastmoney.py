"""东方财富行情适配器（``push2``）。

零成本、秒级，返回 JSON，最适合脚本化处理。代价是**代号制字段**：
价格类字段都要 ÷100，时间戳在 ``f86``（Unix 秒）。
"""

from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from typing import Dict, List, Sequence, Set

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
    """把 ``push2`` 的 JSON 响应转成 :class:`Quote`。

    报文缺失关键字段时返回 ``None``：宁可判定为无效，也不要产出全 0 的快照
    污染 ``quotes`` 基线、触发假的涨跌告警。
    """
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

    price = scaled("f43")
    if price <= 0:
        return None

    digits = str(data.get("f57") or fallback_code.split(".")[0])
    expected = fallback_code.split(".")[0]
    if digits != expected:
        # 报文与请求对不上：镜像在高频访问下偶尔会返回字段错位的内容
        return None
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
        price=price,
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
        self._dead_hosts: Set[str] = set()
        self._failures: Dict[str, int] = {}
        self._dead_lock = threading.Lock()

    # ---------- 镜像池 ----------

    def _mark_failure(self, host: str) -> None:
        """记录一次连接失败；连续失败才把镜像踢出本轮池子。

        单次超时多半是网络抖动，直接拉黑会让可用镜像白白损失。
        """
        with self._dead_lock:
            self._failures[host] = self._failures.get(host, 0) + 1
            if self._failures[host] >= 2:
                self._dead_hosts.add(host)
                logger.warning("东财镜像 %s 连续失败，本轮不再使用", host)

    def _active_hosts(self) -> List[str]:
        with self._dead_lock:
            alive = [host for host in self.hosts if host not in self._dead_hosts]
        return alive or list(self.hosts)

    def _get(self, code: str) -> dict:
        """按镜像顺序重试，直到某一台返回可校验的 JSON。

        校验三件事：``data`` 是非空 dict、返回的代码与请求一致、最新价有效。
        镜像在高频访问下偶尔会返回字段错位的报文，不校验就会污染数据。
        """
        params = {"secid": eastmoney_secid(code), "fields": FIELDS}
        expected = code.split(".")[0]
        last_error: Exception | None = None
        for host in self._active_hosts():
            try:
                payload = self.client.get_json(
                    f"{host}{ENDPOINT}",
                    params=params,
                    headers={"Referer": REFERER},
                )
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                logger.warning("东财镜像 %s 请求失败: %s", host, exc)
                self._mark_failure(host)
                continue
            data = payload.get("data")
            if not isinstance(data, dict) or not data:
                last_error = RuntimeError(f"{host} 返回空 data")
                continue
            returned = str(data.get("f57") or "")
            if returned != expected:
                last_error = RuntimeError(f"{host} 返回代码 {returned}，与请求 {expected} 不符")
                logger.warning("东财镜像 %s 报文代码不匹配: %s != %s", host, returned, expected)
                continue
            try:
                price = float(data.get("f43")) / 100.0
            except (TypeError, ValueError):
                price = 0.0
            if price <= 0:
                last_error = RuntimeError(f"{host} 返回的最新价无效")
                continue
            return payload
        raise RuntimeError(f"东财所有镜像均失败: {last_error}")

    def _fetch_shard(self, codes: Sequence[str]) -> Dict[str, Quote]:
        """取一个分片的行情。单个代码失败不影响同分片的其它代码。"""
        result: Dict[str, Quote] = {}
        for code in codes:
            try:
                payload = self._get(code)
            except Exception as exc:  # noqa: BLE001
                logger.warning("东财取数失败 %s: %s", code, exc)
                continue
            quote = parse_eastmoney_payload(payload, code)
            if quote is not None:
                result[quote.code] = quote
        return result

    def fetch(self, codes: List[str]) -> Dict[str, Quote]:
        """批量拉取行情。

        代码按镜像分片后并发取数——东财的批量端点不可用，逐代码串行的墙钟时间
        会随自选股数量线性增长，把轮询间隔吃光。
        """
        if not codes or not self.hosts:
            return {}

        # 熔断状态按轮重置：某个镜像只是这一轮挂了，不该永久下线
        with self._dead_lock:
            self._dead_hosts.clear()
            self._failures.clear()

        shards: List[List[str]] = [[] for _ in self.hosts]
        for index, code in enumerate(codes):
            shards[index % len(self.hosts)].append(code)

        result: Dict[str, Quote] = {}
        workers = min(len(self.hosts), len(codes))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {
                pool.submit(self._fetch_shard, shard): shard
                for shard in shards
                if shard
            }
            for future in as_completed(futures):
                try:
                    result.update(future.result())
                except Exception as exc:  # noqa: BLE001
                    logger.warning("东财分片失败: %s", exc)

        if not result:
            # 某些网络环境（如限制并发的代理）会掐掉并发连接，这时退回串行，
            # 宁可慢一点也不能丢覆盖
            logger.warning("东财并发取数未取到数据，回退串行")
            for code in codes:
                try:
                    payload = self._get(code)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("东财取数失败 %s: %s", code, exc)
                    continue
                quote = parse_eastmoney_payload(payload, code)
                if quote is not None:
                    result[quote.code] = quote
        return result
