// 多源交叉校验：选主源、算价格分歧、识别时间戳卡住的源。
// 对应 Python 版 for_a/aggregator.py。

import { fetchEastmoney, fetchTencent, fetchSina } from './sources.js';

const STALE_SECONDS = 120;
const SOURCE_ORDER = ['eastmoney', 'tencent', 'sina'];
const FETCHERS = {
  eastmoney: fetchEastmoney,
  tencent: fetchTencent,
  sina: fetchSina,
};

export async function fetchAggregated(codes) {
  const perSource = {};
  const sourceStatus = [];

  await Promise.all(
    SOURCE_ORDER.map(async (name) => {
      const t0 = Date.now();
      try {
        const map = await FETCHERS[name](codes);
        perSource[name] = map;
        sourceStatus.push({
          name,
          ok: true,
          latencyMs: Date.now() - t0,
          count: map.size,
          error: '',
          checkedAt: new Date().toISOString(),
        });
      } catch (err) {
        perSource[name] = new Map();
        sourceStatus.push({
          name,
          ok: false,
          latencyMs: Date.now() - t0,
          count: 0,
          error: String((err && err.message) || err),
          checkedAt: new Date().toISOString(),
        });
      }
    }),
  );

  sourceStatus.sort((a, b) => SOURCE_ORDER.indexOf(a.name) - SOURCE_ORDER.indexOf(b.name));

  const fetchedAt = new Date().toISOString();
  const quotes = codes.map((code) => aggregateOne(code, perSource, fetchedAt));

  const now = Date.now();
  const freshSources = sourceStatus.map((s) => ({
    name: s.name,
    ok: s.ok,
    latencyMs: s.latencyMs,
    count: s.count,
    error: s.error,
    checkedAt: s.checkedAt,
    ageSeconds: Math.round((now - new Date(s.checkedAt).getTime()) / 1000),
  }));

  return { quotes, sources: freshSources, fetchedAt };
}

function aggregateOne(code, perSource, fetchedAt) {
  const present = new Map();
  const errors = {};
  for (const name of SOURCE_ORDER) {
    const map = perSource[name];
    if (!map) continue;
    const quote = map.get(code);
    if (quote) present.set(name, quote);
  }

  if (present.size === 0) {
    return {
      code,
      name: '',
      quote: null,
      divergence: 0,
      stale: false,
      staleSources: [],
      sources: [],
      errors,
      fetchedAt,
    };
  }

  const primary = present.get('eastmoney') || present.values().next().value;

  const prices = [...present.values()].map((q) => q.price).filter((p) => p > 0);
  let divergence = 0;
  if (prices.length >= 2) {
    const hi = Math.max(...prices);
    const lo = Math.min(...prices);
    divergence = hi ? (hi - lo) / hi : 0;
  }

  const timed = [...present.values()].filter((q) => q.quoteTime);
  const staleSources = [];
  if (timed.length) {
    const newest = Math.max(...timed.map((q) => new Date(q.quoteTime).getTime()));
    for (const quote of timed) {
      if ((newest - new Date(quote.quoteTime).getTime()) / 1000 > STALE_SECONDS) {
        staleSources.push(quote.source);
      }
    }
  }

  return {
    code,
    name: primary.name,
    quote: primary,
    divergence,
    stale: staleSources.length > 0,
    staleSources,
    sources: [...present.keys()],
    errors,
    fetchedAt,
  };
}
