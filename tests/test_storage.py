"""存储层：规则状态、告警清理。"""

import pytest

from for_a.storage import Storage


@pytest.fixture()
def storage(tmp_path):
    store = Storage(str(tmp_path / "store.db"))
    yield store
    store.close()


def test_rule_state_roundtrip(storage):
    assert storage.get_state("price_change:600519.SH") is None
    storage.set_state("price_change:600519.SH", "up")
    assert storage.get_state("price_change:600519.SH") == "up"
    storage.set_state("price_change:600519.SH", "")
    assert storage.get_state("price_change:600519.SH") == ""


def _backdate(storage, table, key, column="updated_at"):
    storage.conn.execute(
        f"UPDATE {table} SET {column} = ? WHERE key = ?", ("2020-01-01T00:00:00", key)
    )


def test_prune_states_keeps_active_rows(storage):
    storage.set_state("k", "up")
    _backdate(storage, "rule_states", "k")
    assert storage.prune_states(keep_days=7) == 0
    assert storage.get_state("k") == "up"


def test_prune_states_removes_reset_rows(storage):
    storage.set_state("k", "")
    _backdate(storage, "rule_states", "k")
    assert storage.prune_states(keep_days=7) == 1
    assert storage.get_state("k") is None


def test_prune_alerts_removes_expired_keys(storage):
    storage.mark_alert("old")
    storage.conn.execute(
        "UPDATE alerts SET created_at = ?", ("2020-01-01T00:00:00",)
    )
    assert storage.prune_alerts(keep_days=7) == 1
    assert not storage.seen_alert("old")


def test_prune_alerts_keeps_recent_keys(storage):
    storage.mark_alert("fresh")
    assert storage.prune_alerts(keep_days=7) == 0
    assert storage.seen_alert("fresh")
