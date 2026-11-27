"""告警出口注册表。"""

from __future__ import annotations

from ..config import AlertChannelConfig
from .base import Alerter
from .console import ConsoleAlerter
from .webhook import WebhookAlerter

__all__ = ["Alerter", "ConsoleAlerter", "WebhookAlerter", "build_alerters"]


def build_alerters(channels: list[AlertChannelConfig]) -> list[Alerter]:
    """按配置构造告警通道。"""
    alerters: list[Alerter] = []
    for channel in channels:
        if channel.type == "console":
            alerters.append(ConsoleAlerter())
        elif channel.type == "webhook":
            alerters.append(WebhookAlerter(channel.webhook))
        else:
            raise ValueError(f"未知告警通道类型: {channel.type}")
    return alerters
