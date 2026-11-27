"""配置模型与 YAML 加载。"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import yaml

from .models import SymbolError, normalize_code

DEFAULT_ANNOUNCEMENT_KEYWORDS = [
    "重组",
    "停牌",
    "复牌",
    "立案",
    "处罚",
    "问询函",
    "关注函",
    "业绩预增",
    "业绩预亏",
    "减持",
    "增持",
    "回购",
    "质押",
    "重大资产",
    "中标",
    "业绩说明会",
]


def _normalize_watchlist(items: List[Any]) -> List[str]:
    """把自选股代码归一化成 ``600519.SH`` 形式。

    YAML 会把 ``000001`` 解析成整数 1（丢掉前导零），所以这里**保留原始类型**
    交给 :func:`normalize_code` 按 6 位补零还原，而不是先转成字符串。
    """
    codes: List[str] = []
    for item in items:
        try:
            codes.append(normalize_code(item))
        except SymbolError as exc:
            raise SymbolError(f"自选股代码非法: {item!r}（{exc}）") from exc
    return codes


@dataclass
class SourcesConfig:
    primary: str = "eastmoney"
    verify: List[str] = field(default_factory=lambda: ["tencent", "sina"])
    min_interval: float = 0.5
    timeout: float = 10.0
    retries: int = 3
    divergence_tolerance: float = 0.005


@dataclass
class PriceChangeRuleConfig:
    enabled: bool = True
    threshold_pct: float = 5.0
    level: str = "warning"


@dataclass
class LimitRuleConfig:
    enabled: bool = True
    level: str = "critical"


@dataclass
class TurnoverRuleConfig:
    enabled: bool = True
    threshold_pct: float = 10.0
    level: str = "info"


@dataclass
class VolumeSurgeRuleConfig:
    enabled: bool = True
    ratio: float = 3.0
    min_seconds: int = 60
    level: str = "warning"


@dataclass
class AnnouncementRuleConfig:
    enabled: bool = True
    keywords: List[str] = field(default_factory=lambda: list(DEFAULT_ANNOUNCEMENT_KEYWORDS))
    page_size: int = 20
    level: str = "info"


@dataclass
class RulesConfig:
    price_change: PriceChangeRuleConfig = field(default_factory=PriceChangeRuleConfig)
    limit: LimitRuleConfig = field(default_factory=LimitRuleConfig)
    turnover: TurnoverRuleConfig = field(default_factory=TurnoverRuleConfig)
    volume_surge: VolumeSurgeRuleConfig = field(default_factory=VolumeSurgeRuleConfig)
    announcement: AnnouncementRuleConfig = field(default_factory=AnnouncementRuleConfig)


@dataclass
class PollConfig:
    interval_seconds: int = 15
    announcement_interval_seconds: int = 300


@dataclass
class WebhookConfig:
    url: str = ""
    type: str = "generic"  # generic | lark | dingtalk | wecom
    secret: str = ""
    timeout: float = 10.0
    env_url: str = ""
    env_secret: str = ""


def resolve_webhook(hook: WebhookConfig) -> Tuple[str, str]:
    """返回 ``(url, secret)``，环境变量优先于配置文件。"""
    url = hook.url
    secret = hook.secret
    if hook.env_url:
        url = os.environ.get(hook.env_url, url)
    if hook.env_secret:
        secret = os.environ.get(hook.env_secret, secret)
    return url, secret


@dataclass
class AlertChannelConfig:
    type: str = "console"
    webhook: WebhookConfig = field(default_factory=WebhookConfig)


@dataclass
class StorageConfig:
    path: str = "for_a.db"


@dataclass
class Config:
    watchlist: List[str] = field(default_factory=list)
    sources: SourcesConfig = field(default_factory=SourcesConfig)
    rules: RulesConfig = field(default_factory=RulesConfig)
    poll: PollConfig = field(default_factory=PollConfig)
    alerts: List[AlertChannelConfig] = field(default_factory=lambda: [AlertChannelConfig()])
    storage: StorageConfig = field(default_factory=StorageConfig)

    def __post_init__(self) -> None:
        """自选股代码在构造时统一归一化，之后各处都拿到 ``600519.SH`` 形式。"""
        self.watchlist = _normalize_watchlist(self.watchlist)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Config":
        data = data or {}
        sources = data.get("sources") or {}
        rules = data.get("rules") or {}
        poll = data.get("poll") or {}
        storage = data.get("storage") or {}

        alert_channels: List[AlertChannelConfig] = []
        for item in data.get("alerts") or []:
            hook = item.get("webhook") or {}
            alert_channels.append(
                AlertChannelConfig(
                    type=item.get("type", "console"),
                    webhook=WebhookConfig(
                        url=hook.get("url", ""),
                        type=hook.get("type", "generic"),
                        secret=hook.get("secret", ""),
                        timeout=float(hook.get("timeout", 10.0)),
                        env_url=hook.get("env_url", ""),
                        env_secret=hook.get("env_secret", ""),
                    ),
                )
            )
        if not alert_channels:
            alert_channels = [AlertChannelConfig()]

        return cls(
            watchlist=list(data.get("watchlist") or []),
            sources=SourcesConfig(
                primary=sources.get("primary", "eastmoney"),
                verify=list(sources.get("verify") or ["tencent", "sina"]),
                min_interval=float(sources.get("min_interval", 0.5)),
                timeout=float(sources.get("timeout", 10.0)),
                retries=int(sources.get("retries", 3)),
                divergence_tolerance=float(sources.get("divergence_tolerance", 0.005)),
            ),
            rules=RulesConfig(
                price_change=PriceChangeRuleConfig(
                    **{
                        k: v
                        for k, v in (rules.get("price_change") or {}).items()
                        if k in PriceChangeRuleConfig.__dataclass_fields__
                    }
                ),
                limit=LimitRuleConfig(
                    **{
                        k: v
                        for k, v in (rules.get("limit") or {}).items()
                        if k in LimitRuleConfig.__dataclass_fields__
                    }
                ),
                turnover=TurnoverRuleConfig(
                    **{
                        k: v
                        for k, v in (rules.get("turnover") or {}).items()
                        if k in TurnoverRuleConfig.__dataclass_fields__
                    }
                ),
                volume_surge=VolumeSurgeRuleConfig(
                    **{
                        k: v
                        for k, v in (rules.get("volume_surge") or {}).items()
                        if k in VolumeSurgeRuleConfig.__dataclass_fields__
                    }
                ),
                announcement=AnnouncementRuleConfig(
                    **{
                        k: v
                        for k, v in (rules.get("announcement") or {}).items()
                        if k in AnnouncementRuleConfig.__dataclass_fields__
                    }
                ),
            ),
            poll=PollConfig(
                interval_seconds=int(poll.get("interval_seconds", 15)),
                announcement_interval_seconds=int(
                    poll.get("announcement_interval_seconds", 300)
                ),
            ),
            alerts=alert_channels,
            storage=StorageConfig(path=storage.get("path", "for_a.db")),
        )


def load_config(path: Optional[str]) -> Config:
    """从 YAML 文件加载配置；``path`` 为空时返回默认配置。"""
    if not path:
        return Config()
    if not os.path.exists(path):
        raise FileNotFoundError(f"配置文件不存在: {path}")
    with open(path, "r", encoding="utf-8") as fp:
        try:
            data = yaml.safe_load(fp) or {}
        except yaml.YAMLError as exc:
            raise ValueError(f"配置文件格式有误: {path}（{exc}）") from exc
    return Config.from_dict(data)
