# For-A

A 股信息监控平台 —— 多源行情与公告采集、规则引擎驱动告警。

零成本起步：免费公开接口即可覆盖盘中秒级行情、历史行情、上市公司公告三类数据；
多源交叉校验保证拿到的数字可信；规则引擎把异动、涨跌停、放量、公告事件变成可推送的告警。

---

## 快速开始

```bash
pip install -r requirements.txt

# 1) 自检各数据源连通性
python -m for_a check

# 2) 拉一次行情快照
python -m for_a quote --codes 600519,000001,300750,688981

# 3) 查某只股票的公告
python -m for_a announcements --code 600519 --limit 10

# 4) 常驻监控
cp config.example.yaml config.yaml   # 按需修改 watchlist / 规则阈值 / 告警通道
python -m for_a watch --config config.yaml
```

安装为命令行工具：

```bash
pip install -e .
for-a watch --config config.yaml
```

---

## 架构

```
数据源                聚合               规则引擎              告警出口
─────────────      ────────────      ──────────────      ─────────────
腾讯 qt.gtimg.cn  ┐                 涨跌幅超阈值   ┐
新浪 hq.sinajs.cn ┤→ 多源交叉校验  → 触及涨跌停    ├→ 告警去重  →  控制台
东财 push2        ┘  （分歧告警）    换手率/放量    │   （SQLite）   飞书
巨潮 cninfo         主源 + 校验源    公告关键词命中 ┘                钉钉 / 企业微信
                                                                   通用 Webhook
```

| 模块 | 说明 |
|---|---|
| `for_a/sources/` | 各数据源适配器，输出统一到 `Quote` / `Announcement` |
| `for_a/aggregator.py` | 主源 + 校验源交叉比对，计算价格分歧度、识别卡住的源 |
| `for_a/rules/` | 规则实现，价格类规则基于行情、公告类规则基于标题关键词 |
| `for_a/alerts/` | 告警出口，控制台 / 飞书 / 钉钉 / 企业微信 |
| `for_a/storage.py` | SQLite：告警去重、上次行情快照、已读公告 |
| `for_a/watch.py` | 监控主循环，单轮失败不终止整体 |

---

## 已接入的数据渠道

### 实时行情（盘中，秒级）

| 渠道 | 成本 | 说明 |
|---|---|---|
| 腾讯 `qt.gtimg.cn` | ¥0 | 字段最全（A 股 80+，含涨跌停价、量比、换手、五档），免 Referer，一次可混查 A/港/美；**港美为延迟档** |
| 新浪 `hq.sinajs.cn` | ¥0 | **必须带 Referer**，否则 403；港股实时价需 `rt_` 前缀 |
| 东财 `push2` | ¥0 | 返回 JSON，最适合脚本化；**代号制**，价格字段 ÷100，时间戳在 `f86`；多镜像自动降级 |
| `pytdx`（可选依赖） | ¥0 | 通达信协议直连，**tick 级分笔与盘口**，无需注册，需 `pip install pytdx` |

### 历史行情与财务基本面

| 渠道 | 成本 | 说明 |
|---|---|---|
| AKShare | ¥0 | 覆盖最广，但本质是爬虫聚合，源站改版即失效 |
| aktools | ¥0 | 把 AKShare 打成 HTTP API + MCP Server，适合作为对外接入层 |
| BaoStock | ¥0 | 匿名登录，日线 17:30 齐、分钟线次日 11:00 |
| Tushare Pro | ≈¥200–500/年 | A 股财务面最全，有官方 MCP（258 工具） |

### 公告与信息披露

| 渠道 | 成本 | 说明 |
|---|---|---|
| 巨潮资讯网 cninfo | ¥0 | 证监会指定披露平台，公告全文 PDF；本项目已接入 |
| 深证信数据服务平台 | 付费 | 正式商业 API |
| 上交所 / 深交所官网 | ¥0 | 停复牌、问询函、监管措施 |

### 尚未接入（扩展点）

资讯快讯（财联社电报、东财 7×24）、研报（Tushare `report_rc`）、舆情（雪球、股吧、微博、RSSHub）、
宏观（统计局、人民银行、海关总署）、券商网关（富途 OpenD / 长桥 terminal，可提供 tick 级授权行情）。

---

## 数据可靠性：六道闸门

免费公开接口没有 SLA，这六条是本项目在工程上做的硬约束：

1. **复权口径必须显式声明** —— 东财 `push2his` 的 `fqt=1`（前复权）在远端会算出负价，长周期回测用 `fqt=2` 后复权。
2. **多源交叉校验** —— 主源与校验源价格分歧超阈值（默认 0.5%）即触发 `divergence` 告警，分歧时以有授权的源为准。
3. **限流与退避** —— 同域名最小请求间隔默认 0.5s；东财 push2his 连续重试会被限流，超限常返回空值而非报错，因此每层都做重试与镜像降级。
4. **不要假设"刚拿到就是新的"** —— 用行情自带的时间戳字段自检新鲜度；聚合器会比对各源时间戳，识别卡住的源。
5. **免费源不能当唯一源** —— 主源失败时聚合器自动回退到校验源，单源故障不会让整条链路挂掉。
6. **盘口深度是授权不是功能** —— 免费公开接口只到五档，十档/逐笔需 Level-2。

---

## 配置

`config.example.yaml` 是完整示例，常见字段：

```yaml
watchlist: ["600519", "000001"]

sources:
  primary: eastmoney        # 主源
  verify: [tencent, sina]   # 校验源
  min_interval: 0.5         # 同域名最小请求间隔（秒）
  divergence_tolerance: 0.005

rules:
  price_change: { enabled: true, threshold_pct: 5.0 }
  limit:       { enabled: true }
  turnover:    { enabled: true, threshold_pct: 10.0 }
  volume_surge:{ enabled: true, ratio: 3.0 }
  announcement:
    enabled: true
    keywords: [重组, 停牌, 立案, 问询函, 减持, 质押]

poll:
  interval_seconds: 15
  announcement_interval_seconds: 300

alerts:
  - type: console
  - type: webhook
    webhook:
      type: lark              # lark | dingtalk | wecom | generic
      env_url: FORA_LARK_WEBHOOK_URL
      env_secret: FORA_LARK_SIGN_SECRET
```

> YAML 会把 `000001` 解析成整数并丢掉前导零，**自选股代码务必加引号**。

Webhook 密钥建议走环境变量（见 `.env.example`），不要写进仓库。

---

## 扩展

**加一个行情源**：继承 `for_a/sources/base.py` 的 `QuoteSource`，实现 `fetch(codes) -> dict[str, Quote]`，
在 `for_a/sources/__init__.py` 的注册表里登记。

**加一条规则**：继承 `Rule`（行情类）或 `AnnouncementRule`（公告类），实现 `evaluate`，
在 `for_a/rules/__init__.py` 的 `build_rules` 中加入。

**加一个告警出口**：继承 `Alerter`，实现 `send(alerts)`，在 `for_a/alerts/__init__.py` 登记。

---

## 测试

```bash
pip install pytest
python -m pytest -q
```

测试使用 2026-11-27 盘中实测报文，不依赖网络。

---

## 免责声明

本项目仅用于数据采集与技术研究，不构成任何投资建议。
行情数据来自第三方公开接口，版权归原提供方所有；商用前请自行确认数据授权与合规要求。
