/**
 * 持久化：告警去重、上次行情快照、已读公告。
 *
 * 去重是必需的：监控循环每 15 秒跑一次，没有去重就会把同一条异动重复推几十遍。
 *
 * 运行期文件只写 ${TMPDIR:-/tmp} 下的目录，进程重启后允许丢失：
 * 平台会清理临时目录，实例也不保证共享文件。
 */

import fs from 'node:fs';
import path from 'node:path';

export class Storage {
  constructor({ dir, keepAlerts = 500 } = {}) {
    this.dir = dir;
    this.keepAlerts = keepAlerts;
    this.file = path.join(dir, 'state.json');
    this.alerts = new Map();
    this.quotes = new Map();
    this.announcements = new Map();
    this.dirty = false;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw);
      for (const [key, value] of Object.entries(data.alerts || {})) {
        this.alerts.set(key, value);
      }
      for (const [code, value] of Object.entries(data.quotes || {})) {
        this.quotes.set(code, value);
      }
      for (const [id, value] of Object.entries(data.announcements || {})) {
        this.announcements.set(id, value);
      }
    } catch {
      // 临时目录被清理或文件损坏时，从空状态开始即可
    }
  }

  /** 写入临时目录：先建目录，再原子替换，失败不影响主流程。 */
  flush() {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const payload = {
        savedAt: new Date().toISOString(),
        alerts: Object.fromEntries(this.alerts),
        quotes: Object.fromEntries(this.quotes),
        announcements: Object.fromEntries(this.announcements),
      };
      const temporary = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(payload), 'utf8');
      fs.renameSync(temporary, this.file);
      this.dirty = false;
    } catch {
      // 磁盘不可写时静默降级为纯内存模式
    }
  }

  // ---------- 告警去重 ----------

  seenAlert(key) {
    return this.alerts.has(key);
  }

  markAlert(key) {
    this.alerts.set(key, new Date().toISOString());
    if (this.alerts.size > this.keepAlerts) {
      const oldest = [...this.alerts.entries()].sort((a, b) => a[1].localeCompare(b[1]));
      for (const [keyToDrop] of oldest.slice(0, this.alerts.size - this.keepAlerts)) {
        this.alerts.delete(keyToDrop);
      }
    }
    this.dirty = true;
  }

  // ---------- 行情快照 ----------

  saveQuote(quote) {
    this.quotes.set(quote.code, {
      code: quote.code,
      name: quote.name,
      price: quote.price,
      volume: quote.volume,
      amount: quote.amount,
      changePct: quote.changePct,
      quoteTime: quote.quoteTime,
      updatedAt: new Date().toISOString(),
    });
    this.dirty = true;
  }

  lastQuote(code) {
    return this.quotes.get(code) || null;
  }

  // ---------- 公告去重 ----------

  seenAnnouncement(announcementId) {
    return this.announcements.has(announcementId);
  }

  markAnnouncement(announcementId, code, title, publishTime) {
    this.announcements.set(announcementId, {
      code,
      title,
      publishTime,
      createdAt: new Date().toISOString(),
    });
    this.dirty = true;
  }
}

export default Storage;
