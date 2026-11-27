"""命令行入口。

    for-a quote  --codes 600519,000001          # 单次取数
    for-a check                                # 各数据源连通性自检
    for-a announcements --code 600519          # 查公告
    for-a watch --config config.yaml           # 常驻监控
"""

from __future__ import annotations

import argparse
import logging
import sys
from typing import List

from .aggregator import Aggregator
from .config import Config, load_config
from .http import HttpClient
from .models import normalize_code
from .sources import build_source
from .sources.cninfo import CninfoSource
from .watch import Watcher


def _setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
        datefmt="%H:%M:%S",
    )


def _parse_codes(raw: str) -> List[str]:
    codes = []
    for item in raw.replace("，", ",").split(","):
        item = item.strip()
        if item:
            codes.append(normalize_code(item))
    return codes


def cmd_quote(args: argparse.Namespace) -> int:
    codes = _parse_codes(args.codes)
    if not codes:
        print("未指定 --codes", file=sys.stderr)
        return 2

    client = HttpClient(timeout=args.timeout, min_interval=args.interval)
    source_names = [args.source] if args.source else ["eastmoney", "tencent", "sina"]
    aggregator = Aggregator(
        client=client,
        primary=source_names[0],
        verify=source_names[1:],
    )
    aggregated = aggregator.fetch(codes)

    print(f"\n{'代码':<12}{'名称':<10}{'现价':>10}{'涨跌幅':>9}{'换手%':>8}{'时间':>10}  源")
    print("-" * 78)
    for code in codes:
        item = aggregated.get(code)
        if not item or not item.ok:
            print(f"{code:<12}{'获取失败':<10} {item.errors if item else ''}")
            continue
        quote = item.quote
        assert quote is not None
        stamp = quote.quote_time.strftime("%H:%M:%S") if quote.quote_time else "-"
        flag = ""
        if item.divergence > 0.005:
            flag = f"  ⚠分歧 {item.divergence * 100:.2f}%"
        print(
            f"{quote.code:<12}{quote.name:<10}{quote.price:>10.2f}"
            f"{quote.change_pct:>8.2f}%{quote.turnover:>8.2f}{stamp:>10}  {quote.source}{flag}"
        )
    aggregator.close()
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    client = HttpClient(timeout=args.timeout)
    targets = [
        ("tencent", ["600519"]),
        ("sina", ["600519"]),
        ("eastmoney", ["600519"]),
        ("cninfo", ["600519"]),
    ]
    print(f"{'数据源':<12}{'状态':<8}说明")
    print("-" * 60)
    failed = 0
    for name, codes in targets:
        try:
            source = build_source(name, client)
            if name == "cninfo":
                result = source.fetch(codes)  # type: ignore[attr-defined]
                count = sum(len(v) for v in result.values())
                detail = f"公告 {count} 条"
            else:
                quotes = source.fetch(codes)  # type: ignore[attr-defined]
                quote = next(iter(quotes.values()), None)
                detail = (
                    f"{quote.name} {quote.price:.2f} ({quote.source})"
                    if quote
                    else "无数据"
                )
            print(f"{name:<12}{'正常':<8}{detail}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"{name:<12}{'异常':<8}{exc}")
    return 1 if failed else 0


def cmd_announcements(args: argparse.Namespace) -> int:
    client = HttpClient(timeout=args.timeout)
    source = CninfoSource(client)
    if args.code:
        codes = _parse_codes(args.code)
        mapping = source.fetch(codes, page_size=args.limit)
        items = [ann for anns in mapping.values() for ann in anns]
    else:
        items = source.fetch_recent(page_size=args.limit)
    for ann in items:
        print(f"[{ann.publish_time:%Y-%m-%d %H:%M}] {ann.code} {ann.name} {ann.title}")
        print(f"    {ann.url}")
    print(f"\n共 {len(items)} 条")
    return 0


def cmd_watch(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    if args.codes:
        config.watchlist = _parse_codes(args.codes)
    if args.interval:
        config.poll.interval_seconds = args.interval
    if not config.watchlist:
        print("自选股列表为空，请在 config.yaml 中配置 watchlist 或用 --codes 指定", file=sys.stderr)
        return 2
    watcher = Watcher(config)
    try:
        watcher.run_forever()
    except KeyboardInterrupt:
        watcher.close()
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="for-a", description="A 股信息监控平台"
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="输出调试日志")
    sub = parser.add_subparsers(dest="command", required=True)

    quote = sub.add_parser("quote", help="拉取一次行情快照")
    quote.add_argument("--codes", required=True, help="逗号分隔的代码，如 600519,000001")
    quote.add_argument("--source", help="指定主数据源：tencent / sina / eastmoney")
    quote.add_argument("--timeout", type=float, default=10.0)
    quote.add_argument("--interval", type=float, default=0.5, help="最小请求间隔（秒）")
    quote.set_defaults(func=cmd_quote)

    check = sub.add_parser("check", help="自检各数据源连通性")
    check.add_argument("--timeout", type=float, default=10.0)
    check.set_defaults(func=cmd_check)

    ann = sub.add_parser("announcements", help="查询公告")
    ann.add_argument("--code", help="按代码查询，留空则返回全市场最新")
    ann.add_argument("--limit", type=int, default=10)
    ann.add_argument("--timeout", type=float, default=15.0)
    ann.set_defaults(func=cmd_announcements)

    watch = sub.add_parser("watch", help="常驻监控")
    watch.add_argument("--config", help="配置文件路径（YAML）")
    watch.add_argument("--codes", help="覆盖配置里的自选股列表")
    watch.add_argument("--interval", type=int, help="覆盖轮询间隔（秒）")
    watch.set_defaults(func=cmd_watch)

    return parser


def main(argv: List[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    _setup_logging(args.verbose)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
