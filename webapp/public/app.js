const REFRESH_MS = 10000;
const SEARCH_DEBOUNCE_MS = 240;

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
  searchInput: document.getElementById('search-input'),
  searchResults: document.getElementById('search-results'),
  toast: document.getElementById('toast'),
};

const search = {
  keyword: '',
  results: [],
  active: -1,
  seq: 0,
  timer: null,
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

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setConnection(online) {
  el.connPill.classList.toggle('online', online);
  el.connPill.classList.toggle('offline', !online);
  el.connText.textContent = online ? '数据已连接' : '快照模式';
}

let toastTimer = null;
function toast(message, bad = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle('bad', !!bad);
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2400);
}

async function getJson(path) {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// ---------------- 行情表 ----------------

function renderQuotes(quotes) {
  el.quoteCount.textContent = `${quotes.length} 项`;

  if (!quotes.length) {
    el.quoteBody.innerHTML =
      '<tr class="empty-row"><td colspan="10">自选股为空，用上方搜索框添加吧</td></tr>';
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
        <td class="col-op"><button class="row-del" type="button" data-remove="${escapeHtml(item.code)}" title="移出自选">×</button></td>
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

// ---------------- 其他区块 ----------------

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

const LS_KEY = 'fora.watchlist.v1';
let syncedOnce = false;

function readLocalWatchlist() {
  try {
    const value = JSON.parse(localStorage.getItem(LS_KEY));
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function writeLocalWatchlist(codes) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(codes));
  } catch {
    // 隐私模式下 localStorage 可能不可写
  }
}

/** 服务端自选存在临时盘，重启会丢；用浏览器本地副本补回来。 */
async function syncWatchlist(serverCodes) {
  const local = readLocalWatchlist();
  if (!local) {
    writeLocalWatchlist(serverCodes);
    return false;
  }

  const toAdd = local.filter((code) => !serverCodes.includes(code));
  const toRemove = serverCodes.filter((code) => !local.includes(code));
  if (!toAdd.length && !toRemove.length) return false;

  await Promise.all([
    ...toAdd.map((code) =>
      fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      }),
    ),
    ...toRemove.map((code) =>
      fetch(`/api/watchlist?code=${encodeURIComponent(code)}`, { method: 'DELETE' }),
    ),
  ]);
  return true;
}

async function load() {
  try {
    if (!syncedOnce) {
      syncedOnce = true;
      const status = await getJson('/api/status');
      const changed = await syncWatchlist(status.watchlist || []);
      if (changed) await new Promise((resolve) => setTimeout(resolve, 1600));
    }

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
    setConnection(false);
  }
}

// ---------------- 搜索 ----------------

function hideSearch() {
  el.searchResults.hidden = true;
  el.searchResults.innerHTML = '';
  search.active = -1;
}

function renderSearchResults() {
  const { results, active, keyword } = search;
  if (!results.length) {
    if (/^\d{6}$/.test(keyword)) {
      el.searchResults.innerHTML = `<div class="search-item">
        <div class="search-main">
          <div class="search-name">直接添加 ${escapeHtml(keyword)}</div>
          <div class="search-sub">本地清单里没有，仍可尝试拉取行情</div>
        </div>
        <button class="search-add" type="button" data-add="${escapeHtml(keyword)}">加自选</button>
      </div>`;
    } else {
      el.searchResults.innerHTML = '<div class="search-empty">没有匹配的 A 股</div>';
    }
    el.searchResults.hidden = false;
    return;
  }

  el.searchResults.innerHTML = results
    .map(
      (item, index) => `<div class="search-item${index === active ? ' active' : ''}" data-index="${index}">
        <div class="search-main">
          <div class="search-name">${escapeHtml(item.name)}</div>
          <div class="search-sub">${escapeHtml(item.code)} · ${escapeHtml(item.board || item.market)}</div>
        </div>
        <button class="search-add" type="button" data-add="${escapeHtml(item.code)}">加自选</button>
      </div>`,
    )
    .join('');
  el.searchResults.hidden = false;
}

async function runSearch(keyword) {
  const seq = ++search.seq;
  try {
    const data = await getJson(`/api/search?q=${encodeURIComponent(keyword)}`);
    if (seq !== search.seq) return;
    search.results = data.results || [];
    search.active = -1;
    renderSearchResults();
  } catch {
    if (seq !== search.seq) return;
    search.results = [];
    el.searchResults.innerHTML = '<div class="search-empty">搜索服务暂时不可用</div>';
    el.searchResults.hidden = false;
  }
}

async function addToWatchlist(code) {
  try {
    const response = await fetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);

    hideSearch();
    el.searchInput.value = '';
    search.keyword = '';
    if (Array.isArray(data.watchlist)) writeLocalWatchlist(data.watchlist);
    toast(data.added ? `已加入自选 ${code}` : `${code} 已在自选中`);

    // 服务端立刻补拉一次行情，稍等再刷新
    setTimeout(load, 900);
    setTimeout(load, 2400);
  } catch (err) {
    toast(`添加失败：${String(err.message || err)}`, true);
  }
}

async function removeFromWatchlist(code) {
  try {
    const response = await fetch(`/api/watchlist?code=${encodeURIComponent(code)}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (Array.isArray(data.watchlist)) writeLocalWatchlist(data.watchlist);
    toast(`已移出自选 ${code}`);
    setTimeout(load, 900);
  } catch (err) {
    toast(`移除失败：${String(err.message || err)}`, true);
  }
}

el.searchInput.addEventListener('input', () => {
  const keyword = el.searchInput.value.trim();
  search.keyword = keyword;
  clearTimeout(search.timer);

  if (!keyword) {
    search.seq += 1;
    search.results = [];
    hideSearch();
    return;
  }

  search.timer = setTimeout(() => runSearch(keyword), SEARCH_DEBOUNCE_MS);
});

el.searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    hideSearch();
    el.searchInput.blur();
    return;
  }
  if (!search.results.length) {
    if (event.key === 'Enter' && /^\d{6}$/.test(search.keyword)) {
      event.preventDefault();
      addToWatchlist(search.keyword);
    }
    return;
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    search.active = (search.active + 1) % search.results.length;
    renderSearchResults();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    search.active = (search.active - 1 + search.results.length) % search.results.length;
    renderSearchResults();
  } else if (event.key === 'Enter') {
    const index = search.active >= 0 ? search.active : 0;
    const item = search.results[index];
    if (item) {
      event.preventDefault();
      addToWatchlist(item.code);
    }
  }
});

el.searchResults.addEventListener('click', (event) => {
  const addBtn = event.target.closest('[data-add]');
  if (addBtn) {
    addToWatchlist(addBtn.getAttribute('data-add'));
    return;
  }
  const row = event.target.closest('.search-item');
  if (row) {
    const item = search.results[Number(row.getAttribute('data-index'))];
    if (item) addToWatchlist(item.code);
  }
});

el.quoteBody.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-remove]');
  if (btn) removeFromWatchlist(btn.getAttribute('data-remove'));
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.search-wrap')) hideSearch();
});

el.refresh.addEventListener('click', () => {
  el.refresh.textContent = '加载中';
  load().finally(() => {
    el.refresh.textContent = '刷新';
  });
});

renderSnapshot(readBootstrap());
load();
setInterval(load, REFRESH_MS);
