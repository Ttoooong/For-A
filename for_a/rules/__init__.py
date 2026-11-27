"""规则集合。"""

from __future__ import annotations

from ..config import Config
from .announcement import AnnouncementKeywordRule
from .base import AnnouncementRule, Rule, RuleContext
from .price import LimitRule, PriceChangeRule, TurnoverRule, VolumeSurgeRule

__all__ = [
    "Rule",
    "AnnouncementRule",
    "RuleContext",
    "PriceChangeRule",
    "LimitRule",
    "TurnoverRule",
    "VolumeSurgeRule",
    "AnnouncementKeywordRule",
    "build_rules",
    "build_announcement_rules",
]


def build_rules(config: Config) -> list[Rule]:
    """按配置构造行情规则列表。"""
    rules: list[Rule] = []
    cfg = config.rules
    if cfg.price_change.enabled:
        rules.append(
            PriceChangeRule(cfg.price_change.threshold_pct, cfg.price_change.level)
        )
    if cfg.limit.enabled:
        rules.append(LimitRule(cfg.limit.level))
    if cfg.turnover.enabled:
        rules.append(TurnoverRule(cfg.turnover.threshold_pct, cfg.turnover.level))
    if cfg.volume_surge.enabled:
        rules.append(
            VolumeSurgeRule(
                cfg.volume_surge.ratio, cfg.volume_surge.min_seconds, cfg.volume_surge.level
            )
        )
    return rules


def build_announcement_rules(config: Config) -> list[AnnouncementRule]:
    cfg = config.rules.announcement
    if not cfg.enabled:
        return []
    return [AnnouncementKeywordRule(cfg.keywords, cfg.level)]
