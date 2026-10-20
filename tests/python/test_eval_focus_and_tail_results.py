"""
Regression tests for #247 and #250, on the default engine and the tree-walker.

#247: ``$eval(expr, focus)`` with an undefined focus evaluated ``expr`` against
undefined. jsonata-js's ``functionEval`` keeps the current input unless the
focus is defined, so ``$eval("a", $v)`` with ``$v`` unbound reads ``a`` from
the input.

#250: a builtin called in a function's tail position returns its raw result
in jsonata-js (its trampoline's ``applyInner``), never passed through the
generic unwrap of ``evaluate``. So an empty sequence such as ``$keys({})``
stays a value for ``$map``: ``$map([1,2], function($v){ $keys({}) })`` is
``[[], []]``. ``$split`` of undefined is undefined, not null, so
``$map([1,2], function($v){ $split(nothing, " ") })`` is undefined.

Every expected value below was checked against jsonata-js 2.x.
"""

import json

import jsonatapy
import pytest

UNDEFINED = object()

CASES = [
    # #247
    ('$eval("a", $v)', {"a": 5}, 5),
    ('$eval("a", nothing)', {"a": 5}, 5),
    ('$eval("$", $v)', [1, 2], [1, 2]),
    ('($x := 3; $eval("$x + a", $v))', {"a": 5}, 8),
    ('items.$eval("x", $u)', {"items": [{"x": 1}, {"x": 2}]}, [1, 2]),
    ('$eval("a", {"a": 7})', {"a": 5}, 7),
    # #250: a tail builtin's empty sequence is a value
    ("$map([1,2], function($v){ $keys({}) })", None, [[], []]),
    ("$map([1,2], function($v){ ($keys({})) })", None, [[], []]),
    ("$map([1,2], function($v){ $v>1 ? $keys({}) : 0 })", None, [0, []]),
    ("$map([1,2], function($v){ $keys(nothing) })", None, [[], []]),
    ('$map([1,2], function($v){ $keys({"a":1}) })', None, [["a"], ["a"]]),
    ('$map([1,2], function($v){ $lookup([{}], "x") })', None, [[], []]),
    ('$each({"a":1,"b":2}, function($v){ $keys({}) })', None, [[], []]),
    ("$count($map([1,2], function($v){ $keys({}) }))", None, 2),
    ("$sort([2,1], function($a,$b){ $keys({}) })", None, [1, 2]),
    ("$sort([2,1], function($a,$b){ {} })", None, [1, 2]),
    # a direct call still unwraps
    ("(function(){ $keys({}) })()", None, UNDEFINED),
    ("[(function(){ $keys({}) })()]", None, []),
    # #250: undefined, not null
    ('$map([1,2], function($v){ $split(nothing, " ") })', None, UNDEFINED),
    ('[$split(nothing, " ")]', None, []),
    ("$map([1,2], function($v){ $sift(nothing, function(){true}) })", None, UNDEFINED),
    ("$map([1,2,3], function($v){ $v>1 ? $string($v) })", None, ["2", "3"]),
    # a builtin in tail position runs with jsonata-js's apply input: null
    # for a callback, the call site's input for a direct call
    ('$map(["a"], function($e){ $eval($e, $nope) })', {"a": 5}, UNDEFINED),
    ('$map(["a"], function($e){ $eval("a") })', {"a": 5}, UNDEFINED),
    ('$map(["a"], function($e){ $string() })', {"a": 5}, "null"),
    ('"x" ~> function($e){ $eval("a") }', {"a": 5}, UNDEFINED),
    ('($f := function($e){ $eval("a") }; $f("x"))', {"a": 5}, 5),
    ('($f := function(){ $eval("a") }; {"a":7}.$f())', {"a": 5}, 7),
    ('$map(["a"], function($e){ $sum([$eval("a")]) })', {"a": 5}, 5),
    # a tail-position builtin applies its functions with their own input;
    # a function passed to a direct call is applied with a null input
    ('($o := function(){ $map([1], function(){ $eval("a") }) }; $o())', {"a": 5}, 5),
    ('($o := function(){ $filter([1], function(){ $eval("a") }) }; $o())', {"a": 5}, 1),
    (
        'b.($g := function($x){ $eval("a") }; $o := function(){ $map([1], $g) }; $o())',
        {"a": 5, "b": {"a": 7}},
        7,
    ),
    ('($g := function($x){ $eval("a") }; $map([1], $g))', {"a": 5}, UNDEFINED),
    (
        '($o := function($f){ $map([1], $f) }; $o(function(){ $eval("a") }))',
        {"a": 5},
        UNDEFINED,
    ),
    (
        '($h := function($f){ $f("x") }; $h(function($e){ $eval("a", $nope) }))',
        {"a": 5},
        UNDEFINED,
    ),
]


@pytest.fixture(params=["vm", "tree-walker"])
def engine(request):
    previous = jsonatapy._get_force_tree_walker()
    jsonatapy._set_force_tree_walker(request.param == "tree-walker")
    yield request.param
    jsonatapy._set_force_tree_walker(previous)


@pytest.mark.parametrize("expr,data,expected", CASES)
def test_matches_jsonata_js(engine, expr, data, expected):
    result = jsonatapy.compile(expr).evaluate(data)
    if expected is UNDEFINED:
        assert result is None
    else:
        assert result == expected


@pytest.mark.parametrize("expr,data,expected", CASES)
def test_json_api_matches_jsonata_js(engine, expr, data, expected):
    out = jsonatapy.compile(expr).evaluate_json(json.dumps(data))
    if expected is UNDEFINED:
        assert out in (None, "null", "undefined", "")
    else:
        assert json.loads(out) == expected
