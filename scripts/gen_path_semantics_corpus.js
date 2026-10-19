// Generates the path-semantics differential corpus (issue #184, step 3).
//
// jsonata-js decides when a result is unwrapped from a one-item sequence and
// when nested results are flattened using two rules: the last-step rule in
// evaluateStep, and the generic unwrap at the end of evaluate. This corpus
// crosses paths over data shaped to tell those rules apart (fields holding
// single-item arrays, nested arrays, arrays of objects, empty arrays) with
// the contexts a path appears in (blocks, constructors, variables, function
// arguments, map stages). Expected values come from the pinned jsonata-js in
// tests/jsonata-js; tests/path_semantics_test.rs compares both engines.
//
// Cases marked `root` run on ROOT_DATA, a top-level array, instead of DATA.
// Each case's result is the jsonata-js value, with undefined written as
// {"$undefined": true} and an error as {"$error": "<code>"}.
//
// Usage: node scripts/gen_path_semantics_corpus.js
// Writes: tests/fixtures/path_semantics_differential.json and
//         tests/fixtures/path_semantics_combinations.json (over DATA)

const fs = require('fs');
const path = require('path');
const jsonata = require(path.join(__dirname, '..', 'tests', 'jsonata-js', 'src', 'jsonata.js'));
const refVersion = require(path.join(__dirname, '..', 'tests', 'jsonata-js', 'package.json')).version;

const DATA = {
  a: [{ b: [1] }],
  o: [{ t: ['x'] }, { t: ['y', 'z'] }],
  n: [[1, 2], [3]],
  nn: [[[1]]],
  one: { z: [7] },
  e: [],
  m: { k: { b: [[1]] } },
  x: { y: [1] },
  arr: [1, 2, 3],
  objs: [{ p: 1 }, { p: 2 }],
  obj1: [{ p: 1 }],
  v: 5,
  het: [{ a: 1, b: 5 }, { b: 0, a: 4 }],
  acct: { Order: [{ id: 'o1', P: [{ N: 'A' }, { N: 'B' }] }, { id: 'o2', P: [{ N: 'C' }] }] },
};

const PATHS = [
  'a', 'a.b', 'a[0].b', 'o', 'o.t', 'o.t[0]', 'o[0].t', 'o[1].t', 'o.(t)',
  'n', 'n.$', 'n[0]', 'nn', 'nn.$', 'one.z', 'one.*', 'm.k.b', 'x.y', 'x.(y)',
  'arr', 'arr.$', 'arr[0]', 'objs', 'objs.p', 'objs.$', 'obj1', 'obj1.p',
  'obj1.$', 'e', 'e.x', 'v', 'nope',
];

const WRAPPERS = [
  (p) => p,
  (p) => `(${p})`,
  (p) => `${p}[]`,
  (p) => `[${p}]`,
  (p) => `$count(${p})`,
  (p) => `$exists(${p})`,
  (p) => `($v := ${p}; $v)`,
  (p) => `($v := ${p}; $v[])`,
  (p) => `[1].($$.${p})`,
  (p) => `[1, 2].($$.${p})`,
  (p) => `{"r": ${p}}`,
  (p) => `$map([1], function($i) { $$.${p} })`,
  (p) => `$type(${p})`,
  (p) => `${p}.$`,
  (p) => `${p}.[$]`,
  (p) => `$append(${p}, [])`,
  (p) => `[${p}][0]`,
  (p) => `true ? ${p} : 0`,
  (p) => `${p} ~> $append([])`,
];

// Verbatim cases from issue #184's table and PR #182's description.
const EXTRA = [
  "[{'a':[1]}].a",
  "[{'a':[1]}].(a)",
  "[{'a':[[1]]}].(a)",
  "[{'a':[[1]]}].a",
  "[1].({'a':[1]}.a)",
  "[{'a':{'b':[[1]]}}].(a.b)",
  "($o := {'a':[[1]]}; [1].($o.a))",
  "($r := [{'b':1}]; $r.($))",
  "($r := [{'b':1}]; $r.($v := 1; $v))",
  "($r := [{'b':1}]; $r.({'b': $.b}))",
  "($ids := [{'k':'a'},{'k':'b'}]; [1,2].($b := $; $ids.({'b': $b, 'k': $.k})))",
  "([1,2]).(([9,8]))",
  "($x := [1,2]; $x.($v := [$]; $v))",
  "($x := [[1,2],[3]]; $x.($))",
  "($r := [{'b':1}]; $r.([$]))",
  "([1]).(([9]))",
  "($ids := [{'k':'a'}]; [1].($b := $; $ids.({'b': $b})))",
  "($r := [{'b':1}]; $r.($)[])",
  // Sorts, index binding, filters and constructors over the same shapes.
  'arr^($)', 'arr^(>$)', 'objs^(>p).p', 'arr#$i.$i', 'objs#$i[$i=0].p',
  'arr[$ > 1]', 'arr[$ > 2]', 'objs[p > 1]', 'obj1[p > 0]', 'o[t = "x"].t',
  'o.t[$ = "y"]', 'n[0][1]', 'n.$[0]', '[arr]', '[[arr]]', '[arr, arr]',
  '[arr][]', 'arr.[$]', 'objs.[p]', 'obj1.[p]', 'objs.{"q": p}', 'obj1.{"q": p}',
  'o{"k": t}', 'objs{"k": p}', '$map(arr, function($v) { [$v] })',
  '$map(o, function($v) { $v.t })', '$filter(o, function($v) { true }).t',
  '$lookup(o, "t")', '$lookup(objs, "p")', '$lookup(obj1, "p")', '$keys(objs)',
  '$spread(objs)', '$distinct(o.t)', '$reverse(o.t)', '$string(o.t)',
  'o.t ~> $count', '$sum(n)', '$sum(n.$)', '$max(objs.p)', '*', 'one.*', 'm.*',
  'm.*.b', '**.p', 'o.**', 'a.**', '$.a', '$.o.t', '$$.a.b',
  // Paths inside lambda bodies, which compile separately.
  '($f := function() { objs.p }; $f())', '($f := function() { o.t }; $f())',
  '($f := function() { a.b }; $f())', '$map([1], function($v) { $.objs.p })',
  '$map([1], function($v) { objs.p })', '$map([1], function($v) { o.t[0] })',
  // `[]` ahead of a context binding, and an index binding on a sort.
  'arr[]@$v.$v', 'objs[]@$o.$o.p', 'arr^($)#$i', 'arr^($)[0]#$i',
  'arr^($)#$i.$i', 'arr^(>$)#$i.{"v": $, "i": $i}', 'objs^(>p)#$i', 'objs^(>p)#$i.p',
  'objs^(>p)#$i.{"p": p, "i": $i}', 'objs#$j^(>p)#$i.{"j": $j, "i": $i}', 'arr^($)[$ > 1]#$i.{"v": $, "i": $i}',
  // `$eval` wraps an array context the way evaluate wraps its input.
  '$eval("t", o)', '$eval("t[0]", o)', '$eval("$.t[0]", o)', '$eval("n[0]", $)',
  '$eval("p", objs)', '$eval("$[0]", arr)',
  // Objects whose keys are in different orders.
  'het[a > 2].b', 'het.{"k": a}', '$map([1], function($v) { het[a > 2].b })',
  '($f := function() { het[a > 2].b }; $f())', '$map(het, function($v) { $v.a })',
  // Object constructors over arrays group their items.
  'n.{"x": $}', 'het.[a].{"x": $}', 'o.t.{"x": $}', '[[1, 2], [3]].{"x": $}', 'n{"x": $}',
  'het.{"k": $string(a)}.k', '$.{"x": het.a}', '[$].{"x": v}',
  // Keys that are null or repeated.
  '{null: 1}', 'objs.{(p = 1 ? null : "k"): p}', '{"a": 1, "a": 2}', 'objs.{"a": p, "a": 2}',
  '{"a": 1, "b": 2, "a": nope}', 'false ? {"a": 1, "a": 2} : 0', 'objs{"a": p, "a": 1}',
  // A builtin shadowed by a binding, over several items.
  '($string := function($x) { "z" }; objs.{"r": $string(p)})',
  '($sum := function($x) { 0 }; objs.($sum(p)))', '($k := 2; objs.{"r": p * $k})',
  // Tuple-producing paths inside a sort with an index.
  'objs^(>p)#$i[$i = 0].p', '(o.(t#$k[$k = 0]))^($)#$i.{"v": $, "i": $i}',
  'o^(>t#$k[$k = 0])#$i.{"i": $i}', 'o.{"r": t#$k[$k = 0]}^(>r)#$i.{"r": r, "i": $i}',
  // A sort or group-by keeps tuples only from a tuple path it sorts directly.
  '$keys(objs#$i)^($)', '$string(objs#$i)^($)', '$string(objs#$i){"k": $}',
  '(objs#$i)^(>p).{"i": $i}', '($a := objs#$i; $a)^(>p).{"i": $i}', '(objs#$i){"k": $i}',
  '[objs#$i]{"k": $i}', 'objs#$i.($string(objs#$z))', 'objs#$i^(>p).{"i": $i}',
  'objs#$i{"k": $i}', 'o.(t.%)', 'o.t.{"p": %.t}', 'o.t.(%.%)', 'o.(t.(%))',
  // `%` resolved through a block, in a sort term or a later step.
  '(acct.Order.P)^(>%.id).N', 'acct.Order.(P)^(>%.id).N', 'acct.(Order.P)^(>%.id).N',
  '($x := 1; acct.Order.P)^(>%.id).N', 'acct.Order.(P).{"n": N, "o": %.id}',
  'acct.Order#$k.(P#$i.%).{"i": $i, "k": $k}', 'o#$i.(t#$i.%).{"i": $i}',
  'acct.Order.P{%.id: N}', 'acct.Order.(P)#$i.{"n": N, "i": $i, "o": %.id}',
  // A `%` in a group-by's key or value is never resolved, so it is undefined
  // there; a `%` it can't reach is still S0217 (#192).
  'acct.Order.P{N: %.id}', 'acct.Order.P{"k": %.id}', 'acct.Order.P{"k": %}',
  'acct.Order.P{N: %.%.Order.id}', 'acct.Order.P{N: $count(%)}', 'acct.Order.P{N: [%.id]}',
  'acct.Order.P{N: N & %.id}', 'acct.Order.P{N: (%.id)}', 'acct.Order.P{N: P.%}',
  'acct.Order.P[%.id = "o1"]{N: %.id}', 'acct.Order@$o.P{N: %.id}', 'acct.Order.P#$i{N: %}',
  'acct.Order.P^(N){N: %.id}', 'acct.Order{id: P{N: %}}', 'acct.Order.(P{N: %.id})',
  'acct.Order.P.%{id: %}', 'acct.Order.P{N: $.%}', '%', 'acct.Order.P.{N: %.id}',
  // A `%` after a group-by seeks through the grouped path.
  '(acct.Order.P{N: N}).%', 'acct.Order.(P{N: N}).%.id', '(acct.Order.P{N: N}).%.Order',
  '(acct.Order{id: P}).%', 'acct.(Order{id: P}).%', '(acct.Order.P{N: %.id}).%',
  'acct.Order.P{N: (1).%}', '(acct.Order.P{N: N})^(%.id).A', 'acct.(Order.P{N: N}).%.Order',
  // A group-by on a path groups the whole path: later steps, filters, sorts
  // and binds extend the path first (#208). On a block, `$x` or `*` the
  // group stays on that step, and `[]` after it isn't a predicate.
  'acct.Order.P{N: N}.A', 'acct.Order.P{N: N}.Z', 'acct.Order.P{N: nope}.A', 'acct.Order.P{N: N}.%',
  'acct.Order.P{N: N}[%.id="o1"]', 'acct.Order.P{N: N}[0]', 'acct.Order.P{N: N}[0].N',
  'acct{"a": 1}.Order', 'acct.Order{"a": 1}[0]', 'acct.Order{id: id}.P{N: N}', 'acct.Order{"k": id}@$o.P',
  'acct.Order{"k": id}#$i.P', 'acct.Order@$o.P{N: $o.id}.N', '(acct.Order.P{N: N}).A',
  '(objs){"k": p}.k', '(objs){"k": p}[].k', '(objs){"k": p}[]', '(objs){"k": p}[][0]', '(objs){"k": p}[0]',
  '(objs)[0]{"k": p}[]', '[(objs){"k": p}[]]', '$x{"k": 1}[].k', '$x{"a": 1}[0]', '[1, 2, 3]{"num": $}[true]',
  'acct.Order.P{N: N}.$uppercase(N)', 'acct.Order{"k": id}.P.$string()', 'acct.Order{"k": id}.$count(P)',
  'acct.Order.P{N: N}.function($x) { $x }(1)', 'acct{"a": 1}(1)', 'acct^(x)[0]{"k": 1}[0]',
  '(acct.Order)#$i[0]{"k": id}[0]', 'acct^(id)[0]{"k": 1}.Order', 'acct.Order@$o[id = "zz"]{"k": 1}.id',
  'acct.Order^(id)[0]{"k": id}.P', '(objs){"k": p}[]{"j": 1}', '*{"a": 1}[]{"b": 1}',
  '(objs){"k": p}[][]{"j": 1}', '($x := objs; $x{"k": p}#$i[0])', '($x := objs; $x{"k": p}@$v[0])',
  '($x := objs; $x{"k": p}#$i{"j": 1})', '($x := objs; $x{"k": p}@$v{"j": 1})',
  // A `%` seeks through a group-by on a bare `*` or `%` (#209). As a step
  // the `*` is the ancestor; inside a block nothing binds it.
  'acct.(*{"k": 1}).%', 'acct.Order.(*{"k": N}).%', 'acct.Order.P.(%{"x": id}).%', '*{N: N}.%',
  '*{N: N}.%.id', 'acct.*{"k": 1}.%', 'acct.Order.P.%{"x": id}.%', 'acct.(*).%', 'acct.Order.P.(%).%',
  'acct.Order.P.(%).%.id', 'acct.Order.(*).%.%', '(acct.Order.P.(%{"x": id})).%',
  // A group-by over an empty tuple stream makes no group (#215).
  'acct.Order[%.id = "o1"]{"k": 1}', 'acct.Order.P[%.id = "zz"]{"k": 1}',
  'acct.Order[id = "zz"]{"k": $count($)}', 'nope{"k": $count($)}', 'objs#$i[$i > 5]{"k": 1}',
  '(acct.Order.P[%.id = "zz"]){"k": 1}', '$x@$y{"k": 1}', '[1, 2]@$y[$y > 5]{"k": 1}', '$x#$y{"k": 1}',
  'acct.Order@$o[id = "zz"]^(id){"k": 1}', 'acct.Order#$i[$i > 5]^(id){"k": 1}',
  'acct.Order[%.id = "zz"]^(id){"k": 1}', 'acct.Order[id = "zz"]^(id){"k": 1}',
  // A sort over a block's tuple stream unwraps a single or empty result
  // (#207).
  '(acct.Order.P[N="C"])^(%.id)', 'acct.Order.(P[N="C"])^(%.id)', '(acct.Order[0].P[0])^(%.id)',
  'acct.Order.P[N="C"]^(%.id)', '(acct.Order.P[N="C"])^(N)', '(acct.Order.P[N="C"])^(%.id).N',
  '(acct.Order.P)[N = "Z"]^(>%.id)', '(o.t)[N = "C"]^(>%.id)',
  // A sort of a tuple stream returns its tuples unmarked, so a filter, sort
  // or group-by right after it sees each tuple as an object (#214).
  'acct.Order.P^(>%.id)[N = "C"]', 'acct.Order.P^(>%.id)^(N)', 'acct.Order.P^(>%.id){N: N}',
  'o.t^(>%.id)^($)', 'acct.Order.P^(>%.id)[0].N', 'acct.Order.P^(>%.id)[N = "C"].N',
  'acct.Order.P^(>%.id)[$i = 0]', 'acct.Order#$i.P^(N)[N = "C"]', 'acct.Order#$i.P^(N)^(>N)',
  'acct.Order.P#$i^(N){N: N}', 'acct.Order@$o.P^(N)[N = "C"]', 'arr^($)#$i[$i > 0]',
  'acct.Order.P^(>%.id)[0]^(N)', 'acct.Order.P^(>%.id)[$count($.\'@\') > 0]',
  'acct.Order.P^(>%.id)[$count($.\'@\') > 0]{N: N}', 'acct.Order.P^(>%.id)[0]{N: N}',
  'acct.Order.P^(>%.id)[true]{N: N}', 'acct.Order.P^(>%.id)[[0, 1]]{N: N}',
  'acct.Order.P^(>%.id)[N = "C"]^(N)',
  'acct.Order.P[N = "C"][]^(%.id)[N = "C"]', 'acct.Order.P[N = "C"][]^(%.id){N: N}',
  'acct.Order.P[N = "C"][]^(%.id)^(N)', 'acct.Order.P^(>%.id)^(N)#$k.$k', 'acct.Order.P^(>%.id)^(N)#$k[$k = 0]',
  'acct.Order.P^(>%.id)[N = "C"]#$k', 'acct.Order.P^(>%.id)[N = "C"]#$k.{"k": $k, "v": $}',
  'acct.Order.P^(>%.id)#$k[N = "C"]', 'acct.Order.P^(>%.id)#$k[$k = 1]', 'acct.Order.P^(>%.id)#$k.{"k": $k}',
  'acct.Order.P[N = "C"]^(%.id)#$k[N = "C"]',
  // A one-item sort keeps its mark through a filter, and `#` after a sort keeps it.
  'acct.Order.P[N = "C"]^(%.id)[N = "C"]{N: N}', 'acct.Order.P[N = "C"]^(%.id)[0]{N: N}',
  'acct.Order.P[N = "C"]^(%.id)[true]{N: N}', 'acct.Order.P[N = "C"]^(%.id)[]{N: N}',
  'acct.Order[1].P^(%.id)[0]{N: N}', 'acct.Order#$i.P[N = "C"]^($i)[0]{N: N}',
  'acct.Order.P^(>%.id)#$k{N: N}', 'acct.Order.P^(>%.id)#$k^(N)', 'acct.Order.P^(>%.id)#$k^(N).N',
  'acct.Order.P^(>%.id)#$k[$k > 0].N',
  // After a sort, a tuple's `#$i` or `@$v` binding reads as a field named `i` or `v`.
  'acct.Order.P#$i^(>$i){"k": $keys($)}', 'acct.Order.P#$i^(>$i)[i = 1]', 'acct.Order.P#$i^(>$i)[$.i = 0]',
  'acct.Order.P#$i^(>$i){"x": $sum(i)}', 'acct.Order.P#$i^(>$i)^(i).N', 'acct.Order.P@$p^(>$p.N){"k": $keys($)}',
  'acct.Order.P@$p^(>$p.N){p.N: N}', 'acct.Order.P@$p^(>$p.N)[p.N = "B"].N', 'acct.Order.P#$i^(>$i)[$i = 1].N',
  'acct.Order.P#$i^(>$i)#$j[i = 0].{"j": $j}',
  // Outside a path, as a value, a sort of a tuple stream gives values.
  '($x := acct.Order.P^(>%.id); $x[N = "C"])', '(acct.Order.P^(>%.id))[N = "C"]',
  '(true ? acct.Order.P^(>%.id) : 0)[N = "C"]', '{"a": acct.Order.P^(>%.id)}.a[N = "C"]',
  '(acct.Order.P^(>%.id)){N: N}', '($x := acct.Order.P^(>%.id); $x{N: N})', '(acct.Order.P^(>%.id))^(N)',
  '$string(acct.Order.P^(>%.id))', 'acct.Order.P^(>%.id) ~> $sort(function($a, $b) { $a.N < $b.N })',
  // Outside a path, `@` on a block, `*` or `$` binds nothing, and a `%` filter on one raises
  // S0217 (#211, #213). A sort or `#` makes it a path, and `#` keeps no `[]` before it.
  '(acct.Order.P)@$v^($v.N)', '(acct.Order.P)@$v.$v.N', '(acct.Order.P)[%.id = "o1"].N',
  '(acct.Order.P)[%.id = "o1"]^(N)', '(acct.Order.P)[%.id = "o1"]#$i', '[(acct.Order.P)[%.id = "o1"]]',
  '{"a": (acct.Order.P)[%.id = "o1"]}', '$x := (acct.Order.P)[%.id = "o1"]', 'acct.*[%.id = "o1"]',
  '(acct.Order.P)[]#$i', '(o.t)[]#$i', '(o.t)#$i[]', '(acct.Order.P)@$v#$i', '(acct.Order.P)#$i@$v',
  '(acct.Order.P)@$v#$i.$v.N', '(acct.Order.P)#$i.{"i": $i}',
  '*@$v[0]', '($x := objs; $x{"k": p}@$v)', '(objs){"k": p}[]#$i', '(objs){"k": p}#$i', '$x{"k": 1}@$v',
  // `~>` passes no `%` slot on; a sort keeps a filtered group-by's slot; `@` after a filtered
  // group-by is S0215.
  '(acct.Order.P)[%.id = "o1"] ~> $count', '%.id ~> $count', '$count(%.id)', 'acct.Order.(%.id ~> $count)',
  '(acct.Order.P)[%.id = "o1"]{N: N}^(N)', '((acct.Order.P)[%.id = "o1"])[0]', '[(acct.Order.P)[%.id = "o1"]][0]',
  '(acct.Order.P)[%.id = "o1"]{N: N}@$v', 'acct.Order.P[0]{N: N}@$v', 'acct.Order.P{N: N}@$v',
  '(objs)@$v{"k": p}', '(objs)@$v{"k": $v.p}', '(objs)@$v{"k": p}.k', '(objs)@$v{"k": p}.{"x": k}',
  '(objs)@$v[0]{"k": p}.k',
  // `$match` returns every match as a sequence (#194).
  '$match("aba", /a/)', '$match("aba", /a/, 1)', '$match("aba", /a/, 0)', '$match("aba", /z/)',
  '$match("xay", /a/)', '$match("ab", /(a)(c)?/)', '$match("abc", /x*/)', '$match("abc", /x*/, 1)',
  '$match("", /x*/)', '$match("ab", /a|/)', '$match("aBa", /b/i)', '$match("aba", /a/, -1)',
  '$match(nope, /a/)', '$match("aba", /a/)[1].index', '[$match("a", /a/)]',
  '$count($match("aba", /a/))', '$match("a1b22", /\\d+/).match', '$match("éa😀a", /a/)',
  '$match("aaa", /^a/)', '$match("a\\nb", /^\\w/m)', '$match("ab", /(?<x>a)/)',
  'o.t.$match($, /[a-z]/)', '$match(o.t[0], /x/).groups',
  '$exists($match("ab", /(a)(c)?/).groups[1])', '$count($match("ab", /(a)(c)?/).groups)',
  // A fractional limit rounds up: jsonata-js loops while count < limit.
  '$match("aba", /a/, 1.5)', '$match("aba", /a/, 0.5)', '$replace("aaa", "a", "b", 1.5)',
  '$replace("aaa", /a/, "b", 0.5)', '$replace("aaa", /a/, function($m) { "x" }, 1.5)',
  '$replace("aaa", "a", "b", -1)',
  // Custom matchers go through jsonata-js's evaluateMatcher checks.
  '$match("abc", function($s) { "str" })', '$match("abc", function($s) { {"match": "x"} })',
  '$match("abc", function($s) { {"end": 1} })', '$match("abc", function($s) { $error("boom") }, 0)',
  '$match("abc", function($s) { undefined })',
  '$match("abc", function($s) { {"match": "x", "start": 0, "groups": [], "next": function() { "str" }} })',
  '$match("abc", function($s) { {"match": "x", "start": 0, "groups": [], "next": function() { {"foo": 1} }} })',
  '$match("abc", function($s) { {"match": "x", "start": 0, "groups": [], "next": function() { undefined }} })',
  '$match("abc", function($s) { {"match": "x", "start": 0, "groups": [], "next": function() { "str" }} }, 1)',
  '($o := {"f": function($s) { {"match": "b", "start": 1, "groups": [], "next": function() { undefined }} }}; $match("abc", $o.f))',
  // $replace drives a regex or a custom matcher as $match does (#198):
  // `start` counts UTF-16 code units, a later zero-length match is D1004
  // (even past the limit), and a replacement function gets the match object.
  '$replace("éab", /a/, function($m) { $string($m.start) })',
  '$replace("éaéaéa", /a/, function($m) { $string($m.start) })',
  '$replace("éaéaéa", /a/, function($m) { $string($m.start) }, 2)',
  '$replace("😀a😀a", /a/, function($m) { $string($m.start) & "/" & $string($m.end) })',
  '$replace("éa1éb2", /([a-z])(\\d)/, function($m) { $string($m.start) & $m.groups[1] & $m.groups[0] })',
  '$replace("abc", /(b)(x)?/, function($m) { $string($count($m.groups)) })',
  '$replace("abc", /(b)(x)?/, function($m) { $string($m.groups) })',
  '$replace("abc", /b/, function($m) { $m.match & "!" }, 5)', '$replace("abc", /b/, function($m) { "x" }, 0)',
  '$replace("abc", /b/, function($m) { 5 })', '$replace("a1b2", /(\\d)/, "<$1>")',
  '$replace("abc", /x*/, function($m) { "-" })', '$replace("abc", /x*/, "-")', '$replace("abc", /x*/, "-", 0)',
  '$replace("abc", /a|x*/, "-", 1)', '$replace("abc", /a|x*/, function($m) { "-" }, 1)',
  '$replace("abc", /x*$/, "-")', '$replace("abc", /x*$/, function($m) { "-" })', '$replace("", /x*/, "-")',
  '$replace("aba", /a|x*$/, "-")', '$replace("aba", /a|x*$/, function($m) { "-" }, 1)',
  '$replace("abc", function($s) { {"match": "b", "start": 1, "groups": [], "next": function() { undefined }} }, "x")',
  '$replace("abc", function($s) { {"match": "b", "start": 1, "groups": [], "next": function() { undefined }} }, "x", 0)',
  '$replace("abc", function($s) { {"match": "b", "start": 1, "groups": [], "next": function() { undefined }} }, function($m) { $string($keys($m)) })',
  '$replace("abc", function($s) { {"match": "b", "start": 1, "groups": [], "next": function() { undefined }} }, function($m) { 5 })',
  '$replace("abc", function($s) { {"match": "b", "start": 1, "groups": [], "next": function() { 5 }} }, "x")',
  '$replace("abc", function($s) { 5 }, "x")', '$replace("abc", function($s) { undefined }, "x")',
  '$replace("é😀b", function($s) { {"match": "b", "start": 3, "groups": ["g"], "next": function() { undefined }} }, "<$0$1>")',
  '$replace("abcabc", function($s) { {"match": "b", "start": 1, "groups": [], "next": function() { {"match": "c", "start": 5, "groups": [], "next": function() { undefined }} }} }, "X")',
  '$replace("abcabc", function($s) { {"match": "b", "start": 1, "groups": [], "next": function() { {"match": "c", "start": 5, "groups": [], "next": function() { undefined }} }} }, "X", 1)',
  // A custom matcher's groups and start are converted as JavaScript does.
  ...['1', 'null', 'true', '1.5', '1e21', '1e-7', '-0', '[1, 2]', '[]', '[null, "x", [3]]', '{"a": 1}',
    '$sum', 'nope'].map((g) =>
    `$replace("abc", function($s) { {"match": "b", "start": 1, "groups": [${g}], "next": function() { undefined }} }, "[$1]")`),
  ...['"1"', '" 2 "', '"z"', 'true', 'null', '"0x2"', '""', '[2]', '"1e0"', 'nope'].map((st) =>
    `$replace("abc", function($s) { {"match": "b", "start": ${st}, "groups": [], "next": function() { undefined }} }, "x")`),
  // A replacement string's `$n` is read with parseInt, up to the digits the group count has.
  ...['[$01]', '[$-1]', '[$ 1]', '[$$1]', '[$]', '[$a]', '[$1$2]', '[$1é]', '$'].map((r) =>
    `$replace("abc", /(b)/, "${r}")`),
  ...['$10', '$11', '$1x', '$010', '$100'].map((r) =>
    `$replace("abcdefghijk", /(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)/, "${r}")`),
  // Only the groups `$n` refers to are converted to strings.
  ...['plain', '[$0]', '[$2]', '[$1]'].map((r) =>
    `$replace("abcd", function($s) { {"match": "b", "start": 1, "groups": [{"a": 1}, "x"], "next": function() { () }} }, "${r}")`),
  // parseInt and Number skip JavaScript's whitespace, which has U+FEFF but not U+0085.
  ...['\u000b', '﻿', ' ', ' ', '　', '\u0085', '\t'].map((ws) =>
    `$replace("abcdefghijkl", /(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)/, "$${ws}1|")`),
  ...['\u0085', '﻿', ' ', '\u000b', ' '].map((ws) =>
    `$replace("abcd", function($s) { {"match": "b", "start": "${ws}1", "groups": [], "next": function() { () }} }, "-")`),
  // `a ?? b` is `$exists(a) ? a : b` (#195): errors on the left propagate.
  '$error("x") ?? 1', '(($x := 5; $error("e")) ?? $x)', 'nope.(1/0) ?? 2', '$string(nope) ?? 1',
  '(nope) ?? 2', '$lookup({}, "a") ?? 3', 'null ?? 4', '[nope][0] ?? 5', 'false ?? 6', '0 ?? 7',
  '"" ?? 8', '[] ?? 9', 'nope ?? nope2 ?? 10', 'e.x ?? v', 'a.b ?? 0', 'arr[$ > 5] ?? "none"',
  // A builtin's arguments are all evaluated, so their errors surface.
  '$substring($nope, $error("e"))', '$string($nope, $error("e"))', '$substring($nope, "x")',
  '{"x": $string($nope)}', '$type($not($nope))', '$string(objs.(p).q)',
  // A `.(...)` block's `:=` bindings stay in the block.
  '(arr.($z := 3); $z)', 'arr.($z := $; $z * 2)', '($y := 1; arr.($y := 5); $y)',
  // A `.$fn(...)` step is not a block, so its argument's `:=` binds outside.
  '($r := arr.$string($x := $); $x)', '(one.$string($x := z); $x)', '($r := arr.$sum([$x := $]); $x)',
  'arr.(1; 2)', 'arr.()',
  // Recursion through a `.(...)` step.
  '($f := function($n) { $n <= 0 ? 0 : [$n].($f($n - 1)) + 1 }; $f(40))',
  // `~>` passes an undefined left side on to the function (#193).
  'nope ~> $count()', 'nope ~> $exists()', 'nope ~> $count', 'nope ~> $single()',
  'nope ~> $single(function($v) { true })', '$single(null, function($v) { false })',
  'nope ~> function($v) { $exists($v) }', 'nope ~> $substring(?, 1)', 'nope ~> |x|{"a": 1}|',
  '($t := |x|{"a": 1}|; $t(nope))', '($t := |x|{"a": 1}|; $t(5))', '5 ~> |x|{"a": 1}|',
  'nope ~> /a/', 'nope ~> $sum ~> $string', 'arr ~> $append(nope)',
  // A right side that is not a call is evaluated, and must be a function.
  'arr ~> ($sum ~> $string)', '$type($sum ~> $string)', '($f := $sum ~> $string; arr ~> $f)',
  '($c := $sum ~> $string ~> $length; $c(arr))', '"abc" ~> ($substring(?, 1) ~> $uppercase)',
  '"abc" ~> $substring(?, ?)', '5 ~> nope', '5 ~> "x"', 'arr ~> $f.g', 'arr ~> $sum[0]',
  'arr ~> $map(function($v) { $v * 2 })[0]', 'arr ~> $map(function($v) { $v * 2 })[]',
  '($n := 0; $f := function($v) { $v }; ($n := $n + 1; arr) ~> $f; $n)',
  'nope ~> /n/', 'arr ~> function($v) { $count($v) }', '$sum ~> function($v) { $v + 1 }',
  // A transform is a function value that runs only when invoked, and `$` in
  // its update is the matched object.
  'm ~> |k|{"w": $keys($)}|', 'x ~> |$|{"w": $keys($)}|', 'm ~> |k|{"c": x ~> |$|{"d": 1}|}|',
  'm ~> |k|{"c": $$.x ~> |$|{"d": 1}|}|',
  'objs.(|$|{"q": 1}|) ~> $type()', '[1].($ ~> |x|{}|)',
  '($t := |$|{"w": 1}|; $f := function($v) { $t($v) }; $f(x))',
  '($mk := function($n) { |$|{"w": $n}| }; $t := $mk(5); x ~> $t)', '$map([x], |$|{"w": 1}|)',
  '($t := |$|{"w": $v}|; $f := function($v) { $t(x) }; $f(1))',
  // The delete clause is evaluated per matched object, with `$` bound to it.
  'm ~> |k|{}, $keys($)|', 'het ~> |$|{}, $keys($)[0]|', 'm ~> |k|{}, ["b", 1]|', 'm ~> |k|{}, null|',
  'm ~> |k|{}, nope|', '($t := |k|{"x": 1}|; $t(m, 2))',
  // A builtin applied by value runs as a direct call does.
  '[3, 1, 2] ~> $sort', 'arr ~> $sort ~> $reverse', '[3] ~> $single', '($f := $sort; $f([2, 1]))',
  '$map([1, 2], $sort)', '$map(n, $sum ~> $string)', '$filter(n, $count ~> function($c) { $c > 1 })',
  '($f := function($v) { $exists($x) }; arr ~> ($sum ~> $f))',
  '(function($sort) { $sort([3, 1, 2]) })($sort)',
  '($s := $sort; $sort := function($x) { "user" }; $s([3, 1, 2]))',
  '($sort := nope; $exists($sort))', '$exists($sort)', '($sort := null; $exists($sort))',
  // A parameter without an argument is undefined.
  '(function($sort) { $exists($sort) })()', '($f := function($v) { $type($v) }; $f())',
  '($f := function($v, $w) { [$v, $w] }; $f(1))',
  '($f := function($n, $acc) { $n = 0 ? $type($acc) : $f($n - 1) }; $f(3))',
  // `$$` is the variable named `$`, so `$$arr` is the (unbound) variable
  // `$arr`, not a field of the input (#201).
  '$$arr', '$string($$arr)', '$string($$missing)', '$exists($$arr)', '{"x": $$arr}',
  '$$arr[0]', '$$v.w', 'arr.$$v', '$$$', '($arr := 5; $$arr)', '($b := $$v; $b)',
  '($$x := 2; $$x * 3)', '$$', '$$.arr', '$$.x.y',
  // A lambda called as a path step gets exactly the arguments written; the
  // context item is not passed as an implicit first argument (#202).
  'arr.function($v) { $v * 2 }()', 'arr.function($v) { $v * 2 }(3)',
  'arr.function($v) { $v * 2 }($)', 'arr.function() { $ * 2 }()',
  'arr.function($v, $w) { $v + $w }(1)', 'arr.function($v) { $v * 2 }(2, 3)',
  'arr.(function($v) { $v * 2 })($)', 'arr.(function($v) { $v * 2 })()',
  'arr.(function($v) { $v * 2 }($))', '($f := function() { function($x) { $x + 1 } }; arr.$f()(10))',
  // A called expression applies whatever function it gives, as jsonata-js
  // `evaluateFunction` does: a lambda, a builtin, a partial application or a
  // composition. A `?` argument partially applies it; a non-function is T1006.
  '$type(arr.function($v, $w) { $v + $w }(?, 1))', 'arr.function($v, $w) { $v + $w }(?, 1)(5)',
  '(function($v, $w) { $v + $w })(?, 1)(5)', '$type((function($v, $w) { $v + $w })(?, 1))',
  'arr.function($v) { $v }($)()', 'arr.function($v) { $v }($)(1)', '(1)(2)', '(nope)(2)',
  '("x")(?)', '["x", "y"].($uppercase)($)', 'arr.($string)()', 'objs.($sum)(p)',
  '($u := $uppercase; ["x", "y"].($u)($))', '($uppercase)("x")', '($substring)(?, 1)("abc")',
  '["abc", "de"].($substring)($, ?)(1)', '($f := $uppercase ~> $trim; [" x"].($f)($))',
  '($u := $string; arr.$u())', '($f := function($x) { $x * 10 }; ($f)(?)(2))',
  // A `?` call in a lambda's tail position is a partial application too.
  '(function() { (function($a) { $string($a) })(?) })()("x")',
  '($g := function($a) { $uppercase($a) }; $f := function() { $g(?) }; $f()("x"))',
  '($g := function($a, $b) { $a & $b }; $f := function($x) { $g($x, ?) }; $f("a")("b"))',
  '($f := function() { (function($a, $b) { $a + $b })(1, ?) }; $f()(2))',
  // `$` is not an operator, so it can sit inside a name.
  '$a$b', '($a$b := 3; $a$b)', '($$a$b := 4; $$a$b)', '($a$b := 3; $$a$b)',
  // A higher-order function's callback is evaluated once, to a function
  // value, which is called with as many arguments as it takes (#204).
  '$map([1,2], ($string))', '$map([1,2], (true ? $string : $number))', '$map([1,2], [$string][0])',
  '$filter([1,2], (function($v){$v>1}))', '$map(n, ($sum ~> $string))', '$map(arr, ($sum ~> $string))',
  '$reduce([1,2], $sum ~> $string)', '$map([[3,1]], $sort)', '$map([1], $map)',
  '$single([1,2], ($x := function($v){$v=2}))', '$sift({"a":1,"b":2}, (function($v){$v>1}))',
  '$each({"a":1}, ($f := function($v,$k){$k}))', '$sort([3,1,2], (function($a,$b){$a>$b}))',
  '$sort([3,1,2], ($f := function($a,$b){$a>$b}))', '$map([1,2], ($x := 1; function($v){$v+$x}))',
  '$map([1,2], ($f := function($v){$v}; $f))', '$filter([1,2], $boolean ~> $not)',
  '$map([1,2], (5))', '$filter([1,2], "x")', '$map([1,2], (nope))',
  '$reduce([1,2], (function($a){$a}))', '$reduce([1,2], ($f := $string))', '$reduce([1,2], $string)',
  '$reduce([1,2], $sum)', '$reduce(nope, $string)', '$reduce([1,2,3], ($f := function($a,$b){$a+$b}))',
  '$replace("abc", /b/, ($f := function($m){"X"}))', '$map(["xa"], $match(?, /a/))',
  // The evaluated callback is held where no expression can name it.
  '$map([1,2,3], ($k := 1; function($v){ $exists($__hof_callback) }))',
  '($g := function(){ $__hof_callback }; $map([1], ($g)))', '$reduce([1,2], $random)',
  '($f := function($x){ [$__chain_x] }; ($f ~> $string)(5))',
  '($f := function($x){ $exists($__chain_x) or $exists($__chain_f) }; ($f ~> $string)(1))',
  // A regex literal is a function: called with a string, it gives the first
  // match, with `groups` and a `next` that gives the one after (#205).
  '($f := /a/; $f("xa"))', '"xa" ~> /a/', '$keys("xa" ~> /a/)', '"xa" ~> /a/ ~> $keys',
  '("xa" ~> /a/).groups', '$string("xa" ~> /a/)', '$sort ~> /a/', '($sort ~> /a/)([3,1])',
  '"éa" ~> /a/', '"😀a" ~> /a/', '("xaxa" ~> /a/).next()', '("xaxa" ~> /a/).next().next()',
  '("é😀aéa" ~> /a/).next()', '("xa" ~> /a/).next()', '("xa" ~> /a/).next', '("aab" ~> /a*/).next()',
  '("xyz" ~> /x|z/).next().next()', '/(a)(b)?/("xa")', '/a/i("XA")', '/a/("xa", 5)', '/a/("xaa", 2)',
  '/a/(5)', '/5/(5)', '/a/()', '/a/(null)', '/n/(null)', '[1, 2] ~> /2/', 'objs[0] ~> /o/',
  '"é" & "a" ~> /a/', '1 + 2 ~> $string',
  '($f := /a/ ~> $string; $f("xa"))', '$string(/a/)', '$type(/a/)', '$boolean(/a/)', '$not(/a/)',
  '$exists(/a/)', '$count(/a/)', '{"r": /a/}', 'true ? /a/ : 1', '/a/ = /a/',
  '($r := /a/; $match("xa", $r))', '($r := /a/; $replace("xa", $r, "b"))',
  '($r := /a/; $split("xaxa", $r))', '($r := /a/; $contains("xa", $r))',
  '$match("xaxa", function($s) { /a/($s) })', '$match("xaxa", /a/ ~> function($m) { $m })',
  '$map(["ab","ab","ab"], /b/)', '$map(["ab","ab","ab"], /b/).start', '$filter(["ab","cd"], /b/)',
  '$reduce(["a","b"], /a/)', '$sift({"a":"x","b":"y"}, /x/)', '$each({"a":"x"}, /x/)',
  '$sort(["b","a"], /x/)', '$single(["xa", "b"], /a/)',
];

// The same questions with a top-level array as input. jsonata-js wraps that
// array in a one-item `outerWrapper` sequence, so a path over it treats it as
// one item, while `$`, `*` and an object constructor see the bare array.
const ROOT_DATA = [{ a: [1, 2], b: { c: [[1]] } }, { a: [3] }, { a: [[4]], b: { c: [2] } }];

const ROOT_EXPRESSIONS = [
  'a', 'a[0]', 'a[1]', '(a)[0]', 'a[]', 'b.c', 'b.c[0]', '$.a', '$.a[0]', '$$.a[0]',
  '$[0]', '$[0].a', '*', '*.a', '*[0]', '$count(a)', '[a]', '[a][0]',
  '{"x": a}', '{"x": a[0]}', '{"x": b.c}', '{"x": $.a[0]}', '{"x": $$.a[0]}',
  '{"x": $count(a)}', '{"x": {"y": a[0]}}', '{"x": a[0]}.x', '[{"x": a[0]}]',
  '($y := {"x": a[0]}; $y)', '$map([1], function($v) { {"x": a[0]} })',
  '$.{"x": a}', 'a.{"x": $}', '{"x": a}.x[0]', '{a[0] = 1 ? "k" : "j": a}',
  '($f := function() { a }; $f())', '($f := function() { a[0] }; $f())',
  '$eval("a[0]")', '$eval("a[0]", $)', '$eval("a[0]", $$)', '$eval("{\\"x\\": a[0]}")',
  '$sort(a)', '$reverse(a)', 'a ~> $count', '(a)', '[1].(a[0])', '[1].{"x": $$.a[0]}',
];

// Operator combinations (#212). The reference suite tries each operator on
// its own, and several divergences hid in pairs it never tries: `%` in a
// group-by, a `%` sort over a parenthesized path, a `%` filter on a whole
// block. Every base is crossed with up to two operators, then a suffix step.
// The results go to their own fixture, one case per line, so a regenerated
// diff shows which combinations changed.
const COMBO_BASES = [
  'acct.Order.P', '(acct.Order.P)', 'acct.Order.(P)', 'acct.(Order.P)', 'acct.Order',
  'o.t', '(o.t)', 'objs', '(objs)', '$', '*',
];
const COMBO_OPS = [
  '[0]', '[-1]', '[N = "C"]', '[%.id = "o1"]', '[]', '^(N)', '^(>%.id)', '^($)',
  '{N: N}', '{N: %.id}', '{"k": $count($)}', '#$i', '@$v',
];
const COMBO_SUFFIXES = ['', '.N', '.%', '.%.id', '.$', '.{"i": $i}'];

function comboExpressions() {
  const out = [];
  for (const base of COMBO_BASES) {
    for (const suffix of COMBO_SUFFIXES) out.push(base + suffix);
    for (const op1 of COMBO_OPS) {
      for (const suffix of COMBO_SUFFIXES) out.push(base + op1 + suffix);
      for (const op2 of COMBO_OPS) out.push(base + op1 + op2);
    }
  }
  return [...new Set(out)];
}

function encode(v) {
  if (typeof v === 'undefined') return { $undefined: true };
  // A regex literal evaluates to a plain JavaScript function (#205).
  if (typeof v === 'function') return { $function: true };
  if (Array.isArray(v)) return Array.prototype.map.call(v, encode);
  if (v !== null && typeof v === 'object') {
    if (typeof v === 'function' || v._jsonata_lambda) return { $function: true };
    const out = {};
    for (const k of Object.keys(v)) out[k] = encode(v[k]);
    return out;
  }
  return v;
}

async function evaluate(expression, data) {
  try {
    // Fresh copy per case: jsonata-js sets flags on arrays in place.
    return encode(await jsonata(expression).evaluate(JSON.parse(JSON.stringify(data))));
  } catch (e) {
    return { $error: e.code || String(e.message) };
  }
}

async function main() {
  const expressions = [];
  for (const p of PATHS) for (const w of WRAPPERS) expressions.push(w(p));
  expressions.push(...EXTRA);
  const seen = new Set();
  const cases = [];
  for (const expression of expressions) {
    if (seen.has(expression)) continue;
    seen.add(expression);
    cases.push({ expression, result: await evaluate(expression, DATA) });
  }
  for (const expression of new Set(ROOT_EXPRESSIONS)) {
    cases.push({ expression, root: true, result: await evaluate(expression, ROOT_DATA) });
  }
  const fixture = {
    _comment: 'GENERATED by scripts/gen_path_semantics_corpus.js -- do not edit by hand.',
    reference: `jsonata-js ${refVersion} (tests/jsonata-js submodule)`,
    data: DATA,
    root_data: ROOT_DATA,
    cases,
  };
  const out = path.join(__dirname, '..', 'tests', 'fixtures', 'path_semantics_differential.json');
  fs.writeFileSync(out, JSON.stringify(fixture, null, 1) + '\n');
  console.log(`wrote ${cases.length} cases to ${path.relative(process.cwd(), out)}`);

  const combos = [];
  for (const expression of comboExpressions()) {
    combos.push({ expression, result: await evaluate(expression, DATA) });
  }
  const comboOut = path.join(__dirname, '..', 'tests', 'fixtures', 'path_semantics_combinations.json');
  const lines = combos.map((c) => ' ' + JSON.stringify(c));
  fs.writeFileSync(
    comboOut,
    '{\n "_comment": ' + JSON.stringify(fixture._comment) + ',\n "reference": ' +
      JSON.stringify(fixture.reference) + ',\n "data": ' + JSON.stringify(DATA) +
      ',\n "cases": [\n' + lines.join(',\n') + '\n ]\n}\n'
  );
  console.log(`wrote ${combos.length} cases to ${path.relative(process.cwd(), comboOut)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
