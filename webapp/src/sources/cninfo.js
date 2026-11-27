/**
 * 巨潮资讯网公告适配器。
 *
 * 巨潮是证监会指定的法定信息披露平台，A 股全市场公告的权威来源。
 * 公开接口有两个：
 *  - POST /new/information/topSearch/query —— 证券代码 -> orgId
 *  - POST /new/hisAnnouncement/query —— 公告列表（支持按 代码,orgId 精确过滤）
 */

const SEARCH_ENDPOINT = 'https://www.cninfo.com.cn/new/information/topSearch/query';
const QUERY_ENDPOINT = 'https://www.cninfo.com.cn/new/hisAnnouncement/query';
const DETAIL_ENDPOINT = 'https://www.cninfo.com.cn/new/disclosure/detail';
const STATIC_ENDPOINT = 'https://static.cninfo.com.cn/';

// 交易所 -> 巨潮 column 取值
const COLUMN_BY_MARKET = { SH: 'sse', SZ: 'szse', BJ: 'bj' };

export class CninfoSource {
  constructor(client) {
    this.client = client;
    this.orgIds = new Map();
  }

  /** 查证券的 orgId（公告查询按代码过滤时必需）。 */
  async resolveOrgId(digits) {
    if (this.orgIds.has(digits)) return this.orgIds.get(digits);
    try {
      const payload = await this.client.postForm(SEARCH_ENDPOINT, {
        keyWord: digits,
        maxNum: '10',
      });
      for (const item of payload || []) {
        if (String(item.code) === digits && item.orgId) {
          this.orgIds.set(digits, String(item.orgId));
          return this.orgIds.get(digits);
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  async query(column, stock, pageSize) {
    try {
      const payload = await this.client.postForm(QUERY_ENDPOINT, {
        pageNum: '1',
        pageSize: String(pageSize),
        column,
        tabName: 'fulltext',
        stock,
        searchkey: '',
        secid: '',
        plate: '',
        category: '',
        trade: '',
        seDate: '',
        sortName: '',
        sortType: '',
        isHLtitle: 'true',
      });
      return (payload && payload.announcements) || [];
    } catch {
      return [];
    }
  }

  toAnnouncement(item, market) {
    const timestamp = Number(item.announcementTime);
    const publishTime = item.announcementTime
      ? new Date(timestamp).toISOString()
      : new Date().toISOString();
    const adjunct = String(item.adjunctUrl || '');
    const announcementId = String(item.announcementId || '');
    const secCode = String(item.secCode || '');

    return {
      code: secCode ? `${secCode}.${market}` : '',
      name: String(item.secName || ''),
      title: String(item.announcementTitle || ''),
      publishTime,
      url: `${DETAIL_ENDPOINT}?announcementId=${announcementId}&stockCode=${secCode}&orgId=${item.orgId || ''}`,
      pdfUrl: adjunct ? `${STATIC_ENDPOINT}${adjunct}` : '',
      announcementId,
      source: 'cninfo',
    };
  }

  /** 拉取全市场最新公告（沪 + 深）。 */
  async fetchRecent(pageSize = 20) {
    const items = [];
    for (const column of ['sse', 'szse']) {
      items.push(...(await this.query(column, '', pageSize)));
    }

    const announcements = items.map((item) => this.toAnnouncement(item, item.column === 'sse' ? 'SH' : 'SZ'));
    announcements.sort((a, b) => new Date(b.publishTime) - new Date(a.publishTime));
    return announcements;
  }

  /** 按证券代码拉取公告。 */
  async fetchByCode(code, pageSize = 20) {
    const [digits, market] = String(code).split('.');
    const orgId = await this.resolveOrgId(digits);
    if (!orgId) return [];
    const column = COLUMN_BY_MARKET[market] || 'szse';
    const items = await this.query(column, `${digits},${orgId}`, pageSize);
    return items.map((item) => this.toAnnouncement(item, market));
  }
}

export default CninfoSource;
