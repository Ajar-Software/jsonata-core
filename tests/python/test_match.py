"""`$match` with a regex returns every match, as jsonata-js does (#194).

Expected values were produced by jsonata-js 2.2.2.
"""

import jsonatapy
import pytest


def ev(src, data=None):
    return jsonatapy.compile(src).evaluate({} if data is None else data)


def m(match, index, groups=()):
    return {"match": match, "index": index, "groups": list(groups)}


@pytest.mark.parametrize(
    "expr, expected",
    [
        # Every match, each with `groups` even when the regex has none.
        ('$match("aba", /a/)', [m("a", 0), m("a", 2)]),
        ('$match("aXbX", /x/i)', [m("X", 1), m("X", 3)]),
        # A single match surfaces as the object itself.
        ('$match("aba", /b/)', m("b", 1)),
        ('$match("aba", /z/)', None),
        # An unmatched optional group is null.
        ('$match("aba", /(a)(z)?/)', [m("a", 0, ["a", None]), m("a", 2, ["a", None])]),
        ('$match("abab", /(a)(b)/).groups', ["a", "b", "a", "b"]),
        # Limit: 0 gives nothing, and a fractional limit rounds up.
        ('$match("aba", /a/, 1)', m("a", 0)),
        ('$match("aba", /a/, 0)', None),
        ('$match("aba", /a/, 1.5)', [m("a", 0), m("a", 2)]),
        ('$match("aaa", /a/, 2)', [m("a", 0), m("a", 1)]),
        ('$count($match("aba", /a/))', 2),
        ('$match("aba", /a/)[1].index', 2),
        # A zero-length match is fine when the string is exhausted.
        ('$match("", /x*/)', m("", 0)),
        # `index` counts UTF-16 code units.
        ('$match("😀a", /a/)', m("a", 2)),
        ('$match("éé", /é/)', [m("é", 0), m("é", 1)]),
    ],
)
def test_match(expr, expected):
    assert ev(expr) == expected


@pytest.mark.parametrize(
    "expr",
    [
        '$match("aba", /x*/)',
        '$match("abc", /b*/)',
        '$match("ab", /a|/)',
        # jsonata-js looks up the next match before checking the limit.
        '$match("abc", /b*/, 1)',
    ],
)
def test_zero_length_match_after_first_is_d1004(expr):
    with pytest.raises(ValueError, match="D1004"):
        ev(expr)


def test_negative_limit_is_d3040():
    with pytest.raises(ValueError, match="D3040"):
        ev('$match("aba", /a/, -1)')
