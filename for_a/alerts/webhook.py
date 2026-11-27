"""Webhook 告警出口：飞书 / 钉钉 / 企业微信 / 通用文本。"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import time
import urllib.parse
from typing import List

import requests

from ..config import WebhookConfig
from ..models import Alert
from .base import Alerter

logger = logging.getLogger(__name__)

_LEVEL_EMOJI = {"info": "��", "warning": "��", "critical": "��"}


def _lark_sign(timestamp: int, secret: str) -> str:
    """飞书自定义机器人签名：HMAC-SHA256，key 为 ``timestamp\\nsecret``，消息为空。"""
    string_to_sign = f"{timestamp}\n{secret}".encode("utf-8")
    digest = hmac.new(string_to_sign, b"", digestmod=hashlib.sha256).digest()
    return base64.b64encode(digest).decode("utf-8")


def _dingtalk_sign(timestamp: int, secret: str) -> str:
    """钉钉加签：key 为 secret，消息为 ``timestamp\\nsecret``。"""
    string_to_sign = f"{timestamp}\n{secret}".encode("utf-8")
    digest = hmac.new(secret.encode("utf-8"), string_to_sign, digestmod=hashlib.sha256).digest()
    return urllib.parse.quote_plus(base64.b64encode(digest).decode("utf-8"))


class WebhookAlerter(Alerter):
    name = "webhook"

    def __init__(self, config: WebhookConfig) -> None:
        self.config = config

    def _payload(self, alerts: List[Alert]) -> dict:
        kind = self.config.type
        lines = []
        for alert in alerts:
            emoji = _LEVEL_EMOJI.get(alert.level, "��")
            lines.append(f"{emoji} {alert.message}")
        text = "\n".join(lines)

        if kind == "lark":
            body = {"msg_type": "text", "content": {"text": text}}
            if self.config.secret:
                timestamp = int(time.time())
                body.update(
                    {
                        "timestamp": str(timestamp),
                        "sign": _lark_sign(timestamp, self.config.secret),
                    }
                )
            return body
        if kind == "dingtalk":
            body = {"msgtype": "text", "text": {"content": text}}
            if self.config.secret:
                timestamp = int(time.time())
                body["timestamp"] = str(timestamp)
                body["sign"] = _dingtalk_sign(timestamp, self.config.secret)
            return body
        if kind == "wecom":
            return {"msgtype": "text", "text": {"content": text}}
        return {"text": text}

    def send(self, alerts: List[Alert]) -> None:
        if not alerts:
            return
        url = self.config.url
        if not url:
            logger.warning("Webhook 地址为空，跳过投递")
            return
        payload = self._payload(alerts)
        try:
            resp = requests.post(url, json=payload, timeout=self.config.timeout)
            resp.raise_for_status()
            logger.info("Webhook 投递成功 %s 条", len(alerts))
        except Exception as exc:  # noqa: BLE001 —— 投递失败不应中断监控
            logger.error("Webhook 投递失败: %s", exc)
