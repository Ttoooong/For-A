/**
 * 多源交叉校验。
 *
 * 免费公开接口没有 SLA，唯一可行的准确性验证就是同时打两三个源比对。
 * 聚合器负责：选主源、算分歧度、识别某个源是否卡住。
 */

import { fetchEastmoneyQuotes } from './sources/eastmoney.js';
import { fetchSinaQuotes } from './sources/sina.js';
import { fetchTencentQuotes } from './sources/tencent.js';

const FETCHERS = {
  tencent: fetchTencentQuotes,
  sina: fetchSinaQuotes,
  eastmoney: fetchEastmoneyQuotes,
};

/**
 * 补齐主源缺失的字段。
 *
 * 各源字段覆盖不同：东财不提供振幅，腾讯不提供市盈率等。
 * 主源缺失的指标用校验源补齐，缺失的振幅则由高低价现算。
 */
const FILLABLE_FIELDS = [
  'open',
  'high',
  'low',
  'volume',
  'amount',
  'turnover',
  'amplitude',
  'pe',
  'pb',
  'totalMv',
  'floatMv',
];

function mergeQuote(primary, quotes) {
  const merged = { ...primary };
  const others = Object.values(quotes);

  for (const field of FILLABLE_FIELDS) {
    if (merged[field]) continue;
    for (const quote of others) {
      if (quote[field]) {
        merged[field] = quote[field];
        break;
      }
    }
  }

  if (!merged.limitUp) {
    for (const quote of others) {
      if (quote.limitUp) {
        merged.limitUp = quote.limitUp;
        break;
      }
    }
  }
  if (!merged.limitDown) {
    for (const quote of others) {
      if (quote.limitDown) {
        merged.limitDown = quote.limitDown;
        break;
      }
    }
  }

  if (!merged.amplitude && merged.high && merged.low && merged.prevClose) {
    merged.amplitude = ((merged.high - merged.low) / merged.prevClose) * 100;
  }

  return merged;
}

export class Aggregator {
  constructor({
    client,
    primary = 'eastmoney',
    verify = ['tencent', 'sina'],
    divergenceTolerance = 0.005,
    staleSeconds = 120,
  }) {
    this.client = client;
    this.primary = primary;
    this.verify = verify.filter((name) => name !== primary);
    this.divergenceTolerance = divergenceTolerance;
    this.staleSeconds = staleSeconds;
    this.sourceStatus = new Map();
  }

  /** 拉取全部源并聚合。 */
  async fetch(codes) {
    const perSource = new Map();
    const errors = {};
    const names = [this.primary, ...this.verify];

    for (const name of names) {
      const fetcher = FETCHERS[name];
      if (!fetcher) {
        errors[name] = `未知数据源: ${name}`;
        perSource.set(name, {});
        continue;
      }
      const startedAt = Date.now();
      try {
        const mapping = await fetcher(this.client, codes);
        perSource.set(name, mapping);
        this.sourceStatus.set(name, {
          name,
          ok: true,
          latencyMs: Date.now() - startedAt,
          count: Object.keys(mapping).length,
          error: '',
          checkedAt: new Date().toISOString(),
        });
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        errors[name] = message;
        perSource.set(name, {});
        this.sourceStatus.set(name, {
          name,
          ok: false,
          latencyMs: Date.now() - startedAt,
          count: 0,
          error: message,
          checkedAt: new Date().toISOString(),
        });
      }
    }

    const result = new Map();
    for (const code of codes) {
      const quotes = {};
      for (const [name, mapping] of perSource.entries()) {
        if (mapping[code]) quotes[name] = mapping[code];
      }
      result.set(code, this.aggregate(code, quotes, errors));
    }
    return result;
  }

  aggregate(code, quotes, errors) {
    const names = Object.keys(quotes);
    if (!names.length) {
      return {
        code,
        name: '',
        quote: null,
        quotes: {},
        divergence: 0,
        stale: true,
        staleSources: [],
        errors: { ...errors },
      };
    }

    const chosen = quotes[this.primary] || quotes[names[0]];
    const merged = mergeQuote(chosen, quotes);

    const prices = names.map((name) => quotes[name].price).filter((price) => price > 0);
    let divergence = 0;
    if (prices.length >= 2) {
      const hi = Math.max(...prices);
      const lo = Math.min(...prices);
      divergence = hi ? (hi - lo) / hi : 0;
    }

    // 某个源的时间戳明显落后于其它源，说明该源卡住了
    let stale = false;
    const staleSources = [];
    const times = names
      .map((name) => quotes[name].quoteTime)
      .filter(Boolean)
      .map((value) => new Date(value).getTime());
    if (times.length) {
      const newest = Math.max(...times);
      for (const name of names) {
        const value = quotes[name].quoteTime;
        if (value && (newest - new Date(value).getTime()) / 1000 > this.staleSeconds) {
          stale = true;
          staleSources.push(name);
        }
      }
    }

    return {
      code,
      name: chosen.name,
      quote: merged,
      quotes,
      divergence,
      stale,
      staleSources,
      errors: { ...errors },
      sources: names,
    };
  }

  getSourceStatus() {
    return Array.from(this.sourceStatus.values());
  }
}

export default Aggregator;
