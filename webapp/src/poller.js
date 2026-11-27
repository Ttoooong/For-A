// 常驻轮询：行情每 15 秒，公告每 5 分钟。
// 对应 Python 版 for_a/watch.py 的 run_forever。

import { fetchAggregated } from './aggregator.js';
import { fetchAnnouncements } from './sources.js';
import { evaluateQuoteRules, evaluateAnnouncement, divergenceAlert } from './rules.js';
import { store } from './store.js';

const QUOTE_INTERVAL_MS = 15000;
const ANNOUNCEMENT_INTERVAL_MS = 300000;

export const state = {
  lastRunAt: null,
  lastError: '',
  running: false,
  quotes: [],
  sources: [],
  announcements: [],
  startedAt: new Date().toISOString(),
};

let lastAnnouncementAt = 0;
let timer = null;
let inFlight = null;

export function tick() {
  if (inFlight) return inFlight;
  inFlight = runOnce().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runOnce() {
  state.running = true;
  const codes = [...store.watchlist];
  try {
    if (!codes.length) {
      state.quotes = [];
      state.sources = [];
      state.lastRunAt = new Date().toISOString();
      state.lastError = '';
      return;
    }

    const { quotes, sources, fetchedAt } = await fetchAggregated(codes);
    const fresh = [];

    for (const item of quotes) {
      if (!item.quote) continue;

      const div = divergenceAlert(item);
      if (div && store.accept(div)) fresh.push(div);

      const last = store.lastQuotes.get(item.code);
      for (const alert of evaluateQuoteRules(item.quote, last)) {
        if (store.accept(alert)) fresh.push(alert);
      }

      // 规则评估之后再更新基线，否则放量规则读到的是本次数据
      store.lastQuotes.set(item.code, {
        volume: item.quote.volume,
        quoteTime: item.quote.quoteTime,
      });
    }

    state.quotes = quotes;
    state.sources = sources;
    state.lastRunAt = fetchedAt;
    state.lastError = '';

    if (Date.now() - lastAnnouncementAt >= ANNOUNCEMENT_INTERVAL_MS) {
      lastAnnouncementAt = Date.now();
      try {
        const announcements = await fetchAnnouncements(30);
        state.announcements = announcements;
        for (const announcement of announcements) {
          const alert = evaluateAnnouncement(announcement);
          if (alert && store.accept(alert)) fresh.push(alert);
        }
      } catch (err) {
        // 公告失败不影响行情主链路
      }
    }

    if (fresh.length) store.pushAlerts(fresh);
    store.prune();
  } catch (err) {
    state.lastError = String((err && err.message) || err);
  } finally {
    state.running = false;
  }
}

export function startPoller() {
  tick();
  timer = setInterval(tick, QUOTE_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopPoller() {
  if (timer) clearInterval(timer);
  timer = null;
}
