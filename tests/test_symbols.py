"""证券代码归一化测试。"""

import pytest

from for_a.models import (
    SymbolError,
    eastmoney_secid,
    guess_limit_pct,
    normalize_code,
    sina_symbol,
    tencent_symbol,
)


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("600519", "600519.SH"),
        ("sh600519", "600519.SH"),
        ("SH600519", "600519.SH"),
        ("600519.SH", "600519.SH"),
        ("600519.sh", "600519.SH"),
        ("000001", "000001.SZ"),
        ("sz000001", "000001.SZ"),
        ("300750", "300750.SZ"),
        ("688981", "688981.SH"),
        ("  600519  ", "600519.SH"),
    ],
)
def test_normalize_code(raw, expected):
    assert normalize_code(raw) == expected


@pytest.mark.parametrize("raw", ["", "abc", "600519.XX", "shABC"])
def test_normalize_code_rejects_garbage(raw):
    with pytest.raises(SymbolError):
        normalize_code(raw)


def test_source_symbols():
    assert tencent_symbol("600519") == "sh600519"
    assert sina_symbol("000001") == "sz000001"
    assert eastmoney_secid("600519") == "1.600519"
    assert eastmoney_secid("000001") == "0.000001"
    assert eastmoney_secid("300750") == "0.300750"


def test_limit_pct_by_board():
    assert guess_limit_pct("600519") == 10.0
    assert guess_limit_pct("000001") == 10.0
    assert guess_limit_pct("300750") == 20.0
    assert guess_limit_pct("688981") == 20.0
    assert guess_limit_pct("920002") == 30.0
