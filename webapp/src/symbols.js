// 证券代码规范化：把 600519 / sh600519 / 600519.sh 统一成 600519.SH。
// 与 Python 版 for_a/models.py 保持同一套前缀规则。

const MARKET_BY_PREFIX = new Map([
  ['688', 'SH'], ['689', 'SH'],
  ['300', 'SZ'], ['301', 'SZ'],
  ['430', 'BJ'], ['830', 'BJ'], ['870', 'BJ'], ['871', 'BJ'],
  ['872', 'BJ'], ['873', 'BJ'], ['920', 'BJ'], ['889', 'BJ'],
  ['600', 'SH'], ['601', 'SH'], ['603', 'SH'], ['605', 'SH'],
  ['000', 'SZ'], ['001', 'SZ'], ['002', 'SZ'], ['003', 'SZ'],
  ['580', 'SH'], ['510', 'SH'], ['511', 'SH'], ['512', 'SH'],
  ['513', 'SH'], ['515', 'SH'], ['588', 'SH'],
  ['159', 'SZ'],
]);

const LIMIT_PCT_BY_PREFIX = [
  ['300', 20], ['301', 20], ['688', 20], ['689', 20],
  ['43', 30], ['83', 30], ['87', 30], ['88', 30], ['92', 30],
];

export class SymbolError extends Error {}

export function resolveMarket(digits) {
  const market = MARKET_BY_PREFIX.get(digits.slice(0, 3));
  if (!market) throw new SymbolError(`无法推断交易所: ${digits}`);
  return market;
}

export function normalizeCode(raw) {
  let s = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!s) throw new SymbolError('证券代码为空');

  if (s.includes('.')) {
    const [digits, suffixRaw] = s.split('.');
    const suffix = String(suffixRaw || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(suffix) || !['SH', 'SZ', 'BJ'].includes(suffix)) {
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

  if (/^\d+$/.test(s)) {
    s = s.padStart(6, '0');
    return `${s}.${resolveMarket(s)}`;
  }
  throw new SymbolError(`无法识别的证券代码: ${raw}`);
}

export function splitCode(code) {
  const normalized = normalizeCode(code);
  const [digits, market] = normalized.split('.');
  return { digits, market };
}

const EASTMONEY_MARKET_PREFIX = { SH: '1', SZ: '0', BJ: '0' };

export function eastmoneySecid(code) {
  const { digits, market } = splitCode(code);
  return `${EASTMONEY_MARKET_PREFIX[market] ?? '1'}.${digits}`;
}

export function tencentSymbol(code) {
  const { digits, market } = splitCode(code);
  return `${market.toLowerCase()}${digits}`;
}

export const sinaSymbol = tencentSymbol;

export function guessLimitPct(code) {
  const { digits } = splitCode(code);
  for (const [prefix, pct] of LIMIT_PCT_BY_PREFIX) {
    if (digits.startsWith(prefix)) return pct;
  }
  return 10;
}

/** 东财搜索结果的 QuoteID（如 1.600519）转成标准代码。 */
export function codeFromQuoteId(quoteId, fallbackDigits) {
  const digits = String(fallbackDigits || '').padStart(6, '0');
  try {
    return `${digits}.${resolveMarket(digits)}`;
  } catch {
    const marketNum = String(quoteId || '').split('.')[0];
    return `${digits}.${marketNum === '1' ? 'SH' : 'SZ'}`;
  }
}
