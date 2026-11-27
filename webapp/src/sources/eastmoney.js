/**
 * 东方财富行情适配器（push2）。
 *
 * 零成本、秒级，返回 JSON，最适合脚本化处理。代价是**代号制字段**：
 * 价格类字段都要 ÷100，时间戳在 ``f86``（Unix 秒）。
 */

import { eastmoneySecid, makeQuote } from '../symbols.js';

const ENDPOINT = '/api/qt/stock/get';
const REFERER = 'https://quote.eastmoney.com/';

// 东财有多个同构镜像。单主机在高频访问下会偶发空响应，
// 逐个降级重试可以显著降低整条链路的失败率。
const HOSTS = [
  'https://push2.eastmoney.com',
  'https://push2delay.eastmoney.com',
  'https://82.push2.eastmoney.com',
  'https://48.push2.eastmoney.com',
];

const FIELDS = [
  'f43', // 最新价 ×100
  'f44', // 最高 ×100
  'f45', // 最低 ×100
  'f46', // 今开 ×100
  'f47', // 成交量（手）
  'f48', // 成交额（元）
  'f50', // 量比 ×100
  'f51', // 涨停价 ×100
  'f52', // 跌停价 ×100
  'f57', // 代码
  'f58', // 名称
  'f60', // 昨收 ×100
  'f86', // 行情时间戳（Unix 秒）
  'f116', // 总市值（元）
  'f117', // 流通市值（元）
  'f162', // 市盈率(动) ×100
  'f167', // 市净率 ×100
  'f168', // 换手率 ×100
  'f169', // 涨跌额 ×100
  'f170', // 涨跌幅 ×100
].join(',');

/** 把 push2 的 JSON 响应转成统一行情结构。 */
export function parseEastmoneyPayload(payload, fallbackCode) {
  const data = payload && payload.data;
  if (!data || typeof data !== 'object') return null;

  const scaled = (key) => {
    const value = Number(data[key]);
    return Number.isFinite(value) ? value / 100 : 0;
  };
  const asFloat = (key) => {
    const value = Number(data[key]);
    return Number.isFinite(value) ? value : 0;
  };

  const [fallbackDigits, fallbackMarket] = String(fallbackCode).split('.');
  const digits = String(data.f57 || fallbackDigits || '');
  const market = String(fallbackMarket || 'SH').toUpperCase();

  let quoteTime = null;
  const timestamp = Number(data.f86);
  if (data.f86 && Number.isFinite(timestamp)) {
    quoteTime = new Date(timestamp * 1000).toISOString();
  }

  return makeQuote({
    code: `${digits}.${market}`,
    name: String(data.f58 || ''),
    price: scaled('f43'),
    prevClose: scaled('f60'),
    open: scaled('f46'),
    high: scaled('f44'),
    low: scaled('f45'),
    volume: asFloat('f47') * 100,
    amount: asFloat('f48'),
    turnover: scaled('f168'),
    pe: scaled('f162'),
    pb: scaled('f167'),
    totalMv: asFloat('f116'),
    floatMv: asFloat('f117'),
    limitUp: scaled('f51') || null,
    limitDown: scaled('f52') || null,
    change: scaled('f169'),
    changePct: scaled('f170'),
    quoteTime,
    source: 'eastmoney',
  });
}

async function getWithMirrorFallback(client, code) {
  const params = `secid=${eastmoneySecid(code)}&fields=${FIELDS}`;
  let lastError = null;

  for (const host of HOSTS) {
    try {
      const payload = await client.getJson(`${host}${ENDPOINT}?${params}`, {
        headers: { Referer: REFERER },
      });
      if (payload && payload.data) return payload;
      lastError = new Error(`${host} 返回空 data`);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`东财所有镜像均失败: ${lastError && lastError.message}`);
}

export async function fetchEastmoneyQuotes(client, codes) {
  const result = {};
  for (const code of codes) {
    const quote = parseEastmoneyPayload(await getWithMirrorFallback(client, code), code);
    if (quote) result[quote.code] = quote;
  }
  return result;
}
