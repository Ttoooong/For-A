# For-A 项目优化计划

## Context

For-A 是一个 A 股信息监控平台：`for_a/sources/` 接入腾讯/新浪/东财/巨潮四个数据源，`for_a/aggregator.py` 做多源交叉校验，`for_a/rules/` 是规则引擎，`for_a/alerts/` 输出到控制台和 Webhook，`for_a/watch.py` 是常驻监控循环，`for_a/storage.py` 用 SQLite 做告警去重。项目结构清晰、职责分离做得不错，33 个测试全部通过。

但深度审阅 + **对四个数据源做线上实测**后，发现三类问题：

1. **6 个功能性缺陷**，其中 4 个是"静默失效"——不报错、不告警，功能就是不工作。README 里"六道闸门"的第 4 条（识别卡住的源）实际是空转的。
2. **3 类性能问题**，主因是东财逐代码串行请求，墙钟时间随自选股数量线性增长。
3. **5 项工程细节**，包括一个会导致 3.9 装不上就崩的版本声明错误。

目标：把"看起来在工作但实际没工作"的部分修好，把取数延迟压下来，让告警真正做到"一条异动一条推送"。

---

## 已实测验证、**不要改动**的结论

这几条容易按旧资料误改，实测证明当前代码是对的：

| 结论 | 实测证据 |
|---|---|
| **ST 主板股票涨跌停是 10%，不是 5%** | `000010 *ST美丽` 昨收 0.86 / 涨停 0.95（+10.47%）；`000056 *ST皇庭` 昨收 1.74 / 涨停 1.91。`models.py` 的 `guess_limit_pct` 10/20/30 假设**与现行规则一致** |
| 创业板/科创板 20%，北交所 30% | `300750` +20.00%、`688981` +20.00%、`920799` 昨收 22.70 / 涨停 29.51（+30.00%） |
| 腾讯/新浪/东财字段下标映射 | `tests/test_parsers.py` 的三源交叉断言（昨收/今开/最高/最低完全一致）已覆盖，实测报文一致 |
| 东财 `ulist.np` 批量端点**不可用** | 实测该端点返回字段值严重错位的报文（`f43=230947.61`、`f57=11.9015685357`），或直接失败。**不要依赖它做批量**，改走镜像池并行 |

---

## 修复清单

### P0 · 功能性缺陷（静默失效）

**P0-1 Webhook 环境变量机制完全失效**
`config.py:206` 的 `Config.resolve_webhook()` 定义了但**全项目没有任何调用点**（`alerts/__init__.py:20` 直接把 `channel.webhook.url` 塞给 `WebhookAlerter`）。后果：`config.example.yaml` 和 README 推荐的 `env_url: FORA_LARK_WEBHOOK_URL` 不生效 → URL 为空 → `WebhookAlerter.send()` 记一句"Webhook 地址为空，跳过投递" → **告警静默丢失**。`.env.example` 里那一整套环境变量约定全是空转。

- `for_a/config.py`：把 `resolve_webhook` 提为模块级函数 `resolve_webhook(hook) -> (url, secret)`。
- `for_a/alerts/__init__.py`：`build_alerters()` 调用它，把解析后的 url/secret 写进新的 `WebhookConfig` 再构造 `WebhookAlerter`。

**P0-2 YAML 自选股前导零丢失**
`config.py:150` 先做了 `str(item)`，把 YAML 解析出的整数 `1` 变成 `"1"`，于是 `models.py:90` `normalize_code()` 的 int 补零分支**永远走不到**（死代码）。实测 `watchlist: [000001]` → `SymbolError: 无法推断交易所: 1`，启动直接崩。README 让人加引号绕过，但代码里明明写了 int 处理却用不上。

- `for_a/config.py`：新增 `_normalize_watchlist(items)`，在 `from_dict` 里就完成归一化——**保留原始 int** 以触发 zfill，输出统一的 `600519.SH`；非法代码抛带原值的 `SymbolError`。
- `for_a/watch.py:28`：`Watcher.__init__` 里的二次 `normalize_code` 删掉（配置层已归一化）。
- `for_a/cli.py`：捕获 `SymbolError`，打印"自选股代码非法：xxx"并以退出码 2 结束，不抛裸 traceback。

**P0-3 stale 检测空转——"识别卡住的源"从未生效**
`aggregator.py:90-102` 算出 `stale` 标记后**没有任何消费方**，`watch.py` 从不读 `item.stale`。主源时间戳卡住时，聚合器仍然选它当权威价，校验源被无视。

- `for_a/models.py`：`AggregatedQuote` 增加 `stale_source: str = ""`、`stale_lag: float = 0.0`。
- `for_a/aggregator.py` `_aggregate()`：定位 `quote_time` 最新的源；若主源比它落后超过 `stale_seconds` → `chosen` 改为最新的那个，`stale=True`，记录卡住的源名与落后秒数。
- `for_a/watch.py`：新增 `_stale_alerts(item)`，卡住时发一条 `source_stale` 告警（哪个源卡住、落后多久、当前采信谁），并**跳过该标的价格类规则**——数据不可信时不做决策。

**P0-4 告警风暴——去重键基于数值而非阈值穿越**
实测（用真实 `Watcher._alert_key` + 真实 SQLite 跑模拟）：

| 场景 | 现状 | 期望 |
|---|---|---|
| 一只股票从 +5.0% 爬到 +10.0%（每轮 +0.1%） | **51 条** | 1 条 |
| 换手率从 1% 升到 30% | **30 条** | 1 条 |

根因：`watch.py:160` `_alert_key()` 把 `round(change_pct, 1)` / `int(turnover)` 拼进键，数值一变键就变，于是每次刷新都是"新告警"。

按你选的**阈值穿越式**改，状态机下沉到规则层（`RuleContext` 里已经有 `storage`，规则自己读写状态最自然）：

- `for_a/storage.py`：新增表 `rule_states(key TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL)`，新增 `get_state(key) -> Optional[str]` / `set_state(key, state)`。
- `for_a/rules/price.py`：
  - `PriceChangeRule`：state = `"up"` / `"down"` / `""`，仅状态变化时产出告警；跌回阈值以下复位为 `""`（复位本身不告警）。
  - `TurnoverRule`：state = `str(int(turnover // 5))`（每 5% 一档），30% 换手最多 6 条而非 30 条。
  - `LimitRule`：state = `"limit_up"` / `"limit_down"` / `""`，开板后复位。
  - `VolumeSurgeRule`：5 分钟桶语义保留，改为基于 `quote.quote_time` 的时间桶而非 `datetime.now()`。
- `for_a/watch.py`：`_divergence_alerts()` 不是 Rule，改用**时间窗**去重（同 code 15 分钟一条，状态存 `rule_states`）；`_alert_key()` 保留给"一次性唯一键"场景（公告按 `announcement_id`）。

**P0-5 东财脏响应未校验，直接入库**
实测 `48.push2.eastmoney.com` / `push2delay` 在高频访问下会返回**字段值错位**或全空的 `data`。`EastmoneySource._get()`（`eastmoney.py:150`）只判断 `payload.get("data")` 非空就接受；`parse_eastmoney_payload()` 对字段缺失返回**全 0 的 Quote 而不是 `None`**（已实测确认）。后果：污染 `quotes` 表基线、触发假的 `price_change` / `divergence` 告警。

- `for_a/sources/eastmoney.py` `parse_eastmoney_payload()`：关键字段（f43 最新价）缺失或 <= 0 → 返回 `None`。
- 同文件 `_get()`：校验 `data` 是 dict、`f57` 与请求代码一致、`f43` > 0；任一不满足 → 记日志换下一个镜像。
- `fetch()`：单码彻底失败不再中断整批（现在 `_get` 抛异常会打断整个 for 循环）。

**P0-6 alerts 表无限增长**
`storage.py:70` 的 `prune_alerts()` 写了但**全项目无调用点**，配合基于数值的去重键，键空间持续膨胀（实测 10 只股票各爬 10% → 510 行）。

- `for_a/watch.py`：每轮结束调用 `storage.prune_alerts(keep_days=7)`；`rule_states` 中状态已复位的空行一并清理。

### P1 · 性能

**P1-1 东财镜像池并行**
`EastmoneySource.fetch()` 现在是 `for code in codes: self._get(code)`，墙钟随自选股数量线性增长：实测 4 码 **1.12s**、10 码 **3.52s**（对比腾讯批量 4 码 0.16s、新浪 0.05s）。50 只自选股约需 14s，直接吃光 15s 轮询预算。且 `_get` 单次最坏 4 镜像 × 3 重试 = 12 次请求/代码。

按你选的**镜像池并行**：把 4 个镜像从"串行降级链"改为"并行分片池"。

- `for_a/sources/eastmoney.py` `fetch()`：用 `ThreadPoolExecutor` 把代码按 `i % len(hosts)` 分片到不同镜像并发请求；每个 worker 内部仍保留"换下一个镜像"的降级路径。
- `for_a/http.py` `RateLimiter` 本身按 host 分桶，4 个镜像各有独立限流桶，并发不会互相阻塞。
- 某镜像本轮连续失败 → 记入失败集合，剩余代码不再打这个镜像（本轮熔断）。
- 实测原型（4 镜像并行 10 码）：**0.90s**（其中 3 个因沙箱代理抖动失败的代码由降级路径补齐）。

**P1-2 4xx 被误当可重试错误**
`http.py:85-95` 注释写"4xx 直接失败（多半是参数或权限问题）"，但 `raise_for_status()` 抛的 `HTTPError` 落在同一个 `except Exception` 里 → 403/404 也会重试 3 次并退避（新浪不带 Referer 就是 403，是典型场景）。单独捕获 `requests.HTTPError`：4xx 直接抛出不重试；429/5xx 继续重试（429 读 `Retry-After`）。

**P1-3 每个 JSON 响应都跑一遍字符集探测**
`http.py:110` `resp.apparent_encoding` 需要 charset 检测全量 body，而 JSON 响应一律 utf-8。`get_json` / `post_json` 直接设 `resp.encoding = "utf-8"`。

**P1-4 SQLite 逐条提交**
`save_quote` / `mark_alert` 各自 `commit()`，一轮 N 只股票 = 2N 次 fsync。`storage.py` 增加公开 `commit()` 与事务上下文，`watch.py run_once()` 一轮结束时统一提交。

### P2 · 工程细节

- **P2-1** `pyproject.toml`：`requires-python = ">=3.9"` → `">=3.10"`。`models.py` 用了 `@dataclass(slots=True)`，3.9 上安装即 ImportError。
- **P2-2** 非法代码启动崩溃 → 见 P0-2。
- **P2-3** `alerts/webhook.py:21` `_LEVEL_EMOJI` 三个值实测是 U+FFFD 替换字符（hex `ef bf bd ef bf bd`），告警前缀全是"��"。换成 ℹ️ / ⚠️ / 🔴。
- **P2-4** `cli.py:68` `cmd_quote` 硬编码 0.005 分歧阈值，且不读配置。给它加 `--config`，读 `divergence_tolerance` 等配置。
- **P2-5** `cninfo.py` 文档说"改为拉取后在本地按时间过滤"，但代码里**没有任何时间过滤**。按你的选择**保持全市场范围不变**，但补上真正的本地时间过滤（只保留最近 N 天）并修正文档字符串。

---

## 涉及文件

| 文件 | 改动 |
|---|---|
| `for_a/config.py` | P0-1、P0-2、P2-4 |
| `for_a/alerts/__init__.py` | P0-1 |
| `for_a/alerts/webhook.py` | P2-3 |
| `for_a/models.py` | P0-3 |
| `for_a/aggregator.py` | P0-3 |
| `for_a/watch.py` | P0-3、P0-4、P0-6、P1-4、P2-2 |
| `for_a/storage.py` | P0-4（rule_states）、P0-6、P1-4 |
| `for_a/rules/price.py` | P0-4 |
| `for_a/sources/eastmoney.py` | P0-5、P1-1 |
| `for_a/sources/cninfo.py` | P2-5 |
| `for_a/http.py` | P1-2、P1-3 |
| `for_a/cli.py` | P0-2、P2-2、P2-4 |
| `pyproject.toml` | P2-1 |
| `tests/` | 新增 + 更新 |

## 实施顺序

1. **P2-1 + P0-2**（配置与版本，最小且独立）
2. **P0-1 + P2-3**（告警出口，改动集中）
3. **P0-3**（聚合器 stale 降级 + watch 消费）
4. **P0-5 + P1-1**（东财：先加校验，再改并行，两步都要）
5. **P0-4**（规则状态机 + storage 新表）—— 单独一步，便于对照告警条数变化
6. **P1-2 + P1-3 + P1-4**（HTTP 与存储层）
7. **P0-6 + P2-4 + P2-5**（收尾）
8. **README 更新**：把"六道闸门"里空转的第 4 条改成真实行为；补上实测得到的数据源事实（ST 10% 规则、`ulist.np` 不可用、镜像池并行）

每一步结束都跑一次 `python -m pytest -q`，保证测试始终绿。

## 验证方法

**自动测试**（新增 `tests/test_config.py`、`tests/test_rule_states.py`，更新 `tests/test_aggregator.py`、`tests/test_parsers.py`）：
- webhook：设环境变量 → `build_alerters()` 产出的 alerter 拿到真实 URL（当前会失败，修复后通过）
- YAML：`watchlist: [000001]` → 归一化为 `000001.SZ`（当前抛 SymbolError）
- stale：主源时间戳落后 → `chosen` 切换到新源 + `stale_source` 正确
- 告警节奏：用本次的真实模拟脚本跑，+5%→+10% 必须从 51 条降到 1 条；换手率 1%→30% 从 30 条降到 ≤6 条
- 脏报文：`f57` 与请求不符 / `f43` 缺失 → 解析器返回 `None` 且源切镜像

**端到端**：
```bash
python -m pytest -q                                  # 全部通过
python -m for_a check                                # 四个源连通
python -m for_a quote --codes 600519,000001,300750   # 三源交叉校验正常
python -m for_a watch --config config.yaml           # 常驻，无异常日志
```

**性能对照**：改造前后各跑一次 10 码取数，记录墙钟时间（基线：现状 3.52s → 目标 ≈1s）。

**手工验收**：配一个真实飞书机器人 webhook（走 `env_url`），确认告警能推到群里——这是 P0-1 最直接的验证。
