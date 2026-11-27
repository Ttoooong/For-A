"""控制台告警出口，同时把告警写入日志文件。"""

from __future__ import annotations

import logging
from typing import List

from ..models import Alert
from .base import Alerter

logger = logging.getLogger(__name__)

LEVEL_MARK = {"info": "[信息]", "warning": "[警告]", "critical": "[严重]"}


class ConsoleAlerter(Alerter):
    name = "console"

    def send(self, alerts: List[Alert]) -> None:
        if not alerts:
            return
        print(f"\n===== 触发 {len(alerts)} 条告警 =====")
        for alert in alerts:
            mark = LEVEL_MARK.get(alert.level, "[信息]")
            stamp = alert.quote_time.strftime("%H:%M:%S") if alert.quote_time else "-"
            print(f"{mark} {stamp} [{alert.rule}] {alert.message}")
            for key in ("url", "pdf_url"):
                if alert.payload.get(key):
                    print(f"        {key}: {alert.payload[key]}")
        logger.info("触发 %s 条告警", len(alerts))
