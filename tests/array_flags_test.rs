//! Array-flag differential test (issue #184).
//!
//! jsonata-js keeps `sequence`, `cons` and `keepSingleton` flags on array
//! values and decides singleton unwrapping and flattening from them. This
//! engine carries the same flags on `JArray`. The fixture records, for each
//! corpus expression, the flags jsonata-js puts on every array in the result;
//! this test checks that the compiled engine and the tree-walker set the same
//! flags wherever they produce the same value.
//!
//! Regenerate the fixture with `node scripts/gen_array_flags_corpus.js`.

use jsonata_core::evaluator::Evaluator;
use jsonata_core::value::JValue;
use jsonata_core::Expression;
use serde_json::{json, Map, Value};

/// Cases whose *value* still differs from jsonata-js, so their flags cannot
/// be compared yet. Each entry is `(engine, expression)`. The list must stay
/// exact: a case that starts matching has to be removed from it.
const KNOWN_VALUE_DIVERGENCES: &[(&str, &str)] = &[
    // `$` over an array of arrays does not flatten one level (#184).
    ("compiled", "nested.$"),
    ("tree", "nested.$"),
    // `*` does not flatten array-valued fields as `evaluateWildcard` does.
    ("compiled", "*"),
    ("tree", "*"),
    // `$lookup` over an array does not flatten array-valued results.
    ("compiled", "$lookup(orders, \"tags\")"),
    ("tree", "$lookup(orders, \"tags\")"),
    // `$match` without `g` returns only the first match.
    ("compiled", "$match(s, /a/)"),
    ("tree", "$match(s, /a/)"),
];

/// Mirror of `annotate` in scripts/gen_array_flags_corpus.js.
fn annotate(v: &JValue) -> Value {
    match v {
        JValue::Undefined => json!({"$undefined": true}),
        JValue::Array(arr) => json!({
            "$arr": arr.iter().map(annotate).collect::<Vec<_>>(),
            "seq": arr.sequence,
            "cons": arr.cons,
            "ks": arr.keep_singleton,
        }),
        JValue::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), annotate(v)))
                .collect::<Map<_, _>>(),
        ),
        other => Value::from(other),
    }
}

/// Represent every number as f64, so `1` from the fixture equals `1.0` here.
fn norm(v: &Value) -> Value {
    match v {
        Value::Number(n) => json!(n.as_f64().unwrap()),
        Value::Array(items) => Value::Array(items.iter().map(norm).collect()),
        Value::Object(map) => {
            Value::Object(map.iter().map(|(k, v)| (k.clone(), norm(v))).collect())
        }
        other => other.clone(),
    }
}

/// Drop the flags from an annotated value, leaving only what it holds.
fn strip(v: &Value) -> Value {
    match v {
        Value::Object(map) if map.contains_key("$arr") => {
            Value::Array(map["$arr"].as_array().unwrap().iter().map(strip).collect())
        }
        Value::Object(map) => {
            Value::Object(map.iter().map(|(k, v)| (k.clone(), strip(v))).collect())
        }
        other => other.clone(),
    }
}

#[test]
fn array_flags_match_jsonata_js() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/array_flags_differential.json")).unwrap();
    let data = JValue::from(fixture["data"].clone());

    let mut flag_mismatches = Vec::new();
    let mut value_divergences = Vec::new();

    for case in fixture["cases"].as_array().unwrap() {
        let src = case["expression"].as_str().unwrap();
        let expected = &norm(&case["result"]);
        let expr = Expression::compile(src).unwrap_or_else(|e| panic!("{src}: {e}"));

        let compiled = expr.evaluate(&data);
        let tree = Evaluator::new().evaluate(expr.ast(), &data);

        for (engine, result) in [("compiled", compiled), ("tree", tree)] {
            let result = result.unwrap_or_else(|e| panic!("{engine} {src}: {e}"));
            let actual = norm(&annotate(&result));
            if strip(&actual) != strip(expected) {
                value_divergences.push((engine, src.to_string()));
            } else if actual != *expected {
                flag_mismatches.push(format!(
                    "{engine:8} {src}\n    expected {expected}\n    actual   {actual}"
                ));
            }
        }
    }

    assert!(
        flag_mismatches.is_empty(),
        "{} flag mismatch(es):\n{}",
        flag_mismatches.len(),
        flag_mismatches.join("\n")
    );

    let known: Vec<(&str, String)> = KNOWN_VALUE_DIVERGENCES
        .iter()
        .map(|(e, s)| (*e, s.to_string()))
        .collect();
    assert_eq!(
        value_divergences, known,
        "value divergences from jsonata-js changed; update KNOWN_VALUE_DIVERGENCES"
    );
}

/// One-off audit over the whole reference suite. Generate the input with
/// `node scripts/gen_array_flags_corpus.js --reference-suite OUT.jsonl`, then
/// run `ARRAY_FLAGS_AUDIT=OUT.jsonl cargo test --test array_flags_test -- --ignored`.
/// Prints every case whose value matches jsonata-js but whose flags do not.
#[test]
#[ignore]
fn audit_reference_suite_flags() {
    let path = std::env::var("ARRAY_FLAGS_AUDIT").expect("set ARRAY_FLAGS_AUDIT");
    let text = std::fs::read_to_string(path).unwrap();
    let (mut compared, mut value_diffs, mut flag_diffs) = (0, 0, 0);
    for line in text.lines() {
        let case: Value = serde_json::from_str(line).unwrap();
        let src = case["expression"].as_str().unwrap();
        let data = match case.get("data") {
            Some(d) => JValue::from(d.clone()),
            None => JValue::Undefined,
        };
        let expected = norm(&case["result"]);
        let Ok(expr) = Expression::compile(src) else {
            continue;
        };
        let compiled = expr.evaluate(&data);
        let tree = Evaluator::new().evaluate(expr.ast(), &data);
        for (engine, result) in [("compiled", compiled), ("tree", tree)] {
            let Ok(result) = result else { continue };
            let actual = norm(&annotate(&result));
            compared += 1;
            if strip(&actual) != strip(&expected) {
                value_diffs += 1;
            } else if actual != expected {
                flag_diffs += 1;
                println!(
                    "{engine:8} {}  {src}\n    expected {expected}\n    actual   {actual}",
                    case["id"].as_str().unwrap()
                );
            }
        }
    }
    println!("compared {compared}, value diffs {value_diffs}, flag diffs {flag_diffs}");
}
