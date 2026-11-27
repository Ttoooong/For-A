/**
 * 监控主循环：把数据源、规则、告警出口串成一条链路。
 */

import { Aggregator } from './aggregator.js';
import { HttpClient } from './http.js';
import { buildAnnouncementRules, buildRules } from './rules.js';
import { CninfoSource } from './sources/cninfo.js';
import { Storage } from './storage.js';
import { normalizeCode } from './symbols.js';

export class Watcher {
  constructor(config) {
    this.config = config;
    this.codes = config.watchlist.map((code) => normalizeCode(code));
    this.client = new HttpClient({
      timeout: config.http.timeout,
      retries: config.http.retries,
      backoff: config.http.backoff,
      minInterval: config.http.minInterval,
    });
    this.aggregator = new Aggregator({
      client: this.client,
      primary: config.sources.primary,
      verify: config.sources.verify,
      divergenceTolerance: config.sources.divergenceTolerance,
      staleSeconds: config.sources.staleSeconds,
    });
    this.storage = new Storage({
      dir: config.storage.dir,
      keepAlerts: config.alerts.keep,
    });
    this.rules = buildRules(config);
    this.announcementRules = buildAnnouncementRules(config);
    this.cninfo = new CninfoSource(this.client);

    this.latestQuotes = new Map();
    this.alerts = [];
    this.announcements = [];
    this.lastRunAt = null;
    this.lastError = '';
    this.running = false;
    this.lastAnnouncementAt = 0;
    this.timer = null;
  }

  /** 告警去重：同一条告警在窗口期内只投递一次。 */
  alertKey(alert) {
    const payload = alert.payload || {};
    switch (alert.rule) {
      case 'announcement_keyword':
        return `announcement:${alert.code}:${payload.announcementId || payload.title}`;
      case 'price_change':
        return `price_change:${alert.code}:${Math.round(Number(payload.changePct || 0) * 10) / 10}`;
      case 'limit':
        return `limit:${alert.code}:${payload.state}`;
      case 'turnover':
        return `turnover:${alert.code}:${Math.round(Number(payload.turnover || 0))}`;
      case 'volume_surge':
        return `volume_surge:${alert.code}:${Math.floor(Date.now() / 1000 / 300)}`;
      case 'divergence':
        return `divergence:${alert.code}:${Math.round(Number(payload.divergence || 0) * 1000) / 1000}`;
      default:
        return `${alert.rule}:${alert.code}`;
    }
  }

  accept(alert) {
    const key = this.alertKey(alert);
    if (this.storage.seenAlert(key)) return false;
    this.storage.markAlert(key);
    return true;
  }

  /** 多源价格分歧超阈值时提示，避免在错数据上做决策。 */
  divergenceAlerts(item) {
    const tolerance = this.config.sources.divergenceTolerance;
    if (item.divergence <= tolerance) return [];
    const detail = Object.entries(item.quotes)
      .filter(([, quote]) => quote.price)
      .map(([name, quote]) => `${name}=${quote.price}`)
      .join('、');
    return [
      {
        rule: 'divergence',
        code: item.code,
        name: item.name,
        message: `${item.name}(${item.code}) 多源价格分歧 ${(item.divergence * 100).toFixed(2)}%（超过阈值 ${(tolerance * 100).toFixed(2)}%）：${detail}`,
        level: 'warning',
        quoteTime: item.quote ? item.quote.quoteTime : null,
        payload: { divergence: item.divergence },
        createdAt: new Date().toISOString(),
      },
    ];
  }

  /** 执行一轮：拉数 -> 规则 -> 去重 -> 记录。 */
  async runOnce() {
    if (!this.codes.length) return [];
    const startedAt = Date.now();
    const aggregated = await this.aggregator.fetch(this.codes);
    const context = { storage: this.storage, now: new Date() };
    const fresh = [];

    for (const [code, item] of aggregated.entries()) {
      if (!item.quote) {
        this.lastError = item.errors && Object.keys(item.errors).length ? Object.values(item.errors)[0] : '行情获取失败';
        continue;
      }

      const quote = item.quote;
      this.latestQuotes.set(code, {
        code,
        name: item.name,
        quote,
        divergence: item.divergence,
        stale: item.stale,
        staleSources: item.staleSources || [],
        sources: item.sources,
        errors: item.errors,
        fetchedAt: new Date().toISOString(),
      });

      for (const alert of this.divergenceAlerts(item)) {
        if (this.accept(alert)) fresh.push(alert);
      }

      for (const rule of this.rules) {
        for (const alert of rule.evaluate(quote, context)) {
          if (this.accept(alert)) fresh.push(alert);
        }
      }

      // 必须在规则评估之后再落盘，否则放量规则读到的就是本次数据
      this.storage.saveQuote(quote);
    }

    fresh.push(...(await this.checkAnnouncements()));
    if (fresh.length) {
      this.alerts = [...fresh.reverse(), ...this.alerts].slice(0, this.config.alerts.keep);
    }
    this.lastRunAt = new Date().toISOString();
    this.storage.flush();

    const ok = Array.from(this.latestQuotes.values()).length;
    const failed = this.aggregator
      .getSourceStatus()
      .filter((source) => !source.ok)
      .map((source) => `${source.name}: ${source.error}`);
    console.log(
      `轮询完成 ${Date.now() - startedAt}ms: ${ok}/${this.codes.length} 个标的, ${fresh.length} 条新告警` +
        (failed.length ? ` | 失败源 ${failed.join(' ; ')}` : ''),
    );
    return fresh;
  }

  async checkAnnouncements() {
    if (!this.announcementRules.length) return [];
    const now = Date.now();
    const interval = this.config.poll.announcementIntervalSeconds * 1000;
    if (this.lastAnnouncementAt && now - this.lastAnnouncementAt < interval) return [];
    this.lastAnnouncementAt = now;

    let announcements = [];
    try {
      announcements = await this.cninfo.fetchRecent(this.config.rules.announcement.pageSize);
    } catch {
      return [];
    }

    const fresh = [];
    for (const announcement of announcements) {
      if (announcement.announcementId && this.storage.seenAnnouncement(announcement.announcementId)) {
        continue;
      }
      for (const rule of this.announcementRules) {
        for (const alert of rule.evaluate(announcement)) {
          if (this.accept(alert)) fresh.push(alert);
        }
      }
      if (announcement.announcementId) {
        this.storage.markAnnouncement(
          announcement.announcementId,
          announcement.code,
          announcement.title,
          announcement.publishTime,
        );
      }
    }
    this.announcements = announcements.slice(0, 50);
    return fresh;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try {
        await this.runOnce();
      } catch (error) {
        this.lastError = error && error.message ? error.message : String(error);
      }
      if (this.running) {
        this.timer = setTimeout(tick, Math.max(5, this.config.poll.intervalSeconds) * 1000);
      }
    };
    tick();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.storage.flush();
  }

  snapshot() {
    return {
      quotes: Array.from(this.latestQuotes.values()),
      alerts: this.alerts.slice(0, 100),
      announcements: this.announcements.slice(0, 30),
      sources: this.aggregator.getSourceStatus(),
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      running: this.running,
    };
  }
}

export default Watcher;
