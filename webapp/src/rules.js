// 规则引擎：涨跌幅、涨跌停、换手率、放量；公告关键词在 poller 中处理。
// 对应 Python 版 for_a/rules/。

import { guessLimitPct } from './symbols.js';

const isLimitUp = (q) => {
  if (q.limitUp) return q.price >= q.limitUp - 1e-6;
  const pct = guessLimitPct(q.code);
  return q.prevClose > 0 && q.changePct >= pct - 0.3;
};

const isLimitDown = (q) => {
  if (q.limitDown) return q.price <= q.limitDown + 1e-6;
  const pct = guessLimitPct(q.code);
  return q.prevClose > 0 && q.changePct <= -pct + 0.3;
};

const fmt = (v, d = 2) => Number(v || 0).toFixed(d);

function makeAlert(rule, quote, message, level, payload = {}) {
  return {
    rule,
    code: quote.code,
    name: quote.name,
    message,
    level,
    quoteTime: quote.quoteTime,
    createdAt: new Date().toISOString(),
    payload,
  };
}

export const THRESHOLDS = {
  priceChangePct: 5,
  turnoverPct: 10,
  volumeSurgeRatio: 3,
  volumeSurgeMinSeconds: 60,
  divergenceTolerance: 0.005,
};

export function evaluateQuoteRules(quote, lastQuote) {
  const alerts = [];

  // 涨跌幅
  if (Math.abs(quote.changePct) >= THRESHOLDS.priceChangePct) {
    const dir = quote.changePct > 0 ? '涨' : '跌';
    alerts.push(
      makeAlert(
        'price_change',
        quote,
        `${quote.name}(${quote.code}) ${dir} ${quote.changePct >= 0 ? '+' : ''}${fmt(quote.changePct)}%，现价 ${fmt(quote.price)} 元`,
        'warning',
        { change_pct: quote.changePct, price: quote.price },
      ),
    );
  }

  // 涨跌停
  if (isLimitUp(quote)) {
    alerts.push(
      makeAlert('limit', quote, `${quote.name}(${quote.code}) 触及涨停，现价 ${fmt(quote.price)} 元`, 'critical', {
        state: 'limit_up',
      }),
    );
  } else if (isLimitDown(quote)) {
    alerts.push(
      makeAlert('limit', quote, `${quote.name}(${quote.code}) 触及跌停，现价 ${fmt(quote.price)} 元`, 'critical', {
        state: 'limit_down',
      }),
    );
  }

  // 换手率
  if (quote.turnover >= THRESHOLDS.turnoverPct) {
    alerts.push(
      makeAlert(
        'turnover',
        quote,
        `${quote.name}(${quote.code}) 换手率 ${fmt(quote.turnover)}% 超过阈值 ${fmt(THRESHOLDS.turnoverPct)}%`,
        'info',
        { turnover: quote.turnover },
      ),
    );
  }

  // 放量：与上一次采样比较
  if (lastQuote && lastQuote.volume > 0) {
    const lastTime = lastQuote.quoteTime ? new Date(lastQuote.quoteTime).getTime() : null;
    const nowTime = quote.quoteTime ? new Date(quote.quoteTime).getTime() : null;
    const gapOk =
      !lastTime || !nowTime || (nowTime - lastTime) / 1000 >= THRESHOLDS.volumeSurgeMinSeconds;
    const delta = quote.volume - lastQuote.volume;
    if (gapOk && delta > 0) {
      const ratio = delta / lastQuote.volume;
      if (ratio >= THRESHOLDS.volumeSurgeRatio) {
        alerts.push(
          makeAlert(
            'volume_surge',
            quote,
            `${quote.name}(${quote.code}) 成交量较上次采样放大 ${ratio.toFixed(1)} 倍（增量 ${Math.round(delta / 100).toLocaleString('zh-CN')} 手）`,
            'warning',
            { ratio: Number(ratio.toFixed(2)), volume_delta: delta },
          ),
        );
      }
    }
  }

  return alerts;
}

export function divergenceAlert(item) {
  if (!item.divergence || item.divergence <= THRESHOLDS.divergenceTolerance) return null;
  return {
    rule: 'divergence',
    code: item.code,
    name: item.name,
    message: `${item.name}(${item.code}) 多源价格分歧 ${(item.divergence * 100).toFixed(2)}%（超过阈值 ${(THRESHOLDS.divergenceTolerance * 100).toFixed(2)}%）`,
    level: 'warning',
    quoteTime: item.quote ? item.quote.quoteTime : null,
    createdAt: new Date().toISOString(),
    payload: { divergence: item.divergence },
  };
}

const ANNOUNCEMENT_KEYWORDS = [
  '重组', '停牌', '复牌', '立案', '处罚', '问询函', '关注函',
  '业绩预增', '业绩预亏', '减持', '增持', '回购', '质押', '重大资产', '中标',
];

export function evaluateAnnouncement(announcement) {
  const title = announcement.title || '';
  const hit = ANNOUNCEMENT_KEYWORDS.find((kw) => title.includes(kw));
  if (!hit) return null;
  return {
    rule: 'announcement_keyword',
    code: announcement.code,
    name: announcement.name,
    message: `${announcement.name}(${announcement.code}) 公告命中「${hit}」：${title}`,
    level: 'info',
    quoteTime: announcement.publishTime,
    createdAt: new Date().toISOString(),
    payload: { announcement_id: announcement.id, title },
  };
}

/** 告警去重键：同一事件在窗口期内只投递一次。 */
export function alertKey(alert) {
  const p = alert.payload || {};
  switch (alert.rule) {
    case 'announcement_keyword':
      return `announcement:${alert.code}:${p.announcement_id || p.title}`;
    case 'price_change':
      return `price_change:${alert.code}:${Number(p.change_pct || 0).toFixed(1)}`;
    case 'limit':
      return `limit:${alert.code}:${p.state}`;
    case 'turnover':
      return `turnover:${alert.code}:${Math.trunc(Number(p.turnover || 0))}`;
    case 'volume_surge':
      return `volume_surge:${alert.code}:${Math.floor(Date.now() / 1000 / 300)}`;
    case 'divergence':
      return `divergence:${alert.code}:${Number(p.divergence || 0).toFixed(3)}`;
    default:
      return `${alert.rule}:${alert.code}`;
  }
}
