/**
 * 证券代码规范化与交易所推断。
 * 与 Python 版 for_a.models 保持一致：所有数据源差异在此收敛。
 */

// 代码前缀 -> 交易所。必须按前缀长度倒序匹配，否则 "60" 会吃掉 "688"。
const MARKET_BY_PREFIX = [
  ['688', 'SH'],
  ['689', 'SH'],
  ['300', 'SZ'],
  ['301', 'SZ'],
  ['430', 'BJ'],
  ['830', 'BJ'],
  ['870', 'BJ'],
  ['871', 'BJ'],
  ['872', 'BJ'],
  ['873', 'BJ'],
  ['920', 'BJ'],
  ['600', 'SH'],
  ['601', 'SH'],
  ['603', 'SH'],
  ['605', 'SH'],
  ['000', 'SZ'],
  ['001', 'SZ'],
  ['002', 'SZ'],
  ['003', 'SZ'],
  ['580', 'SH'],
  ['510', 'SH'],
  ['511', 'SH'],
  ['512', 'SH'],
  ['513', 'SH'],
  ['515', 'SH'],
  ['588', 'SH'],
  ['159', 'SZ'],
  ['150', 'SZ'],
  ['151', 'SZ'],
  ['152', 'SZ'],
  ['161', 'SZ'],
  ['162', 'SZ'],
  ['163', 'SZ'],
  ['164', 'SZ'],
  ['165', 'SZ'],
  ['166', 'SZ'],
  ['167', 'SZ'],
  ['168', 'SZ'],
  ['169', 'SZ'],
];

const EASTMONEY_MARKET_PREFIX = { SH: '1', SZ: '0', BJ: '0' };

// 各板块涨跌停幅度（%），用于源端未提供涨跌停价时推算
const LIMIT_PCT_BY_PREFIX = [
  ['300', 20],
  ['301', 20],
  ['688', 20],
  ['689', 20],
  ['43', 30],
  ['83', 30],
  ['87', 30],
  ['88', 30],
  ['92', 30],
];

export class SymbolError extends Error {}

export function resolveMarket(digits) {
  for (const [prefix, market] of MARKET_BY_PREFIX) {
    if (digits.startsWith(prefix)) return market;
  }
  throw new SymbolError(`无法推断交易所: ${digits}`);
}

/**
 * 把各种写法统一成 ``600519.SH`` 形式。
 * 支持 ``600519`` / ``sh600519`` / ``600519.sh`` / ``SH600519``。
 */
export function normalizeCode(raw) {
  let s = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!s) throw new SymbolError('证券代码为空');

  if (s.includes('.')) {
    const [digits, suffixRaw] = s.split('.');
    const suffix = suffixRaw.toUpperCase();
    if (!['SH', 'SZ', 'BJ'].includes(suffix)) {
      throw new SymbolError(`无法识别的交易所后缀: ${raw}`);
    }
    if (!/^\d+$/.test(digits)) throw new SymbolError(`无法识别的证券代码: ${raw}`);
    return `${digits}.${suffix}`;
  }

  for (const market of ['sh', 'sz', 'bj']) {
    if (s.startsWith(market)) {
      const digits = s.slice(2);
      if (!/^\d+$/.test(digits)) throw new SymbolError(`无法识别的证券代码: ${raw}`);
      return `${digits}.${market.toUpperCase()}`;
    }
  }

  if (/^\d+$/.test(s)) return `${s}.${resolveMarket(s)}`;
  throw new SymbolError(`无法识别的证券代码: ${raw}`);
}

/** ``"600519.SH"`` -> ``["600519", "SH"]`` */
export function splitCode(code) {
  const normalized = normalizeCode(code);
  const index = normalized.indexOf('.');
  return [normalized.slice(0, index), normalized.slice(index + 1)];
}

/** 腾讯 / 新浪行情代码，例如 ``sh600519``。 */
export function tencentSymbol(code) {
  const [digits, market] = splitCode(code);
  return `${market.toLowerCase()}${digits}`;
}

/** 东方财富 secid，例如 ``1.600519``。 */
export function eastmoneySecid(code) {
  const [digits, market] = splitCode(code);
  return `${EASTMONEY_MARKET_PREFIX[market] || '1'}.${digits}`;
}

/** 按板块推断涨跌停幅度（%）。 */
export function guessLimitPct(code) {
  const [digits] = splitCode(code);
  for (const [prefix, pct] of LIMIT_PCT_BY_PREFIX) {
    if (digits.startsWith(prefix)) return pct;
  }
  return 10;
}

/**
 * 归一化后的实时行情快照。
 * 成交量统一为 **股**，成交额统一为 **元**，价格统一为 **元**。
 */
export function makeQuote(fields) {
  return {
    code: fields.code,
    name: fields.name || '',
    price: fields.price || 0,
    prevClose: fields.prevClose || 0,
    open: fields.open || 0,
    high: fields.high || 0,
    low: fields.low || 0,
    volume: fields.volume || 0,
    amount: fields.amount || 0,
    change: fields.change || 0,
    changePct: fields.changePct || 0,
    turnover: fields.turnover || 0,
    amplitude: fields.amplitude || 0,
    pe: fields.pe || 0,
    pb: fields.pb || 0,
    totalMv: fields.totalMv || 0,
    floatMv: fields.floatMv || 0,
    limitUp: fields.limitUp ?? null,
    limitDown: fields.limitDown ?? null,
    bids: fields.bids || [],
    asks: fields.asks || [],
    quoteTime: fields.quoteTime || null,
    source: fields.source || '',
  };
}

export function isLimitUp(quote) {
  if (quote.limitUp) return quote.price >= quote.limitUp - 1e-6;
  const pct = guessLimitPct(quote.code);
  return quote.prevClose > 0 && quote.changePct >= pct - 0.3;
}

export function isLimitDown(quote) {
  if (quote.limitDown) return quote.price <= quote.limitDown + 1e-6;
  const pct = guessLimitPct(quote.code);
  return quote.prevClose > 0 && quote.changePct <= -pct + 0.3;
}
