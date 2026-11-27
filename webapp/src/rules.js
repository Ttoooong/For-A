/**
 * 规则引擎：价格类（涨跌幅、涨跌停、换手率、放量）与公告类（关键词命中）。
 */

import { guessLimitPct, isLimitDown, isLimitUp } from './symbols.js';

function makeAlert(rule, quote, message, level, payload = {}) {
  return {
    rule,
    code: quote.code,
    name: quote.name,
    message,
    level,
    quoteTime: quote.quoteTime || null,
    payload,
    createdAt: new Date().toISOString(),
  };
}

/** 涨跌幅超过阈值。 */
export function priceChangeRule(thresholdPct = 5, level = 'warning') {
  return {
    name: 'price_change',
    evaluate(quote) {
      if (Math.abs(quote.changePct) < thresholdPct) return [];
      const direction = quote.changePct > 0 ? '涨' : '跌';
      return [
        makeAlert(
          'price_change',
          quote,
          `${quote.name}(${quote.code}) ${direction} ${quote.changePct >= 0 ? '+' : ''}${quote.changePct.toFixed(2)}%，现价 ${quote.price.toFixed(2)} 元`,
          level,
          { changePct: quote.changePct, price: quote.price },
        ),
      ];
    },
  };
}

/** 触及涨停或跌停。源端提供涨跌停价时直接比较，否则按板块幅度推算。 */
export function limitRule(level = 'critical') {
  return {
    name: 'limit',
    evaluate(quote) {
      let state = '';
      if (isLimitUp(quote)) state = 'limit_up';
      else if (isLimitDown(quote)) state = 'limit_down';
      else return [];

      const label = state === 'limit_up' ? '涨停' : '跌停';
      return [
        makeAlert(
          'limit',
          quote,
          `${quote.name}(${quote.code}) 触及${label}，现价 ${quote.price.toFixed(2)} 元（板块限制 ${guessLimitPct(quote.code)}%）`,
          level,
          { state },
        ),
      ];
    },
  };
}

/** 换手率超过阈值（资金活跃度信号）。 */
export function turnoverRule(thresholdPct = 10, level = 'info') {
  return {
    name: 'turnover',
    evaluate(quote) {
      if (quote.turnover < thresholdPct) return [];
      return [
        makeAlert(
          'turnover',
          quote,
          `${quote.name}(${quote.code}) 换手率 ${quote.turnover.toFixed(2)}% 超过阈值 ${thresholdPct.toFixed(2)}%`,
          level,
          { turnover: quote.turnover },
        ),
      ];
    },
  };
}

/**
 * 成交量相对上一次采样放大。
 * 以两次采样之间的成交量增量做比较，只依赖行情源自身数据。
 */
export function volumeSurgeRule({ ratio = 3, minSeconds = 60, level = 'warning' } = {}) {
  return {
    name: 'volume_surge',
    evaluate(quote, context) {
      const row = context.storage.lastQuote(quote.code);
      if (!row) return [];
      const lastVolume = Number(row.volume || 0);
      if (!lastVolume) return [];

      if (row.quoteTime && quote.quoteTime) {
        const gap = (new Date(quote.quoteTime) - new Date(row.quoteTime)) / 1000;
        if (gap < minSeconds) return [];
      }

      const delta = quote.volume - lastVolume;
      if (delta <= 0) return [];
      const actualRatio = delta / lastVolume;
      if (actualRatio < ratio) return [];

      return [
        makeAlert(
          'volume_surge',
          quote,
          `${quote.name}(${quote.code}) 成交量较上次采样放大 ${actualRatio.toFixed(1)} 倍（增量 ${Math.round(delta / 100).toLocaleString('en-US')} 手）`,
          level,
          { ratio: Math.round(actualRatio * 100) / 100, volumeDelta: delta },
        ),
      ];
    },
  };
}

/** 公告标题命中关键词时告警。 */
export function announcementKeywordRule(keywords = [], level = 'info') {
  return {
    name: 'announcement_keyword',
    evaluate(announcement) {
      const hits = keywords.filter((keyword) => keyword && announcement.title.includes(keyword));
      if (!hits.length) return [];
      return [
        {
          rule: 'announcement_keyword',
          code: announcement.code,
          name: announcement.name,
          message: `${announcement.name}(${announcement.code}) 发布公告《${announcement.title}》，命中关键词：${hits.join('、')}`,
          level,
          quoteTime: null,
          payload: {
            title: announcement.title,
            announcementId: announcement.announcementId,
            keywords: hits,
            url: announcement.url,
            pdfUrl: announcement.pdfUrl,
            publishTime: announcement.publishTime,
          },
          createdAt: new Date().toISOString(),
        },
      ];
    },
  };
}

export function buildRules(config) {
  const rules = [];
  if (config.rules.priceChange.enabled) {
    rules.push(priceChangeRule(config.rules.priceChange.thresholdPct));
  }
  if (config.rules.limit.enabled) rules.push(limitRule());
  if (config.rules.turnover.enabled) {
    rules.push(turnoverRule(config.rules.turnover.thresholdPct));
  }
  if (config.rules.volumeSurge.enabled) {
    rules.push(volumeSurgeRule(config.rules.volumeSurge));
  }
  return rules;
}

export function buildAnnouncementRules(config) {
  if (!config.rules.announcement.enabled) return [];
  return [announcementKeywordRule(config.rules.announcement.keywords)];
}
