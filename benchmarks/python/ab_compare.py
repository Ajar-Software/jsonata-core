#!/usr/bin/env python3
"""Compare two jsonatapy builds on the same machine, interleaved.

The PR benchmark job compares a PR against the last `main` run, which ran
on a different GitHub-hosted runner at a different time. Runner speed
alone moves every test by 15-50% in the same direction, so that check
can't tell a real regression from a slow machine. This script times two
builds in alternating rounds on one machine and reports each build's best
round, which keeps noise from the host out of the comparison.

Each build is an unpacked wheel directory (the one holding `jsonatapy/`).
Every round runs each build in its own subprocess, alternating which goes
first.

Usage:
    ab_compare.py [--rounds N] [--markdown] BASE_DIR HEAD_DIR
"""

import argparse
import json
import os
import subprocess
import sys
import time

REGRESSION_THRESHOLD_PCT = 10


def _cases():
    products = [
        {
            "name": f"p{i}",
            "price": i % 97,
            "inStock": i % 3 == 0,
            "category": ["a", "b", "c"][i % 3],
            "vendor": {"name": f"v{i % 7}"},
            "rating": i % 5,
        }
        for i in range(100)
    ]
    shop = {"products": products}
    values_100 = {"values": list(range(100))}
    values_1000 = {"values": list(range(1000))}
    # (name, expression, data, iterations): the same kinds of expression as
    # the categories in benchmark.py, plus the path operators (%, #, @, ^).
    return [
        ("Simple Path", "user.name", {"user": {"name": "Alice", "age": 30}}, 5000),
        ("Deep Path (5 levels)", "a.b.c.d.e", {"a": {"b": {"c": {"d": {"e": 42}}}}}, 5000),
        ("Array Index Access", "values[50]", values_100, 3000),
        ("Arithmetic Expression", "price * quantity", {"price": 10.5, "quantity": 3}, 5000),
        ("Array Sum (100)", "$sum(values)", values_100, 2000),
        ("Array Sum (1000)", "$sum(values)", values_1000, 500),
        ("Array Mapping", "products.name", shop, 300),
        ("Array Filtering", "products[price > 50 and inStock].name", shop, 300),
        ("Object Construction", 'products.{"n": name, "p": price}', shop, 200),
        ("Conditional", 'price > 50 ? "high" : "low"', {"price": 60}, 5000),
        ("String Uppercase", "$uppercase(user.name)", {"user": {"name": "alice"}}, 5000),
        ("String Concatenation", 'first & " " & last', {"first": "a", "last": "b"}, 5000),
        ("$map with lambda", "$map(values, function($v) { $v * 2 })", values_100, 300),
        ("$filter with lambda", "$filter(values, function($v) { $v % 2 = 0 })", values_100, 300),
        ("Group by", "products{category: $sum(price)}", shop, 200),
        ("Sort", "products^(>price).name", shop, 200),
        ("Parent (%)", "products.vendor[%.price > 50].name", shop, 100),
        ("Index bind (#)", "products#$i[$i < 5].name", shop, 200),
        ("Focus bind (@)", "products@$p[$p.inStock].$p.name", shop, 200),
        ("Top rated", "products[rating >= 4]^(>price)[[0..4]].name", shop, 300),
    ]


def run_child(iterations_scale: float) -> None:
    """Time every case once in this process; print JSON {name: us/iter}."""
    import jsonatapy

    out = {}
    for name, expression, data, iterations in _cases():
        n = max(1, int(iterations * iterations_scale))
        compiled = jsonatapy.compile(expression)
        for _ in range(max(5, n // 10)):
            compiled.evaluate(data)
        start = time.perf_counter()
        for _ in range(n):
            compiled.evaluate(data)
        out[name] = (time.perf_counter() - start) / n * 1e6
    print(json.dumps(out))


def time_build(build_dir: str, scale: float) -> dict:
    env = dict(os.environ, PYTHONPATH=os.path.abspath(build_dir))
    result = subprocess.run(
        [sys.executable, os.path.abspath(__file__), "--child", "--scale", str(scale)],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("base", nargs="?")
    parser.add_argument("head", nargs="?")
    parser.add_argument("--rounds", type=int, default=10)
    parser.add_argument("--scale", type=float, default=1.0, help="multiply every iteration count")
    parser.add_argument("--markdown", action="store_true")
    parser.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()

    if args.child:
        run_child(args.scale)
        return 0
    if not args.base or not args.head:
        parser.error("BASE_DIR and HEAD_DIR are required")

    best: dict[str, dict[str, float]] = {"base": {}, "head": {}}
    for round_no in range(args.rounds):
        order = [("base", args.base), ("head", args.head)]
        if round_no % 2:
            order.reverse()
        for label, build_dir in order:
            for name, us in time_build(build_dir, args.scale).items():
                best[label][name] = min(us, best[label].get(name, float("inf")))
        print(f"round {round_no + 1}/{args.rounds} done", file=sys.stderr)

    rows = []
    regressions = 0
    for name, *_ in _cases():
        base_us, head_us = best["base"][name], best["head"][name]
        change = (head_us / base_us - 1) * 100
        flag = ""
        if change > REGRESSION_THRESHOLD_PCT:
            flag = "slower"
            regressions += 1
        elif change < -REGRESSION_THRESHOLD_PCT:
            flag = "faster"
        rows.append((name, base_us, head_us, change, flag))

    if args.markdown:
        print(f"Best of {args.rounds} interleaved rounds, microseconds per evaluation.\n")
        print("| Test | Base | Head | Change | |")
        print("|---|---:|---:|---:|---|")
        for name, base_us, head_us, change, flag in rows:
            print(f"| {name} | {base_us:.2f} | {head_us:.2f} | {change:+.1f}% | {flag} |")
        print(f"\n{regressions} test(s) more than {REGRESSION_THRESHOLD_PCT}% slower.")
    else:
        print(f"{'Test':24} {'base us':>10} {'head us':>10} {'change':>8}")
        for name, base_us, head_us, change, flag in rows:
            print(f"{name:24} {base_us:10.2f} {head_us:10.2f} {change:+7.1f}% {flag}")
        print(f"{regressions} test(s) more than {REGRESSION_THRESHOLD_PCT}% slower.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
