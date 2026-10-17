// Generates the array-flags differential corpus (issue #184).
//
// jsonata-js decides singleton unwrapping and flattening from flags it keeps
// on array values: `sequence` (set by createSequence()), `cons` (set on
// arrays built by a path-step `[...]` constructor) and `keepSingleton` (set
// by the `[]` modifier). This engine carries the same flags on JArray. Its
// results are compared value-for-value elsewhere, so this corpus records the
// flags on every array in each result, and tests/array_flags_test.rs checks
// that both engines set them the same way.
//
// Each array in a result is annotated as
//   {"$arr": [items...], "seq": bool, "cons": bool, "ks": bool}
// and undefined (inside an array or object, or as the whole result) as
// {"$undefined": true}.
//
// Usage: node scripts/gen_array_flags_corpus.js
// Writes: tests/fixtures/array_flags_differential.json

const fs = require('fs');
const path = require('path');
const jsonata = require(path.join(__dirname, '..', 'tests', 'jsonata-js', 'src', 'jsonata.js'));
const refVersion = require(path.join(__dirname, '..', 'tests', 'jsonata-js', 'package.json')).version;

// Top-level input is an object so that jsonata-js does not wrap it in an
// outerWrapper sequence, which this engine has no counterpart for.
const DATA = {
  orders: [
    { id: 1, tags: ['a'], items: [{ p: 1 }, { p: 2 }] },
    { id: 2, tags: ['b', 'c'], items: [{ p: 3 }] },
  ],
  a: [1, 2, 3],
  nested: [[1, 2], [3]],
  obj: { x: 1, y: [1, 2] },
  s: 'abab',
};

const EXPRESSIONS = [
  // Field lookup and path steps
  'a',
  'nested',
  'obj.y',
  'orders.id',
  'orders.tags',
  'orders.items',
  'orders.items.p',
  'orders[0].tags',
  'orders[1].tags',
  'orders.(tags)',
  'orders.(id)',
  'orders.$',
  'a.$',
  'orders.{"i": id}',
  'orders.{"t": tags}',
  'nested.$',
  // Array constructors
  '[1, 2, 3]',
  '[1, [2, 3]]',
  '[orders.id]',
  '[a, a]',
  'orders.[id]',
  'orders.[tags]',
  'orders.[id, tags]',
  '[orders.id].$',
  '[[1, 2], [3]]',
  // Range
  '[1..3]',
  '[1..3].$',
  '[1..3, 5]',
  // Wildcards and descendants
  '*',
  'obj.*',
  'orders.*',
  '**.p',
  'orders.**.p',
  // Filters
  'orders[id > 0].id',
  'orders[id > 0]',
  'a[$ > 1]',
  'a[[0, 1]]',
  'a[-1]',
  'nested[0]',
  'orders.items[p > 1].p',
  // Sort, index, focus
  'orders^(id).id',
  'orders^(>id)',
  'a^($)',
  'orders@$o.$o.id',
  'orders#$i.id',
  'orders#$i.$i',
  'orders.items@$i.$i.p',
  // Keep-array modifier
  'a[]',
  'orders.id[]',
  'orders[0].id[]',
  'orders[0].tags[]',
  '[orders.id][]',
  'orders.items.p[]',
  'orders[0][]',
  '$filter(a, function($v) { $v > 2 })[]',
  '$map([1], function($v) { $v })[]',
  // Tuple-stream paths with a sort
  'orders#$i[$i < 2]^(>id).id',
  'orders.items.p#$i^(>$)',
  'orders.items.p^(>$)',
  // Grouping
  'orders{"k": id}',
  'orders{"k": tags}',
  'orders.items{"k": p}',
  'orders.items{"k": p[]}',
  // Higher-order and other built-ins
  '$map(a, function($v) { $v })',
  '$map(a, function($v) { [$v] })',
  '$filter(a, function($v) { $v > 1 })',
  '$keys(obj)',
  '$keys(orders)',
  '$lookup(orders, "id")',
  '$lookup(orders, "tags")',
  '$spread(obj)',
  '$spread(orders)',
  '$each(obj, function($v, $k) { $k })',
  '$distinct(a)',
  '$distinct([1, 1, 2])',
  '$distinct(orders.id)',
  '$append(a, a)',
  '$append(a, [])',
  '$append(a, nothing)',
  '$append(orders.id, 3)',
  '$match(s, /a/)',
  '$reverse(a)',
  '$sort(a)',
  '$sort(orders.id)',
  '$zip(a, a)',
  '$split(s, "b")',
  '$sift(obj, function($v) { true })',
  // Variables and chains
  '($x := a; $x)',
  '($x := orders.id; $x)',
  '($x := [1, 2]; $x)',
  'a ~> $map(function($v) { $v })',
  'orders.id ~> $append(5)',
  '(a)',
  '(orders.id)',
  'true ? a : 0',
  'true ? orders.id : 0',
];

function annotate(v) {
  if (typeof v === 'undefined') return { $undefined: true };
  if (Array.isArray(v)) {
    return {
      $arr: Array.prototype.map.call(v, annotate),
      seq: !!v.sequence,
      cons: !!v.cons,
      ks: !!v.keepSingleton,
    };
  }
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = annotate(v[k]);
    return out;
  }
  return v;
}

// `--reference-suite OUT.jsonl`: instead of the corpus fixture, write one
// annotated line per reference-suite case that evaluates without error, for
// the ignored `audit_reference_suite_flags` test. Cases with bindings, time
// or depth limits are skipped.
async function referenceSuite(out) {
  const suite = path.join(__dirname, '..', 'tests', 'jsonata-js', 'test', 'test-suite');
  const lines = [];
  for (const group of fs.readdirSync(path.join(suite, 'groups')).sort()) {
    const dir = path.join(suite, 'groups', group);
    for (const file of fs.readdirSync(dir).sort()) {
      if (!file.endsWith('.json')) continue;
      let cases = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (!Array.isArray(cases)) cases = [cases];
      cases.forEach((c, i) => (c._id = `${group}/${file}#${i}`));
      for (const c of cases) {
        if (c.timelimit || c.depth) continue;
        if (c.bindings && Object.keys(c.bindings).length > 0) continue;
        const expr = c.expr !== undefined ? c.expr : fs.readFileSync(path.join(dir, c['expr-file']), 'utf8');
        const data = c.dataset
          ? JSON.parse(fs.readFileSync(path.join(suite, 'datasets', c.dataset + '.json'), 'utf8'))
          : c.data;
        let result;
        try {
          result = await jsonata(expr).evaluate(data);
        } catch (e) {
          continue;
        }
        lines.push(JSON.stringify({ id: c._id, expression: expr, data, result: annotate(result) }));
      }
    }
  }
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.log(`wrote ${lines.length} reference-suite cases to ${out}`);
}

async function main() {
  const flag = process.argv.indexOf('--reference-suite');
  if (flag !== -1) return referenceSuite(process.argv[flag + 1]);
  const cases = [];
  for (const expression of EXPRESSIONS) {
    // Fresh copy per case: jsonata-js sets flags on arrays in place.
    const data = JSON.parse(JSON.stringify(DATA));
    try {
      const result = await jsonata(expression).evaluate(data);
      cases.push({ expression, result: annotate(result) });
    } catch (e) {
      throw new Error(`corpus expression failed in jsonata-js: ${expression}: ${e.message || e.code}`);
    }
  }
  const fixture = {
    _comment: 'GENERATED by scripts/gen_array_flags_corpus.js -- do not edit by hand.',
    reference: `jsonata-js ${refVersion} (tests/jsonata-js submodule)`,
    data: DATA,
    cases,
  };
  const out = path.join(__dirname, '..', 'tests', 'fixtures', 'array_flags_differential.json');
  fs.writeFileSync(out, JSON.stringify(fixture, null, 1) + '\n');
  console.log(`wrote ${cases.length} cases to ${path.relative(process.cwd(), out)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
