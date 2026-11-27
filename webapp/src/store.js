// 进程内状态与自选股持久化。
// 自选写盘放在可写目录；只读文件系统时自动降级为内存保存。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { alertKey } from './rules.js';

function resolveDataDir() {
  const candidates = [
    process.env.FOR_A_DATA_DIR,
    path.join(process.env.TMPDIR || '/tmp', 'for-a-webapp'),
    path.join(os.tmpdir(), 'for-a-webapp'),
    path.join(process.cwd(), 'data'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      // 换下一个候选目录
    }
  }
  return os.tmpdir();
}

const DATA_DIR = resolveDataDir();
const WATCHLIST_FILE = path.join(DATA_DIR, 'watchlist.json');

const DEFAULT_CODES = ['600519.SH', '000001.SZ', '300750.SZ', '688981.SH', '601318.SH', '000858.SZ'];
const MAX_WATCH = 60;
const ALERT_CAP = 300;
const ALERT_TTL_MS = 7 * 24 * 3600 * 1000;

class Store {
  constructor() {
    this.watchlist = [];
    this.alerts = [];
    this.alertKeys = new Map();
    this.lastQuotes = new Map();
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8'));
      const codes = Array.isArray(parsed.codes) ? parsed.codes.filter((c) => typeof c === 'string') : [];
      this.watchlist = codes.length ? codes : [...DEFAULT_CODES];
    } catch {
      this.watchlist = [...DEFAULT_CODES];
    }
  }

  persist() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(WATCHLIST_FILE, JSON.stringify({ codes: this.watchlist }, null, 2));
    } catch {
      // 只读文件系统：保留内存态即可
    }
  }

  has(code) {
    return this.watchlist.includes(code);
  }

  add(code) {
    if (this.has(code)) return { added: false, code };
    if (this.watchlist.length >= MAX_WATCH) throw new Error(`自选股最多 ${MAX_WATCH} 只`);
    this.watchlist.push(code);
    this.persist();
    return { added: true, code };
  }

  remove(code) {
    const before = this.watchlist.length;
    this.watchlist = this.watchlist.filter((c) => c !== code);
    if (this.watchlist.length !== before) this.persist();
    return this.watchlist.length !== before;
  }

  /** 告警去重：同一事件在窗口期内只接收一次。 */
  accept(alert) {
    const key = alertKey(alert);
    const seenAt = this.alertKeys.get(key);
    if (seenAt && Date.now() - seenAt < ALERT_TTL_MS) return false;
    this.alertKeys.set(key, Date.now());
    return true;
  }

  pushAlerts(list) {
    if (!list.length) return;
    this.alerts = [...list.reverse(), ...this.alerts].slice(0, ALERT_CAP);
  }

  prune() {
    const cutoff = Date.now() - ALERT_TTL_MS;
    for (const [key, ts] of this.alertKeys) {
      if (ts < cutoff) this.alertKeys.delete(key);
    }
    this.alerts = this.alerts.slice(0, ALERT_CAP);
  }
}

export const store = new Store();
