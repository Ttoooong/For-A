"""标准化数据模型与证券代码规范化。

不同数据源对代码、成交量、复权口径的处理各不相同，本模块把所有差异收敛到
统一的 :class:`Quote` / :class:`Announcement` 结构上。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional, Tuple, Union

# 代码前缀 -> 交易所。必须按前缀长度倒序匹配，否则 "60" 会吃掉 "688"。
_MARKET_BY_PREFIX: Tuple[Tuple[str, str], ...] = (
    ("688", "SH"),
    ("689", "SH"),
    ("300", "SZ"),
    ("301", "SZ"),
    ("430", "BJ"),
    ("830", "BJ"),
    ("870", "BJ"),
    ("871", "BJ"),
    ("872", "BJ"),
    ("873", "BJ"),
    ("920", "BJ"),
    ("600", "SH"),
    ("601", "SH"),
    ("603", "SH"),
    ("605", "SH"),
    ("000", "SZ"),
    ("001", "SZ"),
    ("002", "SZ"),
    ("003", "SZ"),
    ("580", "SH"),
    ("510", "SH"),
    ("511", "SH"),
    ("512", "SH"),
    ("513", "SH"),
    ("515", "SH"),
    ("588", "SH"),
    ("159", "SZ"),
    ("150", "SZ"),
    ("151", "SZ"),
    ("152", "SZ"),
    ("161", "SZ"),
    ("162", "SZ"),
    ("163", "SZ"),
    ("164", "SZ"),
    ("165", "SZ"),
    ("166", "SZ"),
    ("167", "SZ"),
    ("168", "SZ"),
    ("169", "SZ"),
)

_EASTMONEY_MARKET_PREFIX = {"SH": "1", "SZ": "0", "BJ": "0"}

# 各板块涨跌停幅度（%），用于源端未提供涨跌停价时推算
_LIMIT_PCT_BY_PREFIX: Tuple[Tuple[str, float], ...] = (
    ("300", 20.0),
    ("301", 20.0),
    ("688", 20.0),
    ("689", 20.0),
    ("43", 30.0),
    ("83", 30.0),
    ("87", 30.0),
    ("88", 30.0),
    ("92", 30.0),
)


class SymbolError(ValueError):
    """证券代码无法识别。"""


def resolve_market(digits: str) -> str:
    """按数字前缀推断交易所。"""
    for prefix, market in _MARKET_BY_PREFIX:
        if digits.startswith(prefix):
            return market
    raise SymbolError(f"无法推断交易所: {digits}")


def normalize_code(raw: Union[str, int]) -> str:
    """把各种写法统一成 ``600519.SH`` 形式。

    支持 ``600519`` / ``sh600519`` / ``600519.sh`` / ``SH600519``。
    YAML 会把 ``000001`` 解析成整数 1，这里按 6 位补零还原。
    """
    if isinstance(raw, int) and not isinstance(raw, bool):
        raw = str(raw).zfill(6)
    s = str(raw).strip().lower().replace(" ", "")
    if not s:
        raise SymbolError("证券代码为空")
    if "." in s:
        digits, _, suffix = s.partition(".")
        suffix = suffix.upper()
        if suffix not in ("SH", "SZ", "BJ"):
            raise SymbolError(f"无法识别的交易所后缀: {raw}")
        if not digits.isdigit():
            raise SymbolError(f"无法识别的证券代码: {raw}")
        return f"{digits}.{suffix}"
    for market in ("sh", "sz", "bj"):
        if s.startswith(market):
            digits = s[2:]
            if not digits.isdigit():
                raise SymbolError(f"无法识别的证券代码: {raw}")
            return f"{digits}.{market.upper()}"
    if s.isdigit():
        return f"{s}.{resolve_market(s)}"
    raise SymbolError(f"无法识别的证券代码: {raw}")


def split_code(code: str) -> Tuple[str, str]:
    """``"600519.SH"`` -> ``("600519", "SH")``。"""
    digits, _, market = normalize_code(code).partition(".")
    return digits, market


def tencent_symbol(code: str) -> str:
    """腾讯行情代码，例如 ``sh600519``。"""
    digits, market = split_code(code)
    return f"{market.lower()}{digits}"


def sina_symbol(code: str) -> str:
    """新浪行情代码，例如 ``sh600519``。"""
    return tencent_symbol(code)


def eastmoney_secid(code: str) -> str:
    """东方财富 secid，例如 ``1.600519``。"""
    digits, market = split_code(code)
    return f"{_EASTMONEY_MARKET_PREFIX.get(market, '1')}.{digits}"


def guess_limit_pct(code: str) -> float:
    """按板块推断涨跌停幅度（%）。"""
    digits, _ = split_code(code)
    for prefix, pct in _LIMIT_PCT_BY_PREFIX:
        if digits.startswith(prefix):
            return pct
    return 10.0


@dataclass(slots=True)
class Quote:
    """归一化后的实时行情快照。

    成交量统一为 **股**，成交额统一为 **元**，价格统一为 **元**。
    """

    code: str
    name: str
    price: float
    prev_close: float
    open: float = 0.0
    high: float = 0.0
    low: float = 0.0
    volume: float = 0.0
    amount: float = 0.0
    change: float = 0.0
    change_pct: float = 0.0
    turnover: float = 0.0
    amplitude: float = 0.0
    pe: float = 0.0
    pb: float = 0.0
    total_mv: float = 0.0
    float_mv: float = 0.0
    limit_up: Optional[float] = None
    limit_down: Optional[float] = None
    bids: List[Tuple[float, float]] = field(default_factory=list)
    asks: List[Tuple[float, float]] = field(default_factory=list)
    quote_time: Optional[datetime] = None
    source: str = ""

    @property
    def digits(self) -> str:
        return split_code(self.code)[0]

    @property
    def is_limit_up(self) -> bool:
        if self.limit_up:
            return self.price >= self.limit_up - 1e-6
        pct = guess_limit_pct(self.code)
        return self.prev_close > 0 and self.change_pct >= pct - 0.3

    @property
    def is_limit_down(self) -> bool:
        if self.limit_down:
            return self.price <= self.limit_down + 1e-6
        pct = guess_limit_pct(self.code)
        return self.prev_close > 0 and self.change_pct <= -pct + 0.3

    @property
    def stale_seconds(self) -> Optional[float]:
        """行情时间与本地时间的差值（秒），用于识别卡住的数据源。"""
        if self.quote_time is None:
            return None
        import datetime as _dt

        return (_dt.datetime.now() - self.quote_time).total_seconds()


@dataclass(slots=True)
class Announcement:
    """上市公司公告。"""

    code: str
    name: str
    title: str
    publish_time: datetime
    url: str
    pdf_url: str = ""
    announcement_id: str = ""
    source: str = "cninfo"


@dataclass(slots=True)
class Alert:
    """一条告警。"""

    rule: str
    code: str
    name: str
    message: str
    level: str = "info"
    quote_time: Optional[datetime] = None
    payload: Dict[str, object] = field(default_factory=dict)


@dataclass(slots=True)
class AggregatedQuote:
    """多源交叉校验后的结果。

    ``quotes`` 保存每个源的原始快照，``quote`` 是选定的主源结果。
    ``stale`` 表示选中的数据来自一个卡住的源（主源时间戳落后时会被降级替换），
    ``stale_source`` / ``stale_lag`` 记录卡住的源与落后秒数。
    """

    code: str
    name: str
    quote: Optional[Quote]
    quotes: Dict[str, Quote] = field(default_factory=dict)
    divergence: float = 0.0
    stale: bool = False
    stale_source: str = ""
    stale_lag: float = 0.0
    errors: Dict[str, str] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.quote is not None
