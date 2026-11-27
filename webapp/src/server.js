/**
 * HTTP 服务：REST API + 静态页面。
 * 只用 Node 内置模块，无第三方依赖。
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import config from './config.js';
import { Watcher } from './watcher.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function sendStatic(response, filePath) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(response, 404, { error: 'not found' });
      return;
    }
    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    response.writeHead(200, {
      'Content-Type': type,
      'Content-Length': content.length,
      'Cache-Control': 'no-cache',
    });
    response.end(content);
  });
}

/**
 * 首页服务端渲染：把当前快照直接写进 HTML。
 *
 * 平台网关对静态资源与 XHR 的鉴权处理不同，前端首屏若只依赖
 * fetch 会在数据到达前空屏。服务端注入保证首屏就有内容。
 */
function sendIndex(response, watcher) {
  const filePath = path.join(PUBLIC_DIR, 'index.html');
  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(response, 404, { error: 'not found' });
      return;
    }
    const snapshot = watcher.snapshot();
    const bootstrap = JSON.stringify({
      quotes: snapshot.quotes,
      alerts: snapshot.alerts,
      announcements: snapshot.announcements,
      sources: snapshot.sources,
      lastRunAt: snapshot.lastRunAt,
      lastError: snapshot.lastError,
    });
    const html = content
      .toString('utf8')
      .replace('<!--BOOTSTRAP-->', `<script id="bootstrap" type="application/json">${bootstrap.replace(/</g, '\\u003c')}</script>`);

    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Cache-Control': 'no-cache',
    });
    response.end(html);
  });
}

export function createServer(watcher) {
  return http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    console.log(`${request.method} ${url.pathname}`);

    if (url.pathname === '/api/quotes') {
      sendJson(response, 200, {
        updatedAt: watcher.lastRunAt,
        quotes: watcher.snapshot().quotes,
        sources: watcher.aggregator.getSourceStatus(),
      });
      return;
    }

    if (url.pathname === '/api/alerts') {
      sendJson(response, 200, { alerts: watcher.snapshot().alerts });
      return;
    }

    if (url.pathname === '/api/announcements') {
      sendJson(response, 200, { announcements: watcher.snapshot().announcements });
      return;
    }

    if (url.pathname === '/api/status') {
      const snapshot = watcher.snapshot();
      sendJson(response, 200, {
        status: 'ok',
        lastRunAt: snapshot.lastRunAt,
        lastError: snapshot.lastError,
        running: snapshot.running,
        sources: snapshot.sources,
        watchlist: watcher.codes,
        pollIntervalSeconds: config.poll.intervalSeconds,
        startedAt: watcher.startedAt,
      });
      return;
    }

    if (url.pathname === '/api/health') {
      sendJson(response, 200, { status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      sendJson(response, 404, { error: 'unknown endpoint' });
      return;
    }

    const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const resolved = path.resolve(PUBLIC_DIR, relative);
    if (!resolved.startsWith(PUBLIC_DIR)) {
      sendJson(response, 403, { error: 'forbidden' });
      return;
    }
    if (relative === 'index.html') {
      sendIndex(response, watcher);
      return;
    }
    sendStatic(response, resolved);
  });
}

export function start() {
  const watcher = new Watcher(config);
  watcher.startedAt = new Date().toISOString();
  watcher.start();
  const server = createServer(watcher);

  server.listen(config.port, config.host, () => {
    console.log(`For-A Web 服务已启动: http://${config.host}:${config.port}`);
    console.log(`自选股: ${watcher.codes.join(', ')}`);
    console.log(`轮询间隔: ${config.poll.intervalSeconds}s`);
  });

  server.on('error', (error) => {
    console.error('服务启动失败:', error && error.message);
    process.exit(1);
  });

  const shutdown = () => {
    console.log('收到停止信号，正在退出');
    watcher.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return { server, watcher };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  start();
}
