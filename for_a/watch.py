"""监控主循环。"""

from __future__ import annotations

import logging
import signal
import time
from datetime import datetime
from typing import Dict, List, Optional

from .aggregator import Aggregator
from .alerts import build_alerters
from .config import Config
from .http import HttpClient
from .models import Alert, Announcement, normalize_code
from .rules import RuleContext, build_announcement_rules, build_rules
from .sources.cninfo import CninfoSource
from .storage import Storage

logger = logging.getLogger(__name__)


class Watcher:
    """把数据源、规则、告警出口串成一条链路。"""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.codes = [normalize_code(code) for code in config.watchlist]
        self.client = HttpClient(
            timeout=config.sources.timeout,
            retries=config.sources.retries,
            min_interval=config.sources.min_interval,
        )
        self.aggregator = Aggregator(
            client=self.client,
            primary=config.sources.primary,
            verify=config.sources.verify,
            divergence_tolerance=config.sources.divergence_tolerance,
        )
        self.storage = Storage(config.storage.path)
        self.rules = build_rules(config)
        self.announcement_rules = build_announcement_rules(config)
        self.alerters = build_alerters(config.alerts)
        self.cninfo = CninfoSource(self.client)
        self._last_announcement_at: Optional[datetime] = None
        self._running = False

    # ---------- 单次轮询 ----------

    def run_once(self) -> List[Alert]:
        """执行一轮：拉数 -> 规则 -> 去重 -> 投递。返回本轮新告警。"""
        if not self.codes:
            logger.warning("自选股列表为空，无事可做")
            return []

        aggregated = self.aggregator.fetch(self.codes)
        ctx = RuleContext(storage=self.storage, now=datetime.now())
        fresh: List[Alert] = []

        for code, item in aggregated.items():
            if not item.ok:
                logger.error("行情获取失败 %s: %s", code, item.errors)
                continue

            quote = item.quote
            assert quote is not None

            for alert in self._divergence_alerts(item):
                if self._accept(alert):
                    fresh.append(alert)

            for rule in self.rules:
                for alert in rule.evaluate(quote, ctx):
                    if self._accept(alert):
                        fresh.append(alert)

            # 必须在规则评估之后再落盘，否则放量规则读到的就是本次数据
            self.storage.save_quote(quote)

        fresh.extend(self._check_announcements(ctx))

        if fresh:
            for alerter in self.alerters:
                alerter.send(fresh)
        return fresh

    def _divergence_alerts(self, item) -> List[Alert]:
        """多源价格分歧超阈值时提示，避免在错数据上做决策。"""
        tolerance = self.config.sources.divergence_tolerance
        if item.divergence <= tolerance:
            return []
        prices = {name: q.price for name, q in item.quotes.items() if q.price}
        detail = "、".join(f"{name}={price}" for name, price in prices.items())
        alert = Alert(
            rule="divergence",
            code=item.code,
            name=item.name,
            message=(
                f"{item.name}({item.code}) 多源价格分歧 {item.divergence * 100:.2f}%"
                f"（超过阈值 {tolerance * 100:.2f}%）：{detail}"
            ),
            level="warning",
            quote_time=item.quote.quote_time if item.quote else None,
            payload={"divergence": item.divergence, "prices": prices},
        )
        return [alert]

    # ---------- 公告 ----------

    def _check_announcements(self, ctx: RuleContext) -> List[Alert]:
        if not self.announcement_rules:
            return []
        now = datetime.now()
        interval = self.config.poll.announcement_interval_seconds
        if (
            self._last_announcement_at is not None
            and (now - self._last_announcement_at).total_seconds() < interval
        ):
            return []
        self._last_announcement_at = now

        try:
            announcements = self.cninfo.fetch_recent(
                self.config.rules.announcement.page_size
            )
        except Exception as exc:  # noqa: BLE001
            logger.error("公告拉取失败: %s", exc)
            return []

        fresh: List[Alert] = []
        for announcement in announcements:
            if announcement.announcement_id and self.storage.seen_announcement(
                announcement.announcement_id
            ):
                continue
            for rule in self.announcement_rules:
                for alert in rule.evaluate(announcement, ctx):
                    if self._accept(alert):
                        fresh.append(alert)
            if announcement.announcement_id:
                self.storage.mark_announcement(
                    announcement.announcement_id,
                    announcement.code,
                    announcement.title,
                    announcement.publish_time.isoformat(timespec="seconds"),
                )
        return fresh

    # ---------- 去重 ----------

    def _accept(self, alert: Alert) -> bool:
        """告警去重：同一条告警在窗口期内只投递一次。"""
        key = self._alert_key(alert)
        if self.storage.seen_alert(key):
            return False
        self.storage.mark_alert(key)
        return True

    @staticmethod
    def _alert_key(alert: Alert) -> str:
        if alert.rule == "announcement_keyword":
            ann_id = alert.payload.get("announcement_id") or alert.payload.get("title")
            return f"announcement:{alert.code}:{ann_id}"
        if alert.rule == "price_change":
            return f"price_change:{alert.code}:{round(float(alert.payload.get('change_pct', 0)), 1)}"
        if alert.rule == "limit":
            return f"limit:{alert.code}:{alert.payload.get('state')}"
        if alert.rule == "turnover":
            return f"turnover:{alert.code}:{int(float(alert.payload.get('turnover', 0)))}"
        if alert.rule == "volume_surge":
            bucket = int(datetime.now().timestamp() // 300)
            return f"volume_surge:{alert.code}:{bucket}"
        if alert.rule == "divergence":
            return f"divergence:{alert.code}:{round(float(alert.payload.get('divergence', 0)), 3)}"
        return f"{alert.rule}:{alert.code}"

    # ---------- 常驻循环 ----------

    def stop(self, *_: object) -> None:
        logger.info("收到停止信号")
        self._running = False

    def run_forever(self) -> None:
        """按配置的间隔常驻轮询。"""
        self._running = True
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                signal.signal(sig, self.stop)
            except (ValueError, OSError):  # 非主线程时不可注册
                pass

        interval = max(1, self.config.poll.interval_seconds)
        logger.info("监控启动：%s 个标的，每 %s 秒轮询", len(self.codes), interval)
        while self._running:
            started = time.monotonic()
            try:
                alerts = self.run_once()
                if alerts:
                    logger.info("本轮产生 %s 条新告警", len(alerts))
            except Exception as exc:  # noqa: BLE001 —— 单轮失败不应终止监控
                logger.exception("轮询异常: %s", exc)
            elapsed = time.monotonic() - started
            time.sleep(max(0.5, interval - elapsed))
        self.close()

    def close(self) -> None:
        self.aggregator.close()
        self.storage.close()
