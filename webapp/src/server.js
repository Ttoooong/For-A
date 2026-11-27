// For-A A股信息监控台 —— 零依赖 Node.js 服务
// 静态看板 + REST API + 搜索/自选管理

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { state, startPoller, tick } from './poller.js';
import { store } from './store.js';
import { searchStocksLocal } from './stocklist.js';
import { normalizeCode, SymbolError } from './symbols.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '0.0.0.0';

const STATIC_FILES = {
  '/app.js': ['public/app.js', 'application/javascript; charset=utf-8'],
  '/styles.css': ['public/styles.css', 'text/css; charset=utf-8'],
  '/search.css': ['public/search.css', 'text/css; charset=utf-8'],
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf-8');
  return text ? JSON.parse(text) : {};
}

function renderIndex() {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf-8');
  const bootstrap = {
    quotes: state.quotes,
    alerts: store.alerts.slice(0, 60),
    announcements: state.announcements,
    sources: state.sources,
    lastRunAt: state.lastRunAt,
  };
  const safeJson = JSON.stringify(bootstrap).replace(/</g, '\\u003c');
  return html.replace('__BOOTSTRAP__', safeJson);
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;

  if (pathname === '/api/status' && req.method === 'GET') {
    return sendJson(res, 200, {
      status: 'ok',
      lastRunAt: state.lastRunAt,
      lastError: state.lastError,
      running: state.running,
      sources: state.sources,
      watchlist: store.watchlist,
      pollIntervalSeconds: 15,
      startedAt: state.startedAt,
    });
  }

  if (pathname === '/api/quotes' && req.method === 'GET') {
    return sendJson(res, 200, {
      updatedAt: state.lastRunAt,
      quotes: state.quotes,
      sources: state.sources,
    });
  }

  if (pathname === '/api/alerts' && req.method === 'GET') {
    return sendJson(res, 200, { alerts: store.alerts.slice(0, 100) });
  }

  if (pathname === '/api/announcements' && req.method === 'GET') {
    return sendJson(res, 200, { announcements: state.announcements });
  }

  if (pathname === '/api/watchlist' && req.method === 'GET') {
    return sendJson(res, 200, { watchlist: store.watchlist });
  }

  if (pathname === '/api/search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return sendJson(res, 200, { results: [] });
    if (q.length > 24) return sendJson(res, 400, { ok: false, error: '关键词过长' });
    try {
      const results = searchStocksLocal(q, 10);
      return sendJson(res, 200, { results });
    } catch (err) {
      return sendJson(res, 502, { ok: false, error: `搜索失败: ${String(err.message || err)}` });
    }
  }

  if (pathname === '/api/watchlist' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    }
    try {
      const code = normalizeCode(body.code);
      const result = store.add(code);
      tick();
      return sendJson(res, 200, { ok: true, ...result, watchlist: store.watchlist });
    } catch (err) {
      const status = err instanceof SymbolError ? 400 : 409;
      return sendJson(res, status, { ok: false, error: String(err.message || err) });
    }
  }

  if (pathname === '/api/watchlist' && req.method === 'DELETE') {
    try {
      const code = normalizeCode(url.searchParams.get('code'));
      const removed = store.remove(code);
      tick();
      return sendJson(res, 200, { ok: true, removed, watchlist: store.watchlist });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: String(err.message || err) });
    }
  }

  return sendJson(res, 404, { ok: false, error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = renderIndex();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(html);
      return;
    }

    if (url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }

    const entry = STATIC_FILES[url.pathname];
    if (entry) {
      const filePath = path.join(__dirname, '..', entry[0]);
      const data = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': entry[1],
        'Cache-Control': 'public, max-age=60',
      });
      res.end(data);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end(`Internal Error: ${String(err.message || err)}`);
  }
});

server.listen(PORT, HOST, () => {
  startPoller();
  console.log(`For-A 监控台已启动: http://${HOST}:${PORT}  自选股 ${store.watchlist.length} 只`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
