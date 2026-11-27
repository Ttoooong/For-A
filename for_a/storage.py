"""SQLite 持久化：告警去重、上次行情快照、已读公告。

去重是必需的：监控循环每 15 秒跑一次，没有去重就会把同一条异动重复推几十遍。
"""

from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timedelta
from typing import Optional

from .models import Quote


class Storage:
    def __init__(self, path: str = "for_a.db") -> None:
        self.path = path
        if path != ":memory:":
            directory = os.path.dirname(os.path.abspath(path))
            if directory:
                os.makedirs(directory, exist_ok=True)
        self.conn = sqlite3.connect(path)
        self.conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS alerts (
                key        TEXT PRIMARY KEY,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS quotes (
                code       TEXT PRIMARY KEY,
                name       TEXT,
                price      REAL,
                volume     REAL,
                amount     REAL,
                change_pct REAL,
                quote_time TEXT,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS announcements (
                id          TEXT PRIMARY KEY,
                code        TEXT,
                title       TEXT,
                publish_time TEXT,
                created_at  TEXT NOT NULL
            );
            """
        )
        self.conn.commit()

    # ---------- 告警去重 ----------

    def seen_alert(self, key: str) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM alerts WHERE key = ?", (key,)
        ).fetchone()
        return row is not None

    def mark_alert(self, key: str) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO alerts (key, created_at) VALUES (?, ?)",
            (key, datetime.now().isoformat(timespec="seconds")),
        )
        self.conn.commit()

    def prune_alerts(self, keep_days: int = 7) -> int:
        cutoff = (
            datetime.now() - timedelta(days=keep_days)
        ).isoformat(timespec="seconds")
        cursor = self.conn.execute("DELETE FROM alerts WHERE created_at < ?", (cutoff,))
        self.conn.commit()
        return cursor.rowcount

    # ---------- 行情快照 ----------

    def save_quote(self, quote: Quote) -> None:
        self.conn.execute(
            """
            INSERT OR REPLACE INTO quotes
                (code, name, price, volume, amount, change_pct, quote_time, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                quote.code,
                quote.name,
                quote.price,
                quote.volume,
                quote.amount,
                quote.change_pct,
                quote.quote_time.isoformat(timespec="seconds")
                if quote.quote_time
                else None,
                datetime.now().isoformat(timespec="seconds"),
            ),
        )
        self.conn.commit()

    def last_quote(self, code: str) -> Optional[sqlite3.Row]:
        return self.conn.execute(
            "SELECT * FROM quotes WHERE code = ?", (code,)
        ).fetchone()

    # ---------- 公告去重 ----------

    def seen_announcement(self, announcement_id: str) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM announcements WHERE id = ?", (announcement_id,)
        ).fetchone()
        return row is not None

    def mark_announcement(
        self, announcement_id: str, code: str, title: str, publish_time: str
    ) -> None:
        self.conn.execute(
            """
            INSERT OR REPLACE INTO announcements (id, code, title, publish_time, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                announcement_id,
                code,
                title,
                publish_time,
                datetime.now().isoformat(timespec="seconds"),
            ),
        )
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "Storage":
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()
