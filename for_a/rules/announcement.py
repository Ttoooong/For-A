"""公告类规则：关键词命中。"""

from __future__ import annotations

from typing import List

from ..models import Alert, Announcement
from .base import AnnouncementRule, RuleContext


class AnnouncementKeywordRule(AnnouncementRule):
    """公告标题命中关键词时告警。

    默认关键词覆盖重组、停复牌、监管、业绩预告、股东变动等高信息量事件。
    """

    name = "announcement_keyword"

    def __init__(self, keywords: List[str], level: str = "info") -> None:
        self.keywords = list(keywords or [])
        self.level = level

    def evaluate(self, announcement: Announcement, ctx: RuleContext) -> List[Alert]:
        hits = [kw for kw in self.keywords if kw and kw in announcement.title]
        if not hits:
            return []
        message = (
            f"{announcement.name}({announcement.code}) 发布公告《{announcement.title}》"
            f"，命中关键词：{'、'.join(hits)}"
        )
        return [
            Alert(
                rule=self.name,
                code=announcement.code,
                name=announcement.name,
                message=message,
                level=self.level,
                payload={
                    "title": announcement.title,
                    "announcement_id": announcement.announcement_id,
                    "keywords": hits,
                    "url": announcement.url,
                    "pdf_url": announcement.pdf_url,
                    "publish_time": announcement.publish_time.isoformat(
                        timespec="seconds"
                    ),
                },
            )
        ]
