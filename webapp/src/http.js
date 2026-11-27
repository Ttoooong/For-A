/**
 * 共享 HTTP 客户端：统一 UA、重试、退避、按域名的最小请求间隔。
 *
 * 免费公开行情接口没有 SLA，这层的作用是：不要因为一次抖动就把整条监控链路打挂，
 * 也不要因为打得太快被对方限流（东财 push2his 连续重试会直接返回空响应）。
 *
 * 只依赖 Node 内置 http/https 模块，容器内无需安装任何第三方包。
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { URL } from 'node:url';

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const PROXY_URL = pickProxy();

function pickProxy() {
  const raw =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    '';
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function isNoProxyHost(hostname) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
  if (!noProxy) return false;
  return noProxy
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .some((item) =>
      item.startsWith('.') ? hostname.endsWith(item) : hostname === item || hostname.endsWith(`.${item}`),
    );
}

function proxyFor(url) {
  if (!PROXY_URL) return null;
  return isNoProxyHost(new URL(url).hostname) ? null : PROXY_URL;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 按 host 维度的最小请求间隔。 */
export class RateLimiter {
  constructor(minInterval = 0.5) {
    this.minInterval = Math.max(0, minInterval);
    this.last = new Map();
  }

  async wait(host) {
    if (this.minInterval <= 0) return;
    const previous = this.last.get(host) || 0;
    const delta = Date.now() - previous;
    if (delta < this.minInterval) {
      await sleep(this.minInterval - delta);
    }
    this.last.set(host, Date.now());
  }
}

/** 通过 HTTP 代理建立 CONNECT 隧道，供 https.request 使用。 */
class ProxyTunnelAgent extends https.Agent {
  constructor(proxy) {
    super({ keepAlive: false });
    this.proxy = proxy;
  }

  createConnection(options, callback) {
    const target = `${options.host}:${options.port || 443}`;
    const request = http.request({
      host: this.proxy.hostname,
      port: Number(this.proxy.port || 80),
      method: 'CONNECT',
      path: target,
      headers: { Host: target },
      agent: false,
    });

    request.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        callback(new Error(`代理 CONNECT 失败: HTTP ${response.statusCode}`));
        return;
      }
      // CONNECT 隧道是明文通道，TLS 握手必须在这里补上
      const secured = tls.connect({
        socket,
        servername: options.servername || options.host,
        host: options.host,
        port: options.port || 443,
      });
      secured.once('secureConnect', () => callback(null, secured));
      secured.once('error', callback);
    });
    request.once('error', callback);
    request.end();
    return undefined;
  }
}

export class HttpClient {
  constructor({
    timeout = 10,
    retries = 3,
    backoff = 1.5,
    minInterval = 0.5,
    userAgent = DEFAULT_UA,
  } = {}) {
    this.timeout = timeout;
    this.retries = Math.max(1, retries);
    this.backoff = backoff;
    this.userAgent = userAgent;
    this.limiter = new RateLimiter(minInterval);
  }

  /**
   * 发起请求。5xx 值得重试；4xx 直接失败（多半是参数或权限问题）。
   */
  request(method, url, { headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const isHttps = target.protocol === 'https:';
      const proxy = proxyFor(url);

      const options = {
        method,
        headers: {
          'User-Agent': this.userAgent,
          Accept: '*/*',
          ...headers,
        },
      };

      if (body) {
        options.body = body;
        if (options.headers['Content-Length'] === undefined) {
          options.headers['Content-Length'] = Buffer.byteLength(body);
        }
      }

      if (proxy && isHttps) {
        options.agent = new ProxyTunnelAgent(proxy);
        options.host = target.hostname;
        options.port = Number(target.port || 443);
        options.path = `${target.pathname}${target.search}`;
        options.servername = target.hostname;
        options.headers.Host = target.host;
      } else if (proxy) {
        options.host = proxy.hostname;
        options.port = Number(proxy.port || 80);
        options.path = url;
        options.headers.Host = target.host;
      } else {
        options.host = target.hostname;
        options.port = Number(target.port || (isHttps ? 443 : 80));
        options.path = `${target.pathname}${target.search}`;
        if (isHttps) options.servername = target.hostname;
      }

      const transport = isHttps ? https : http;
      const request = transport.request(options, (response) => {
        const chunks = [];
        const encoding = String(response.headers['content-encoding'] || '').toLowerCase();
        const decompress =
          encoding === 'gzip'
            ? zlib.gunzipSync
            : encoding === 'deflate'
              ? zlib.inflateSync
              : encoding === 'br'
                ? zlib.brotliDecompressSync
                : null;

        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const status = response.statusCode || 0;
          if (status >= 400) {
            reject(new Error(`HTTP ${status}`));
            return;
          }
          let body = Buffer.concat(chunks);
          if (decompress) {
            try {
              body = decompress(body);
            } catch {
              // 解压失败时保留原始字节，交由上层解析报错
            }
          }
          resolve({ status, headers: response.headers, body });
        });
      });

      request.setTimeout(this.timeout * 1000, () => {
        request.destroy(new Error(`请求超时 ${this.timeout}s`));
      });

      request.on('error', reject);
      if (body) request.write(body);
      request.end();
    });
  }

  async fetchWithRetry(method, url, options = {}) {
    const host = new URL(url).host;
    let lastError = null;
    for (let attempt = 1; attempt <= this.retries; attempt += 1) {
      await this.limiter.wait(host);
      try {
        return await this.request(method, url, options);
      } catch (error) {
        lastError = error;
        if (attempt < this.retries) {
          await sleep(this.backoff * attempt * 1000);
        }
      }
    }
    throw new Error(`请求最终失败 ${url}: ${lastError && lastError.message}`);
  }

  async getText(url, { encoding = 'utf-8', headers = {} } = {}) {
    const response = await this.fetchWithRetry('GET', url, { headers });
    return decodeBody(response.body, encoding);
  }

  async getJson(url, { headers = {} } = {}) {
    const response = await this.fetchWithRetry('GET', url, { headers });
    return JSON.parse(decodeBody(response.body, 'utf-8'));
  }

  async postForm(url, fields, { headers = {} } = {}) {
    const body = new URLSearchParams(fields).toString();
    const response = await this.fetchWithRetry('POST', url, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...headers,
      },
      body,
    });
    return JSON.parse(decodeBody(response.body, 'utf-8'));
  }
}

const decoders = new Map();

export function decodeBody(buffer, encoding) {
  const name = encoding.toLowerCase();
  if (name === 'utf-8' || name === 'utf8') return buffer.toString('utf8');
  try {
    if (!decoders.has(name)) decoders.set(name, new TextDecoder(name));
    return decoders.get(name).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

export default HttpClient;
