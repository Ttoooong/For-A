"""告警出口注册表。"""

from __future__ import annotations

from dataclasses import replace

from ..config import AlertChannelConfig, WebhookConfig, resolve_webhook
from .base import Alerter
from .console import ConsoleAlerter
from .webhook import WebhookAlerter

__all__ = ["Alerter", "ConsoleAlerter", "WebhookAlerter", "build_alerters"]


def _resolved_hook(hook: WebhookConfig) -> WebhookConfig:
    """把环境变量里的 webhook 地址/密钥落到配置上。

    环境变量优先于配置文件，密钥因此不需要写进仓库。
    """
    url, secret = resolve_webhook(hook)
    return replace(hook, url=url, secret=secret)


def build_alerters(channels: list[AlertChannelConfig]) -> list[Alerter]:
    """按配置构造告警通道。"""
    alerters: list[Alerter] = []
    for channel in channels:
        if channel.type == "console":
            alerters.append(ConsoleAlerter())
        elif channel.type == "webhook":
            alerters.append(WebhookAlerter(_resolved_hook(channel.webhook)))
        else:
            raise ValueError(f"未知告警通道类型: {channel.type}")
    return alerters
