"""配置层测试：代码归一化、Webhook 环境变量。"""

import pytest

from for_a.alerts import build_alerters
from for_a.config import AlertChannelConfig, Config, WebhookConfig, resolve_webhook
from for_a.models import SymbolError


def test_watchlist_keeps_leading_zero():
    """YAML 把 000001 解析成整数 1，归一化时必须把前导零补回来。"""
    config = Config.from_dict({"watchlist": [600519, 1, "300750"]})
    assert config.watchlist == ["600519.SH", "000001.SZ", "300750.SZ"]


def test_watchlist_accepts_every_writing():
    config = Config(watchlist=["600519", "sz000001", "300750.SZ", "SZ300750"])
    assert config.watchlist == ["600519.SH", "000001.SZ", "300750.SZ", "300750.SZ"]


def test_invalid_watchlist_reports_the_original_value():
    with pytest.raises(SymbolError) as excinfo:
        Config(watchlist=["BADCODE"])
    assert "BADCODE" in str(excinfo.value)


def test_webhook_env_var_wins_over_config(monkeypatch):
    monkeypatch.setenv("FORA_TEST_URL", "https://example.com/hook")
    monkeypatch.setenv("FORA_TEST_SECRET", "from-env")
    hook = WebhookConfig(
        url="https://from-file/hook",
        secret="from-file",
        env_url="FORA_TEST_URL",
        env_secret="FORA_TEST_SECRET",
    )
    assert resolve_webhook(hook) == ("https://example.com/hook", "from-env")


def test_webhook_falls_back_to_config_when_env_missing(monkeypatch):
    monkeypatch.delenv("FORA_TEST_URL", raising=False)
    hook = WebhookConfig(
        url="https://from-file/hook", secret="from-file", env_url="FORA_TEST_URL"
    )
    assert resolve_webhook(hook) == ("https://from-file/hook", "from-file")


def test_build_alerters_applies_env_vars(monkeypatch):
    """告警通道必须拿到环境变量里的地址，否则告警会被静默丢掉。"""
    monkeypatch.setenv("FORA_TEST_URL", "https://example.com/hook")
    config = Config(
        alerts=[
            AlertChannelConfig(
                type="webhook",
                webhook=WebhookConfig(type="lark", env_url="FORA_TEST_URL"),
            )
        ]
    )
    alerter = build_alerters(config.alerts)[0]
    assert alerter.config.url == "https://example.com/hook"
    assert alerter.config.type == "lark"


def test_build_alerters_rejects_unknown_channel():
    with pytest.raises(ValueError):
        build_alerters([AlertChannelConfig(type="carrier-pigeon")])
