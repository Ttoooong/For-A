// 免费公开数据源适配器：东财(主源) / 腾讯 / 新浪(校验源) / 巨潮(公告)。
// 与 Python 版 for_a/sources/* 同源同字段口径。

import { eastmoneySecid, tencentSymbol, sinaSymbol } from './symbols.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const EASTMONEY_HOSTS = [
  'https://push2.eastmoney.com',
  'https://push2delay.eastmoney.com',
  'https://82.push2.eastmoney.com',
];
const EASTMONEY_FIELDS = [
  'f43', 'f44', 'f45', 'f46', 'f47', 'f48', 'f50', 'f51', 'f52',
  'f57', 'f58', 'f60', 'f86', 'f116', 'f117', 'f162', 'f167', 'f168', 'f169', 'f170',
].join(',');

const CNINFO_SEARCH = 'https://www.cninfo.com.cn/new/information/topSearch/query';
const CNINFO_QUERY = 'https://www.cninfo.com.cn/new/hisAnnouncement/query';
const CNINFO_DETAIL = 'https://www.cninfo.com.cn/new/disclosure/detail';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function decodeGbk(buffer) {
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

async function fetchText(url, { headers = {}, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, ...headers },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}) {
  const buf = await fetchText(url, options);
  const text = buf.toString('utf-8').trim();
  try {
    return JSON.parse(text);
  } catch {
    // 东财部分接口会按调用方返回 JSONP，剥掉回调包装再解析
    const wrapped = text.match(/^[\w$.]+\s*\(([\s\S]*)\)\s*;?$/);
    if (wrapped) return JSON.parse(wrapped[1]);
    throw new Error('响应不是合法 JSON');
  }
}

async function postForm(url, data, { timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Referer: 'https://www.cninfo.com.cn/',
        Accept: 'application/json, text/plain, */*',
      },
      body: new URLSearchParams(data).toString(),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = Buffer.from(await resp.arrayBuffer()).toString('utf-8');
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- 东方财富（主源） ----------------

function parseEastmoney(payload, fallbackCode) {
  const data = payload && payload.data;
  if (!data || typeof data !== 'object') return null;
  const scaled = (key) => num(data[key]) / 100;
  const digits = String(data.f57 || fallbackCode.split('.')[0]);
  const market = fallbackCode.split('.').pop();
  const ts = num(data.f86);

  const prevClose = scaled('f60');
  const high = scaled('f44');
  const low = scaled('f45');

  return {
    code: `${digits}.${market}`,
    name: String(data.f58 || ''),
    price: scaled('f43'),
    prevClose,
    open: scaled('f46'),
    high,
    low,
    volume: num(data.f47) * 100,
    amount: num(data.f48),
    change: scaled('f169'),
    changePct: scaled('f170'),
    turnover: scaled('f168'),
    amplitude: prevClose > 0 ? ((high - low) / prevClose) * 100 : 0,
    pe: scaled('f162'),
    pb: scaled('f167'),
    totalMv: num(data.f116),
    floatMv: num(data.f117),
    limitUp: scaled('f51') || null,
    limitDown: scaled('f52') || null,
    bids: [],
    asks: [],
    quoteTime: ts ? new Date(ts * 1000).toISOString() : null,
    source: 'eastmoney',
  };
}

export async function fetchEastmoney(codes) {
  const out = new Map();
  for (const code of codes) {
    const secid = eastmoneySecid(code);
    let payload = null;
    let lastError = null;
    for (const host of EASTMONEY_HOSTS) {
      try {
        payload = await fetchJson(
          `${host}/api/qt/stock/get?secid=${encodeURIComponent(secid)}&fields=${EASTMONEY_FIELDS}`,
          { headers: { Referer: 'https://quote.eastmoney.com/' }, timeoutMs: 8000 },
        );
        if (payload && payload.data) break;
        lastError = new Error(`${host} 返回空 data`);
      } catch (err) {
        lastError = err;
      }
    }
    if (!payload || !payload.data) throw lastError || new Error('东财无数据');
    const quote = parseEastmoney(payload, code);
    if (quote) out.set(quote.code, quote);
  }
  return out;
}

// ---------------- 腾讯（校验源） ----------------

const TEN_INDEX = {
  name: 1, code: 2, price: 3, prevClose: 4, open: 5, volumeHand: 6,
  bid1: 9, ask1: 19, time: 30, change: 31, changePct: 32, high: 33, low: 34,
  amountWan: 37, turnover: 38, pe: 39, amplitude: 43, floatMv: 44, totalMv: 45,
  pb: 46, limitUp: 47, limitDown: 48,
};

function parseTencent(symbol, body) {
  const f = body.split('~');
  if (f.length < 49 || !f[TEN_INDEX.code]) return null;
  const at = (i) => (i < f.length ? num(f[i]) : 0);
  const opt = (i) => {
    const v = at(i);
    return v || null;
  };

  let quoteTime = null;
  const t = f[TEN_INDEX.time] || '';
  if (t.length >= 14) {
    const iso = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}+08:00`;
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) quoteTime = d.toISOString();
  }

  const bids = [];
  const asks = [];
  for (let i = 0; i < 5; i += 1) {
    const bidPrice = at(TEN_INDEX.bid1 + i * 2);
    const bidVol = at(TEN_INDEX.bid1 + i * 2 + 1);
    const askPrice = at(TEN_INDEX.ask1 + i * 2);
    const askVol = at(TEN_INDEX.ask1 + i * 2 + 1);
    if (bidPrice) bids.push([bidPrice, bidVol * 100]);
    if (askPrice) asks.push([askPrice, askVol * 100]);
  }

  const market = symbol.slice(0, 2).toUpperCase();
  return {
    code: `${f[TEN_INDEX.code]}.${market}`,
    name: f[TEN_INDEX.name],
    price: at(TEN_INDEX.price),
    prevClose: at(TEN_INDEX.prevClose),
    open: at(TEN_INDEX.open),
    high: at(TEN_INDEX.high),
    low: at(TEN_INDEX.low),
    volume: at(TEN_INDEX.volumeHand) * 100,
    amount: at(TEN_INDEX.amountWan) * 10000,
    change: at(TEN_INDEX.change),
    changePct: at(TEN_INDEX.changePct),
    turnover: at(TEN_INDEX.turnover),
    amplitude: at(TEN_INDEX.amplitude),
    pe: at(TEN_INDEX.pe),
    pb: at(TEN_INDEX.pb),
    totalMv: at(TEN_INDEX.totalMv) * 1e8,
    floatMv: at(TEN_INDEX.floatMv) * 1e8,
    limitUp: opt(TEN_INDEX.limitUp),
    limitDown: opt(TEN_INDEX.limitDown),
    bids,
    asks,
    quoteTime,
    source: 'tencent',
  };
}

export async function fetchTencent(codes) {
  const out = new Map();
  if (!codes.length) return out;
  const symbols = codes.map(tencentSymbol);
  const buf = await fetchText(`https://qt.gtimg.cn/q=${symbols.join(',')}`);
  const text = decodeGbk(buf);
  const re = /v_([a-z]{2}\d+)="([^"]*)"/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const quote = parseTencent(match[1], match[2]);
    if (quote) out.set(quote.code, quote);
  }
  return out;
}

// ---------------- 新浪（校验源） ----------------

function parseSina(symbol, body) {
  const f = body.split(',');
  if (f.length < 32 || !f[0]) return null;
  const at = (i) => (i < f.length ? num(f[i]) : 0);

  let quoteTime = null;
  if (f[30] && f[31]) {
    const d = new Date(`${f[30]}T${f[31]}+08:00`);
    if (!Number.isNaN(d.getTime())) quoteTime = d.toISOString();
  }

  const bids = [];
  const asks = [];
  for (let i = 0; i < 5; i += 1) {
    const bidVol = at(10 + i * 2);
    const bidPrice = at(11 + i * 2);
    const askVol = at(20 + i * 2);
    const askPrice = at(21 + i * 2);
    if (bidPrice) bids.push([bidPrice, bidVol]);
    if (askPrice) asks.push([askPrice, askVol]);
  }

  const price = at(3);
  const prevClose = at(2);
  const change = prevClose ? price - prevClose : 0;
  const changePct = prevClose ? (change / prevClose) * 100 : 0;
  const high = at(4);
  const low = at(5);
  const market = symbol.slice(0, 2).toUpperCase();

  return {
    code: `${symbol.slice(2)}.${market}`,
    name: f[0],
    price,
    prevClose,
    open: at(1),
    high,
    low,
    volume: at(8),
    amount: at(9),
    change: Number(change.toFixed(4)),
    changePct: Number(changePct.toFixed(4)),
    turnover: 0,
    amplitude: prevClose > 0 ? ((high - low) / prevClose) * 100 : 0,
    pe: 0,
    pb: 0,
    totalMv: 0,
    floatMv: 0,
    limitUp: null,
    limitDown: null,
    bids,
    asks,
    quoteTime,
    source: 'sina',
  };
}

export async function fetchSina(codes) {
  const out = new Map();
  if (!codes.length) return out;
  const symbols = codes.map(sinaSymbol);
  const buf = await fetchText(`https://hq.sinajs.cn/list=${symbols.join(',')}`, {
    headers: { Referer: 'https://finance.sina.com.cn' },
  });
  const text = decodeGbk(buf);
  const re = /var hq_str_([a-z0-9_]+)="([^"]*)"/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const quote = parseSina(match[1], match[2]);
    if (quote) out.set(quote.code, quote);
  }
  return out;
}

// ---------------- 巨潮资讯（公告） ----------------

export async function fetchAnnouncements(pageSize = 30) {
  const items = [];
  for (const column of ['sse', 'szse']) {
    const payload = await postForm(CNINFO_QUERY, {
      pageNum: '1',
      pageSize: String(pageSize),
      column,
      tabName: 'fulltext',
      stock: '',
      searchkey: '',
      secid: '',
      plate: '',
      category: '',
      trade: '',
      seDate: '',
      sortName: '',
      sortType: '',
      isHLtitle: 'true',
    });
    const rows = (payload && payload.announcements) || [];
    for (const row of rows) items.push({ row, column });
  }

  return items.map(({ row, column }) => {
    const ts = num(row.announcementTime);
    const market = column === 'sse' ? 'SH' : 'SZ';
    const secCode = String(row.secCode || '');
    const announcementId = String(row.announcementId || '');
    return {
      id: announcementId,
      code: `${secCode}.${market}`,
      name: String(row.secName || ''),
      title: String(row.announcementTitle || ''),
      publishTime: ts ? new Date(ts).toISOString() : new Date().toISOString(),
      url: `${CNINFO_DETAIL}?announcementId=${announcementId}&stockCode=${secCode}&orgId=${row.orgId || ''}`,
    };
  }).sort((a, b) => new Date(b.publishTime) - new Date(a.publishTime));
}

// 搜索走本地清单，见 stocklist.js



