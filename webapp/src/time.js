/**
 * 时间解析：A股行情时间戳是北京时间（UTC+8），必须显式换算成 UTC。
 *
 * 若按容器本地时区解析，东财（Unix 秒）与腾讯/新浪（北京时间字符串）
 * 会产生整 8 小时的偏差，交叉校验会把每个标的都误判为"数据滞后"。
 * 中国不实行夏令时，固定 +08:00 偏移即可。
 */

const SHANGHAI_OFFSET_MINUTES = 8 * 60;

/** 把北京时间字段换算成 UTC 毫秒时间戳。 */
export function shanghaiToUtc(year, month, day, hour, minute, second) {
  return Date.UTC(year, month - 1, day, hour, minute, second) - SHANGHAI_OFFSET_MINUTES * 60000;
}

/** 解析 ``20261127153124`` 形式的腾讯时间戳。 */
export function parseCompactBeijingTime(raw) {
  if (typeof raw !== 'string' || raw.length < 14) return null;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  const hour = Number(raw.slice(8, 10));
  const minute = Number(raw.slice(10, 12));
  const second = Number(raw.slice(12, 14));
  if (!year || !month || !day) return null;
  const timestamp = shanghaiToUtc(year, month, day, hour, minute, second);
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

/** 解析 ``2026-11-27 15:31:52`` 形式的新浪时间戳。 */
export function parseBeijingTime(date, time) {
  if (!date || !time) return null;
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2}):(\d{2})$/.exec(time);
  if (!dateMatch || !timeMatch) return null;
  const timestamp = shanghaiToUtc(
    Number(dateMatch[1]),
    Number(dateMatch[2]),
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    Number(timeMatch[3]),
  );
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp).toISOString();
}
