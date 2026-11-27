/**
 * 腾讯行情适配器（qt.gtimg.cn）。
 *
 * 零成本、秒级、五档盘口，是免费源里字段最全的一个：除常规行情外还带涨跌停价、
 * 换手率、量比、振幅等。限制是港股/美股为延迟档，A 股才是实时。
 */

import { makeQuote, tencentSymbol } from '../symbols.js';
import { parseCompactBeijingTime } from '../time.js';

const ENDPOINT = 'https://qt.gtimg.cn/q=';
const PAYLOAD_RE = /v_([a-z]{2}\d+)="([^"]*)"/g;

// 腾讯 A 股字段下标（0 基），已按实测报文核对
const F_NAME = 1;
const F_CODE = 2;
const F_PRICE = 3;
const F_PREV_CLOSE = 4;
const F_OPEN = 5;
const F_VOLUME_HAND = 6;
const F_BID1 = 9;
const F_ASK1 = 19;
const F_TIME = 30;
const F_CHANGE = 31;
const F_CHANGE_PCT = 32;
const F_HIGH = 33;
const F_LOW = 34;
const F_AMOUNT_WAN = 37;
const F_TURNOVER = 38;
const F_PE = 39;
const F_AMPLITUDE = 43;
const F_FLOAT_MV = 44;
const F_TOTAL_MV = 45;
const F_PB = 46;
const F_LIMIT_UP = 47;
const F_LIMIT_DOWN = 48;

function toFloat(raw) {
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

/** 解析腾讯的时间戳：``20261127153124`` -> ISO 字符串（北京时间转 UTC）。 */
function parseQuoteTime(raw) {
  return parseCompactBeijingTime(raw);
}

/** 解析单条腾讯报文，返回 null 表示该代码无有效数据。 */
export function parseTencentLine(symbol, body) {
  const fields = String(body).split('~');
  if (fields.length < 49 || !fields[F_CODE]) return null;

  const f = (index) => (index < fields.length ? toFloat(fields[index]) : 0);
  const opt = (index) => {
    if (index >= fields.length) return null;
    const value = toFloat(fields[index]);
    return value || null;
  };

  const market = symbol.slice(0, 2).toUpperCase();
  const code = `${fields[F_CODE]}.${market}`;

  const bids = [];
  const asks = [];
  for (let i = 0; i < 5; i += 1) {
    const bidPrice = f(F_BID1 + i * 2);
    const bidVolume = f(F_BID1 + i * 2 + 1);
    const askPrice = f(F_ASK1 + i * 2);
    const askVolume = f(F_ASK1 + i * 2 + 1);
    if (bidPrice) bids.push([bidPrice, bidVolume * 100]);
    if (askPrice) asks.push([askPrice, askVolume * 100]);
  }

  return makeQuote({
    code,
    name: fields[F_NAME],
    price: f(F_PRICE),
    prevClose: f(F_PREV_CLOSE),
    open: f(F_OPEN),
    high: f(F_HIGH),
    low: f(F_LOW),
    volume: f(F_VOLUME_HAND) * 100,
    amount: f(F_AMOUNT_WAN) * 10000,
    change: f(F_CHANGE),
    changePct: f(F_CHANGE_PCT),
    turnover: f(F_TURNOVER),
    amplitude: f(F_AMPLITUDE),
    pe: f(F_PE),
    pb: f(F_PB),
    totalMv: f(F_TOTAL_MV) * 100000000,
    floatMv: f(F_FLOAT_MV) * 100000000,
    limitUp: opt(F_LIMIT_UP),
    limitDown: opt(F_LIMIT_DOWN),
    bids,
    asks,
    quoteTime: parseQuoteTime(fields[F_TIME]),
    source: 'tencent',
  });
}

export async function fetchTencentQuotes(client, codes) {
  if (!codes.length) return {};
  const symbols = codes.map((code) => tencentSymbol(code));
  const text = await client.getText(`${ENDPOINT}${symbols.join(',')}`, { encoding: 'gbk' });

  const result = {};
  PAYLOAD_RE.lastIndex = 0;
  let match = PAYLOAD_RE.exec(text);
  while (match) {
    const quote = parseTencentLine(match[1], match[2]);
    if (quote) result[quote.code] = quote;
    match = PAYLOAD_RE.exec(text);
  }
  return result;
}
