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
// Writes: tests/fixtures/path_semantics_differential.json

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

function encode(v) {
  if (typeof v === 'undefined') return { $undefined: true };
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
