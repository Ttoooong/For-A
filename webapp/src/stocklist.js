// 本地 A 股清单检索。
// 清单来自东财 clist 快照（data/stocks.json），避免运行时依赖易抖动的搜索接口。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveMarket } from './symbols.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', 'stocks.json');

let cache = null;

function boardOf(digits, market) {
  if (market === 'BJ') return '北交所';
  if (digits.startsWith('688') || digits.startsWith('689')) return '科创板';
  if (digits.startsWith('300') || digits.startsWith('301')) return '创业板';
  return market === 'SH' ? '沪A' : '深A';
}

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    cache = raw.map(([digits, name]) => {
      let market;
      try {
        market = resolveMarket(digits);
      } catch {
        market = digits.startsWith('6') ? 'SH' : 'SZ';
      }
      return {
        digits,
        name: String(name).replace(/\s+/g, ''),
        market,
        code: `${digits}.${market}`,
        board: boardOf(digits, market),
      };
    });
  } catch {
    cache = [];
  }
  return cache;
}

export function searchStocksLocal(keyword, limit = 10) {
  const q = String(keyword || '').trim();
  if (!q) return [];

  const isDigits = /^\d+$/.test(q);
  const scored = [];

  for (const stock of load()) {
    let score = -1;
    if (isDigits && stock.digits === q) score = 100;
    else if (stock.name === q) score = 95;
    else if (isDigits && stock.digits.startsWith(q)) score = 80;
    else if (stock.name.startsWith(q)) score = 70;
    else if (stock.name.includes(q)) score = 50;
    else if (isDigits && stock.digits.includes(q)) score = 30;

    if (score >= 0) scored.push({ score, stock });
  }

  scored.sort((a, b) => b.score - a.score || a.stock.digits.localeCompare(b.stock.digits));

  return scored.slice(0, limit).map(({ stock }) => ({
    code: stock.code,
    name: stock.name,
    market: stock.market,
    board: stock.board,
  }));
}

export function stockListSize() {
  return load().length;
}
