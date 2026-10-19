"""Deep non-tail recursion (GitHub issue #200).

jsonata-js has no fixed recursion limit, so ``$f(5000)`` of a non-tail
recursive ``$f`` evaluates there. Evaluation used to stop at 302 levels (about
100 calls) with U1001. It now goes about 10,000 calls deep and raises U1001
beyond that, and must never crash the process, even on a 1MB thread stack
(Windows' default for a main thread). Each case runs in a subprocess on such
a thread, so a native stack overflow fails the test instead of killing pytest.
"""

import json
import subprocess
import sys
import textwrap

import pytest

RECURSION = "($f := function($n){ $n <= 0 ? 0 : 1 + $f($n - 1) }; $f(%d))"
NO_BASE_CASE = "($inf := function($n){$n+$inf($n-1)}; $inf(5))"

_RUNNER = textwrap.dedent("""
    import json, sys, threading
    import jsonatapy

    jsonatapy._set_force_tree_walker(sys.argv[1] == "tree-walker")
    expr, kwargs = sys.argv[2], json.loads(sys.argv[3])
    out = {}

    def run():
        try:
            result = jsonatapy.evaluate(expr, None, **kwargs)
            if isinstance(result, dict) and "v" in result:
                # Report the nested value under "v" by its depth: json.dumps
                # would itself recurse too deep for this small stack.
                v, out["depth"] = result.pop("v"), 0
                while v:
                    v, out["depth"] = v["a"], out["depth"] + 1
            out["ok"] = json.dumps(result)
        except ValueError as e:
            out["error"] = str(e)

    threading.stack_size(1024 * 1024)
    t = threading.Thread(target=run)
    t.start()
    t.join()
    print(json.dumps(out))
    """)


@pytest.fixture(params=["default", "tree-walker"])
def engine(request):
    return request.param


def _evaluate_on_small_stack(engine, expr, **kwargs):
    proc = subprocess.run(
        [sys.executable, "-c", _RUNNER, engine, expr, json.dumps(kwargs)],
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert (
        proc.returncode == 0
    ), f"process crashed ({proc.returncode}): {proc.stderr[-2000:]}"
    return json.loads(proc.stdout)


@pytest.mark.parametrize("n", [150, 1000, 5000, 9000])
def test_non_tail_recursion_evaluates(engine, n):
    assert _evaluate_on_small_stack(engine, RECURSION % n) == {"ok": str(n)}


def test_recursion_without_base_case_raises_u1001(engine):
    out = _evaluate_on_small_stack(engine, NO_BASE_CASE)
    assert out["error"].startswith("U1001")


def test_max_stack_depth_raises_d1011(engine):
    out = _evaluate_on_small_stack(engine, RECURSION % 3000, max_stack_depth=5000)
    assert out["error"].startswith("D1011")
    out = _evaluate_on_small_stack(engine, RECURSION % 3000, max_stack_depth=10000)
    assert out == {"ok": "3000"}


def test_deep_value_built_by_recursion_converts_to_python(engine):
    # The result is 5000 dicts deep: converting it to Python objects (and the
    # `=`/`$string` walks inside the expression) must not overflow either.
    expr = (
        "($f := function($n){ $n <= 0 ? {} : {'a': $f($n - 1)} };"
        " $v := $f(5000); {'same': $v = $f(5000), 'len': $length($string($v)), 'v': $v})"
    )
    out = _evaluate_on_small_stack(engine, expr)
    assert out == {"depth": 5000, "ok": '{"same": true, "len": 30002}'}


def test_deeply_nested_expression_inside_recursion(engine):
    inner = "(" * 300 + "$x" + "+0)" * 300
    expr = (
        "($f := function($n){ $n <= 0 ? 0 : 1 + $f($map([$n], function($x){"
        + inner
        + "}) - 1) }; $f(3000))"
    )
    assert _evaluate_on_small_stack(engine, expr) == {"ok": "3000"}


def test_too_deeply_nested_expression_raises_u1002(engine):
    out = _evaluate_on_small_stack(engine, "[" * 5000 + "1" + "]" * 5000)
    assert out["error"].startswith("U1002")


_HOST_RUNNER = textwrap.dedent("""
    import json, sys, threading
    import jsonatapy

    n, stack = int(sys.argv[1]), int(sys.argv[2])
    deep = []
    for _ in range(100_000):
        deep = [deep]

    def h():
        try:
            json.dumps(deep)
            return "no error"
        except RecursionError:
            return "RecursionError"

    def run():
        expr = jsonatapy.compile(
            '($f := function($n){ $n <= 0 ? $h() : $f($n - 1) & "" }; $f(%d))' % n
        )
        expr.register("h", h)
        print(expr.evaluate(None), flush=True)

    if stack:
        threading.stack_size(stack)
        t = threading.Thread(target=run)
        t.start()
        t.join()
    else:
        run()
    """)


@pytest.mark.parametrize(
    "n,stack",
    [(0, 0), (3000, 0), (9000, 0), (50, 1 << 20), (3000, 1 << 20), (9000, 1 << 20)],
)
def test_host_function_recursing_deep_inside_a_recursion(n, stack):
    # A host function called deep inside a recursion runs where the
    # evaluation has grown the stack. CPython's own guard must still turn its
    # runaway C recursion into RecursionError there, rather than the process
    # overflowing the stack. (n=0 on a 1MB thread is left out: there the call
    # is on the caller's own stack, where CPython 3.13 itself overflows.)
    proc = subprocess.run(
        [sys.executable, "-c", _HOST_RUNNER, str(n), str(stack)],
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert (
        proc.returncode == 0
    ), f"process crashed ({proc.returncode}): {proc.stderr[-2000:]}"
    assert proc.stdout.strip() == "RecursionError"
