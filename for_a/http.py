"""共享 HTTP 客户端：统一 UA、重试、退避与按域名的最小请求间隔。

免费公开行情接口没有 SLA，这层的作用是：不要因为一次抖动就把整个监控链路打挂，
也不要因为打得太快被对方限流（东财 push2his 连续重试会直接返回空响应）。
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Dict, Optional

import requests

logger = logging.getLogger(__name__)

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


class RateLimiter:
    """按 host 维度的最小请求间隔。"""

    def __init__(self, min_interval: float = 0.5) -> None:
        self.min_interval = max(0.0, min_interval)
        self._last: Dict[str, float] = {}
        self._lock = threading.Lock()

    def wait(self, host: str) -> None:
        if self.min_interval <= 0:
            return
        with self._lock:
            now = time.monotonic()
            last = self._last.get(host, 0.0)
            delta = now - last
            if delta < self.min_interval:
                time.sleep(self.min_interval - delta)
                now = time.monotonic()
            self._last[host] = now


class HttpClient:
    """带重试与限流的 requests 封装。"""

    def __init__(
        self,
        timeout: float = 10.0,
        retries: int = 3,
        backoff: float = 1.5,
        min_interval: float = 0.5,
        user_agent: str = DEFAULT_UA,
    ) -> None:
        self.timeout = timeout
        self.retries = max(1, retries)
        self.backoff = backoff
        self.limiter = RateLimiter(min_interval)
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": user_agent})

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Optional[Dict[str, str]] = None,
        params: Optional[Dict[str, object]] = None,
        data: Optional[Dict[str, str]] = None,
    ) -> requests.Response:
        host = requests.utils.urlparse(url).netloc
        last_error: Optional[Exception] = None
        for attempt in range(1, self.retries + 1):
            self.limiter.wait(host)
            try:
                resp = self.session.request(
                    method,
                    url,
                    headers=headers,
                    params=params,
                    data=data,
                    timeout=self.timeout,
                )
                # 5xx 值得重试；4xx 直接失败（多半是参数或权限问题）
                if resp.status_code >= 500:
                    raise requests.HTTPError(f"HTTP {resp.status_code}")
                resp.raise_for_status()
                return resp
            except Exception as exc:  # noqa: BLE001 —— 统一退避重试
                last_error = exc
                logger.warning("请求失败 %s (%s/%s): %s", url, attempt, self.retries, exc)
                if attempt < self.retries:
                    time.sleep(self.backoff * attempt)
        raise RuntimeError(f"请求最终失败 {url}: {last_error}")

    def get(self, url: str, **kwargs) -> requests.Response:
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs) -> requests.Response:
        return self.request("POST", url, **kwargs)

    def get_text(self, url: str, encoding: str = "utf-8", **kwargs) -> str:
        resp = self.get(url, **kwargs)
        resp.encoding = encoding
        return resp.text

    def get_json(self, url: str, **kwargs) -> dict:
        resp = self.get(url, **kwargs)
        resp.encoding = resp.apparent_encoding or "utf-8"
        return resp.json()

    def post_json(self, url: str, **kwargs) -> dict:
        resp = self.post(url, **kwargs)
        resp.encoding = resp.apparent_encoding or "utf-8"
        return resp.json()
