const REFRESH_MS = 10000;

const el = {
  connPill: document.getElementById('conn-pill'),
  connText: document.getElementById('conn-text'),
  lastUpdate: document.getElementById('last-update'),
  refresh: document.getElementById('refresh'),
  statCount: document.getElementById('stat-count'),
  statCountHint: document.getElementById('stat-count-hint'),
  statAlerts: document.getElementById('stat-alerts'),
  statAlertsHint: document.getElementById('stat-alerts-hint'),
  statBreadth: document.getElementById('stat-breadth'),
  statSources: document.getElementById('stat-sources'),
  statSourcesHint: document.getElementById('stat-sources-hint'),
  quoteBody: document.getElementById('quote-body'),
  quoteCount: document.getElementById('quote-count'),
  alertFeed: document.getElementById('alert-feed'),
  alertCount: document.getElementById('alert-count'),
  announcementFeed: document.getElementById('announcement-feed'),
  announcementCount: document.getElementById('announcement-count'),
  sourceList: document.getElementById('source-list'),
};

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Number(value).toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatBigNumber(value) {
  const num = Number(value || 0);
  if (!num) return '—';
  if (num >= 1e8) return `${(num / 1e8).toFixed(2)}亿`;
  if (num >= 1e4) return `${(num / 1e4).toFixed(2)}万`;
  return formatNumber(num, 0);
}

function formatTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

function trendClass(value) {
  if (value > 0) return 'up';
  if (value < 0) return 'down';
  return 'flat';
}

function setConnection(online) {
  el.connPill.classList.toggle('online', online);
  el.connPill.classList.toggle('offline', !online);
  el.connText.textContent = online ? '数据已连接' : '快照模式';
}

async function getJson(path) {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function renderQuotes(quotes) {
  el.quoteCount.textContent = `${quotes.length} 项`;

  if (!quotes.length) {
    el.quoteBody.innerHTML =
      '<tr class="empty-row"><td colspan="9">暂未取到行情数据，数据源可能暂时不可达</td></tr>';
    return;
  }

  const rows = quotes
    .map((item) => {
      const quote = item.quote || {};
      const cls = trendClass(quote.changePct);
      const direction = quote.changePct > 0 ? '+' : '';
      const limitChip =
        quote.limitUp && quote.price >= quote.limitUp - 1e-6
          ? '<span class="chip chip-limit-up">涨停</span>'
          : quote.limitDown && quote.price <= quote.limitDown + 1e-6
            ? '<span class="chip chip-limit-down">跌停</span>'
            : '';
      const divergencePct = (item.divergence || 0) * 100;
      const lagging = item.staleSources || [];
      let divergenceChip;
      if (item.divergence > 0.005) {
        divergenceChip = `<span class="chip chip-warn">分歧 ${divergencePct.toFixed(2)}%</span>`;
      } else if (lagging.length) {
        divergenceChip = `<span class="chip chip-warn">${escapeHtml(lagging.join('/'))} 滞后</span>`;
      } else {
        divergenceChip = '<span class="chip chip-ok">一致</span>';
      }

      return `<tr>
        <td class="col-name">
          <span class="stock-name">${escapeHtml(quote.name || item.name || '—')}</span>
          <span class="stock-code">${escapeHtml(item.code)}${limitChip ? ' ' + limitChip : ''}</span>
        </td>
        <td class="num price ${cls}">${formatNumber(quote.price)}</td>
        <td class="num ${cls}">${quote.changePct ? direction + formatNumber(quote.changePct) + '%' : '—'}</td>
        <td class="num ${cls}">${quote.change ? direction + formatNumber(quote.change) : '—'}</td>
        <td class="num">${formatBigNumber(quote.volume ? quote.volume / 100 : 0)}</td>
        <td class="num">${formatBigNumber(quote.amount)}</td>
        <td class="num">${quote.turnover ? formatNumber(quote.turnover) + '%' : '—'}</td>
        <td class="num">${quote.amplitude ? formatNumber(quote.amplitude) + '%' : '—'}</td>
        <td class="num">${divergenceChip}</td>
      </tr>`;
    })
    .join('');

  el.quoteBody.innerHTML = rows;

  const up = quotes.filter((item) => (item.quote || {}).changePct > 0).length;
  const down = quotes.filter((item) => (item.quote || {}).changePct < 0).length;
  el.statCount.textContent = String(quotes.length);
  el.statCountHint.textContent = quotes.length ? '实时行情快照' : '自选股';
  el.statBreadth.innerHTML = `<span class="up">${up}</span> / <span class="down">${down}</span>`;
}

function renderAlerts(alerts) {
  el.alertCount.textContent = `${alerts.length} 条`;
  el.statAlerts.textContent = String(alerts.length);
  el.statAlertsHint.textContent = alerts.length ? '规则引擎触发' : '等待数据';

  if (!alerts.length) {
    el.alertFeed.innerHTML = '<li class="feed-empty">暂无告警</li>';
    return;
  }

  el.alertFeed.innerHTML = alerts
    .slice(0, 60)
    .map(
      (alert) => `<li>
        <div class="alert-head">
          <span class="alert-rule">${escapeHtml(alert.rule)}</span>
          <span class="alert-level level-${escapeHtml(alert.level || 'info')}">${escapeHtml(alert.level || 'info')}</span>
          <span class="alert-time">${formatTime(alert.createdAt || alert.quoteTime)}</span>
        </div>
        <div class="alert-msg">${escapeHtml(alert.message)}</div>
      </li>`,
    )
    .join('');
}

function renderAnnouncements(items) {
  el.announcementCount.textContent = `${items.length} 条`;

  if (!items.length) {
    el.announcementFeed.innerHTML = '<li class="feed-empty">暂无公告</li>';
    return;
  }

  el.announcementFeed.innerHTML = items
    .slice(0, 40)
    .map(
      (item) => `<li>
        <a class="ann-title" href="${escapeHtml(item.url || '#')}" target="_blank" rel="noreferrer">${escapeHtml(item.title || '（无标题）')}</a>
        <span class="ann-meta">${escapeHtml(item.name || '')} ${escapeHtml(item.code || '')} · ${formatTime(item.publishTime)}</span>
      </li>`,
    )
    .join('');
}

function renderSources(sources) {
  if (!sources.length) {
    el.sourceList.innerHTML = '<li class="feed-empty">等待首次采样</li>';
    return;
  }

  const online = sources.filter((item) => item.ok).length;
  el.statSources.textContent = `${online}/${sources.length}`;
  el.statSourcesHint.textContent = online === sources.length ? '全部在线' : '部分数据源不可达';

  el.sourceList.innerHTML = sources
    .map((source) => {
      const chip = source.ok
        ? '<span class="chip chip-ok">正常</span>'
        : '<span class="chip chip-bad">不可达</span>';
      const detail = source.ok
        ? `${source.count} 条 · ${source.latencyMs}ms`
        : escapeHtml(source.error || '未知错误');
      return `<li>
        <div class="source-row">
          <span class="source-name">${escapeHtml(source.name)}</span>
          ${chip}
        </div>
        <div class="source-detail" data-source-detail="${escapeHtml(source.name)}">${detail}</div>
      </li>`;
    })
    .join('');
}

/** 主源与校验源的新鲜度对比：某个源卡住时直接点名。 */
function renderFreshness(quotes) {
  const staleCounts = new Map();
  for (const item of quotes) {
    for (const name of item.staleSources || []) {
      staleCounts.set(name, (staleCounts.get(name) || 0) + 1);
    }
  }
  for (const [name, count] of staleCounts.entries()) {
    const node = document.querySelector(`[data-source-detail="${name}"]`);
    if (node) {
      node.textContent = `行情时间落后 ${count} 个标的`;
      node.classList.add('source-detail-warn');
    }
  }
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 服务端注入的快照：首屏直接渲染，不必等 XHR。 */
function readBootstrap() {
  const node = document.getElementById('bootstrap');
  if (!node) return null;
  try {
    return JSON.parse(node.textContent);
  } catch {
    return null;
  }
}

function renderSnapshot(snapshot) {
  if (!snapshot) return false;
  renderQuotes(snapshot.quotes || []);
  renderAlerts(snapshot.alerts || []);
  renderAnnouncements(snapshot.announcements || []);
  renderSources(snapshot.sources || []);
  renderFreshness(snapshot.quotes || []);
  el.lastUpdate.textContent = formatTime(snapshot.lastRunAt);
  return true;
}

async function load() {
  try {
    const [status, quotes, alerts, announcements] = await Promise.all([
      getJson('/api/status'),
      getJson('/api/quotes'),
      getJson('/api/alerts'),
      getJson('/api/announcements'),
    ]);

    setConnection(true);
    renderQuotes(quotes.quotes || []);
    renderAlerts(alerts.alerts || []);
    renderAnnouncements(announcements.announcements || []);
    renderSources(status.sources || []);
    renderFreshness(quotes.quotes || []);
    el.lastUpdate.textContent = formatTime(quotes.updatedAt || status.lastRunAt);
  } catch (error) {
    // 平台网关可能拦截前端 XHR：保留服务端注入的快照，不清空界面
    setConnection(false);
  }
}

el.refresh.addEventListener('click', () => {
  el.refresh.textContent = '加载中';
  load().finally(() => {
    el.refresh.textContent = '刷新';
  });
});

// 先渲染服务端注入的快照，再尝试用 XHR 刷新
renderSnapshot(readBootstrap());
load();
setInterval(load, REFRESH_MS);
