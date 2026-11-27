"""巨潮资讯网公告适配器。

巨潮是证监会指定的法定信息披露平台，A 股全市场公告的权威来源。
公开接口有两个：

* ``POST /new/information/topSearch/query`` —— 证券代码 -> ``orgId``
* ``POST /new/hisAnnouncement/query`` —— 公告列表（支持按 ``代码,orgId`` 精确过滤）

注意：``seDate`` 参数在当前版本会导致返回 0 条，因此改为拉取后在本地按时间过滤
（``fetch_recent`` 默认只保留最近 7 天）。
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional

from ..http import HttpClient
from ..models import Announcement, split_code
from .base import QuoteSource

logger = logging.getLogger(__name__)

SEARCH_ENDPOINT = "https://www.cninfo.com.cn/new/information/topSearch/query"
QUERY_ENDPOINT = "https://www.cninfo.com.cn/new/hisAnnouncement/query"
DETAIL_ENDPOINT = "https://www.cninfo.com.cn/new/disclosure/detail"
STATIC_ENDPOINT = "https://static.cninfo.com.cn/"

# 交易所 -> 巨潮 column 取值
_COLUMN_BY_MARKET = {"SH": "sse", "SZ": "szse", "BJ": "bj"}

# 默认只保留最近 N 天的公告（seDate 不可用时的本地兜底过滤）
DEFAULT_MAX_AGE_DAYS = 7


def _recent(announcements: List[Announcement], max_age_days: int) -> List[Announcement]:
    """丢掉 ``max_age_days`` 之前的公告。"""
    if not max_age_days:
        return announcements
    cutoff = datetime.now() - timedelta(days=max_age_days)
    return [ann for ann in announcements if ann.publish_time >= cutoff]


class CninfoSource(QuoteSource):
    name = "cninfo"

    def __init__(self, client: HttpClient) -> None:
        self.client = client
        self._org_ids: Dict[str, str] = {}

    def resolve_org_id(self, code: str) -> Optional[str]:
        """查证券的 ``orgId``（公告查询按代码过滤时必需）。"""
        digits, _ = split_code(code)
        if digits in self._org_ids:
            return self._org_ids[digits]
        try:
            payload = self.client.post_json(
                SEARCH_ENDPOINT,
                data={"keyWord": digits, "maxNum": "10"},
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("巨潮 orgId 查询失败 %s: %s", digits, exc)
            return None
        for item in payload or []:
            if str(item.get("code")) == digits and item.get("orgId"):
                self._org_ids[digits] = str(item["orgId"])
                return self._org_ids[digits]
        return None

    def _query(self, column: str, stock: str, page_size: int) -> List[dict]:
        try:
            payload = self.client.post_json(
                QUERY_ENDPOINT,
                data={
                    "pageNum": "1",
                    "pageSize": str(page_size),
                    "column": column,
                    "tabName": "fulltext",
                    "stock": stock,
                    "searchkey": "",
                    "secid": "",
                    "plate": "",
                    "category": "",
                    "trade": "",
                    "seDate": "",
                    "sortName": "",
                    "sortType": "",
                    "isHLtitle": "true",
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("巨潮公告查询失败 %s: %s", stock, exc)
            return []
        return payload.get("announcements") or []

    def fetch(
        self,
        codes: List[str],
        page_size: int = 20,
        max_age_days: int = 0,
    ) -> Dict[str, List[Announcement]]:
        """按证券代码拉取公告。返回 ``{code: [Announcement, ...]}``。

        ``max_age_days=0`` 表示不过滤——按代码查询是用户明确指定的，应把该股票
        的公告都列出来，不该被时间窗截断。
        """
        result: Dict[str, List[Announcement]] = {}
        for code in codes:
            digits, market = split_code(code)
            org_id = self.resolve_org_id(code)
            if not org_id:
                continue
            column = _COLUMN_BY_MARKET.get(market, "szse")
            items = self._query(column, f"{digits},{org_id}", page_size)
            announcements = []
            for item in items:
                ts = item.get("announcementTime")
                publish_time = (
                    datetime.fromtimestamp(int(ts) / 1000) if ts else datetime.now()
                )
                adjunct = str(item.get("adjunctUrl") or "")
                announcement_id = str(item.get("announcementId") or "")
                sec_code = str(item.get("secCode") or digits)
                announcements.append(
                    Announcement(
                        code=f"{sec_code}.{market}",
                        name=str(item.get("secName") or ""),
                        title=str(item.get("announcementTitle") or ""),
                        publish_time=publish_time,
                        url=(
                            f"{DETAIL_ENDPOINT}?announcementId={announcement_id}"
                            f"&stockCode={sec_code}&orgId={org_id}"
                        ),
                        pdf_url=f"{STATIC_ENDPOINT}{adjunct}" if adjunct else "",
                        announcement_id=announcement_id,
                        source="cninfo",
                    )
                )
            announcements = _recent(announcements, max_age_days)
            if announcements:
                result[code] = announcements
        return result

    def fetch_recent(
        self, page_size: int = 30, max_age_days: int = DEFAULT_MAX_AGE_DAYS
    ) -> List[Announcement]:
        """拉取全市场最新公告（沪 + 深）。"""
        items: List[dict] = []
        for column in ("sse", "szse"):
            items.extend(self._query(column, "", page_size))
        announcements = []
        for item in items:
            ts = item.get("announcementTime")
            publish_time = (
                datetime.fromtimestamp(int(ts) / 1000) if ts else datetime.now()
            )
            adjunct = str(item.get("adjunctUrl") or "")
            sec_code = str(item.get("secCode") or "")
            market = "SH" if column == "sse" else "SZ"
            announcements.append(
                Announcement(
                    code=f"{sec_code}.{market}",
                    name=str(item.get("secName") or ""),
                    title=str(item.get("announcementTitle") or ""),
                    publish_time=publish_time,
                    url=(
                        f"{DETAIL_ENDPOINT}?announcementId={item.get('announcementId')}"
                        f"&stockCode={sec_code}&orgId={item.get('orgId')}"
                    ),
                    pdf_url=f"{STATIC_ENDPOINT}{adjunct}" if adjunct else "",
                    announcement_id=str(item.get("announcementId") or ""),
                    source="cninfo",
                )
            )
        announcements.sort(key=lambda a: a.publish_time, reverse=True)
        return _recent(announcements, max_age_days)
