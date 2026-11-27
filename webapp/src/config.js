/**
 * 运行期配置。全部来自环境变量，带保守默认值，
 * 使容器内无需任何配置文件即可启动。
 */

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(value, fallback) {
  if (value == null || value === '') return [...fallback];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  return raw.map((item) => String(item).trim()).filter(Boolean);
}

export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: num(process.env.PORT, 8000),

  watchlist: list(process.env.FORA_WATCHLIST, [
    '600519',
    '000001',
    '300750',
    '688981',
    '601318',
    '000858',
  ]),

  poll: {
    intervalSeconds: num(process.env.FORA_POLL_INTERVAL, 15),
    announcementIntervalSeconds: num(process.env.FORA_ANNOUNCEMENT_INTERVAL, 300),
  },

  http: {
    timeout: num(process.env.FORA_HTTP_TIMEOUT, 10),
    retries: num(process.env.FORA_HTTP_RETRIES, 3),
    backoff: num(process.env.FORA_HTTP_BACKOFF, 1.5),
    minInterval: num(process.env.FORA_MIN_INTERVAL, 0.5),
  },

  sources: {
    primary: process.env.FORA_PRIMARY_SOURCE || 'eastmoney',
    verify: list(process.env.FORA_VERIFY_SOURCES, ['tencent', 'sina']),
    divergenceTolerance: num(process.env.FORA_DIVERGENCE_TOLERANCE, 0.005),
    staleSeconds: num(process.env.FORA_STALE_SECONDS, 120),
  },

  rules: {
    priceChange: { enabled: true, thresholdPct: num(process.env.FORA_PRICE_CHANGE_PCT, 5) },
    limit: { enabled: true },
    turnover: { enabled: true, thresholdPct: num(process.env.FORA_TURNOVER_PCT, 10) },
    volumeSurge: { enabled: true, ratio: num(process.env.FORA_VOLUME_SURGE_RATIO, 3) },
    announcement: {
      enabled: true,
      pageSize: num(process.env.FORA_ANNOUNCEMENT_PAGE_SIZE, 20),
      keywords: list(process.env.FORA_ANNOUNCEMENT_KEYWORDS, [
        '重组',
        '停牌',
        '复牌',
        '立案',
        '处罚',
        '问询函',
        '关注函',
        '业绩预增',
        '业绩预亏',
        '减持',
        '增持',
        '回购',
        '质押',
        '重大资产',
        '中标',
      ]),
    },
  },

  storage: {
    dir: process.env.FORA_STATE_DIR || `${process.env.TMPDIR || '/tmp'}/for-a-web`,
  },

  alerts: {
    keep: num(process.env.FORA_ALERT_KEEP, 200),
  },
};

export default config;
