/**
 * 新浪行情适配器（hq.sinajs.cn）。
 *
 * 零成本、秒级。**必须带 Referer**，否则直接 403。
 * 港股实时价需要 ``rt_`` 前缀（如 ``rt_hk00700``），写成 ``hk00700`` 会掉进延迟档。
 */

import { makeQuote, tencentSymbol } from '../symbols.js';
import { parseBeijingTime } from '../time.js';

const ENDPOINT = 'https://hq.sinajs.cn/list=';
const REFERER = 'https://finance.sina.com.cn';
const PAYLOAD_RE = /var hq_str_([a-z0-9_]+)="([^"]*)"/g;

// 新浪 A 股字段下标（0 基），已按实测报文核对
const F_NAME = 0;
const F_OPEN = 1;
const F_PREV_CLOSE = 2;
const F_PRICE = 3;
const F_HIGH = 4;
const F_LOW = 5;
const F_VOLUME_SHARE = 8;
const F_AMOUNT = 9;
const F_BID1_PRICE = 11;
const F_ASK1_PRICE = 21;
const F_DATE = 30;
const F_TIME = 31;

function toFloat(raw) {
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

/** 解析单条新浪报文。 */
export function parseSinaLine(symbol, body) {
  const fields = String(body).split(',');
  if (fields.length < 32 || !fields[F_NAME]) return null;

  const f = (index) => (index < fields.length ? toFloat(fields[index]) : 0);

  let quoteTime = null;
  const date = fields[F_DATE];
  const time = fields[F_TIME];
  if (date && time) {
    quoteTime = parseBeijingTime(date, time);
  }

  const bids = [];
  const asks = [];
  for (let i = 0; i < 5; i += 1) {
    const bidVolume = f(10 + i * 2);
    const bidPrice = f(11 + i * 2);
    const askVolume = f(20 + i * 2);
    const askPrice = f(21 + i * 2);
    if (bidPrice) bids.push([bidPrice, bidVolume]);
    if (askPrice) asks.push([askPrice, askVolume]);
  }

  const price = f(F_PRICE);
  const prevClose = f(F_PREV_CLOSE);
  const change = prevClose ? round4(price - prevClose) : 0;
  const changePct = prevClose ? round4((change / prevClose) * 100) : 0;

  const market = symbol.slice(0, 2).toUpperCase();
  const digits = symbol.slice(2);

  return makeQuote({
    code: `${digits}.${market}`,
    name: fields[F_NAME],
    price,
    prevClose,
    open: f(F_OPEN),
    high: f(F_HIGH),
    low: f(F_LOW),
    volume: f(F_VOLUME_SHARE),
    amount: f(F_AMOUNT),
    change,
    changePct,
    bids,
    asks,
    quoteTime,
    source: 'sina',
  });
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

export async function fetchSinaQuotes(client, codes) {
  if (!codes.length) return {};
  const symbols = codes.map((code) => tencentSymbol(code));
  const text = await client.getText(`${ENDPOINT}${symbols.join(',')}`, {
    encoding: 'gbk',
    headers: { Referer: REFERER },
  });

  const result = {};
  PAYLOAD_RE.lastIndex = 0;
  let match = PAYLOAD_RE.exec(text);
  while (match) {
    const quote = parseSinaLine(match[1], match[2]);
    if (quote) result[quote.code] = quote;
    match = PAYLOAD_RE.exec(text);
  }
  return result;
}
