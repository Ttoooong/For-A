"""HTTP 层：4xx 不重试、5xx 才重试、JSON 固定 utf-8、限流按 host 隔离。"""

import json
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
import requests

from for_a.http import HttpClient, RateLimiter


class _FakeResponse:
    def __init__(self, status_code, text="", headers=None):
        self.status_code = status_code
        self.text = text
        self.headers = headers or {}

    def json(self):
        return json.loads(self.text)


class _FakeSession:
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []
        self.headers = {"User-Agent": "test"}

    def request(self, method, url, **kwargs):
        self.calls.append(url)
        index = min(len(self.calls) - 1, len(self._responses) - 1)
        return self._responses[index]

    def close(self):
        pass


def _client(session, **kwargs):
    client = HttpClient(timeout=1, retries=3, backoff=0.001, **kwargs)
    client._local.session = session
    return client


def test_4xx_is_not_retried():
    """403/404 是参数或权限问题，重试没有意义。"""
    session = _FakeSession([_FakeResponse(403)])
    client = _client(session)
    with pytest.raises(requests.HTTPError):
        client.get("https://example.com/x")
    assert len(session.calls) == 1


def test_5xx_is_retried():
    session = _FakeSession([_FakeResponse(500)])
    client = _client(session)
    with pytest.raises(RuntimeError):
        client.get("https://example.com/x")
    assert len(session.calls) == 3


def test_429_is_retried():
    session = _FakeSession([_FakeResponse(429, headers={"Retry-After": "0"})])
    client = _client(session)
    with pytest.raises(RuntimeError):
        client.get("https://example.com/x")
    assert len(session.calls) == 3


def test_json_response_is_decoded_as_utf8():
    session = _FakeSession([_FakeResponse(200, '{"名称": "贵州茅台"}')])
    client = _client(session)
    assert client.get_json("https://example.com/x") == {"名称": "贵州茅台"}


def test_rate_limiter_does_not_block_other_hosts():
    """东财镜像池要并发取数，不同 host 的限流不能互相阻塞。"""
    limiter = RateLimiter(min_interval=0.5)
    limiter.wait("host-a")  # 记录 host-a 的时间戳
    with ThreadPoolExecutor(max_workers=2) as pool:
        slow = pool.submit(limiter.wait, "host-a")  # 需要等 0.5s，期间持有 host-a 的锁
        time.sleep(0.05)
        started = time.monotonic()
        pool.submit(limiter.wait, "host-b").result()  # host-b 不该被 host-a 拖住
        elapsed = time.monotonic() - started
        slow.result()
    assert elapsed < 0.3
