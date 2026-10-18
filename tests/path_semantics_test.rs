//! Path-semantics differential test (issue #184, step 3).
//!
//! Checks that both engines give the value jsonata-js gives for each corpus
//! expression: when a one-item sequence is unwrapped, when nested results are
//! flattened, and how both interact with blocks, constructors, variables,
//! function arguments and map stages. Cases marked `root` run on a
//! top-level array instead of an object.
//!
//! Regenerate the fixture with `node scripts/gen_path_semantics_corpus.js`.
//! Set `PATH_SEMANTICS_VERBOSE=1` to print every divergence.

use jsonata_core::evaluator::Evaluator;
use jsonata_core::value::JValue;
use jsonata_core::Expression;
use serde_json::{json, Map, Value};

mod common;
use common::norm;

/// Cases whose value still differs from jsonata-js. Each entry is
/// `(engine, expression)`. The list must stay exact: a case that starts
/// matching has to be removed from it.
const KNOWN_DIVERGENCES: &[(&str, &str)] = &[
    // `~>` returns undefined early when its left side is undefined; jsonata-js
    // passes undefined to the function, and `$append(undefined, [])` is `[]`.
    // Removing the early return needs `$single` and transforms to handle an
    // undefined first argument as jsonata-js does first.
    ("compiled", "e.x ~> $append([])"),
    ("tree", "e.x ~> $append([])"),
    ("compiled", "nope ~> $append([])"),
    ("tree", "nope ~> $append([])"),
    // A `%` in a group-by's key raises S0217 here; jsonata-js resolves it
    // and gives `{}`. Tracked separately from #184.
    ("compile", "acct.Order.P{%.id: N}"),
];

/// Mirror of `encode` in scripts/gen_path_semantics_corpus.js.
fn encode(v: &JValue) -> Value {
    match v {
        JValue::Undefined => json!({"$undefined": true}),
        JValue::Array(arr) => Value::Array(arr.iter().map(encode).collect()),
        JValue::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), encode(v)))
                .collect::<Map<_, _>>(),
        ),
        JValue::Lambda(_) | JValue::Builtin { .. } => json!({"$function": true}),
        other => Value::from(other),
    }
}

fn is_error(v: &Value) -> bool {
    v.get("$error").is_some()
}

/// The jsonata-js error code a case expects (`D3137`), if it has one. Some
/// expected errors are jsonata-js crashes with only a message; any error
/// matches those.
fn expected_code(v: &Value) -> Option<&str> {
    let code = v.get("$error")?.as_str()?;
    let is_code = code.len() == 5
        && code.starts_with(|c: char| c.is_ascii_uppercase())
        && code[1..].bytes().all(|b| b.is_ascii_digit());
    is_code.then_some(code)
}

#[test]
fn path_semantics_match_jsonata_js() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/path_semantics_differential.json")).unwrap();
    let object_data = JValue::from(fixture["data"].clone());
    let root_data = JValue::from(fixture["root_data"].clone());
    let verbose = std::env::var_os("PATH_SEMANTICS_VERBOSE").is_some();

    let mut divergences = Vec::new();
    for case in fixture["cases"].as_array().unwrap() {
        let src = case["expression"].as_str().unwrap();
        let expected = norm(&case["result"]);
        let data = if case["root"] == true {
            &root_data
        } else {
            &object_data
        };
        let expr = match Expression::compile(src) {
            Ok(expr) => expr,
            Err(e) => {
                if !is_error(&expected) {
                    divergences.push(("compile", src.to_string()));
                    if verbose {
                        println!("compile  {src}\n    expected {expected}\n    error    {e}");
                    }
                }
                continue;
            }
        };
        let compiled = expr.evaluate(data);
        let tree = Evaluator::new().evaluate(expr.ast(), data);
        for (engine, result) in [("compiled", compiled), ("tree", tree)] {
            let matches = match &result {
                Ok(v) => norm(&encode(v)) == expected,
                Err(e) => match expected_code(&expected) {
                    Some(code) => e.to_string().contains(code),
                    None => is_error(&expected),
                },
            };
            if !matches {
                if verbose {
                    let actual = match &result {
                        Ok(v) => encode(v).to_string(),
                        Err(e) => format!("error: {e}"),
                    };
                    println!("{engine:8} {src}\n    expected {expected}\n    actual   {actual}");
                }
                divergences.push((engine, src.to_string()));
            }
        }
    }

    let known: Vec<(&str, String)> = KNOWN_DIVERGENCES
        .iter()
        .map(|(e, s)| (*e, s.to_string()))
        .collect();
    assert_eq!(
        divergences, known,
        "divergences from jsonata-js changed; update KNOWN_DIVERGENCES \
         (run with PATH_SEMANTICS_VERBOSE=1 to see them)"
    );
}
