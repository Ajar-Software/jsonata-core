//! A path step's compiled body is cached on the step (#197). The cache must
//! not change any value: in particular a builtin the cached step calls can be
//! shadowed in one call (or evaluation) and not the next, which the compiled
//! path must notice every time (#191). Each case runs on both engines: the
//! default dispatch (`Expression`, bytecode VM when the expression compiles)
//! and the tree-walker. Values verified against jsonata-js 2.x.
//!
//! That the step compiles only once is checked by the unit tests in
//! `src/evaluator.rs` (`step_cache`), which can see the compile counter.

use jsonata_core::evaluator::{Context, Evaluator};
use jsonata_core::value::JValue;
use jsonata_core::Expression;

fn jv(s: &str) -> JValue {
    JValue::from_json_str(s).unwrap()
}

/// Evaluate `src` against `data` on both engines, the same AST several times
/// over, and check each result.
fn assert_both(src: &str, data: &str, expected: &str) {
    let data = jv(data);
    let expected = jv(expected);
    let expr = Expression::compile(src).unwrap();
    for round in 0..3 {
        let compiled = expr.evaluate(&data).unwrap();
        assert_eq!(compiled, expected, "compiled, round {round}: {src}");
        let tree = Evaluator::new().evaluate(expr.ast(), &data).unwrap();
        assert_eq!(tree, expected, "tree, round {round}: {src}");
    }
}

const D: &str = r#"{"d": {"items": [{"x": 1}, {"x": 2}, {"x": 3}]}}"#;

#[test]
fn builtin_shadowed_in_some_calls_of_a_constructor_step() {
    let f = r#"$f := function($v, $s){ ( $s ? $string := function($x){ "z" } : 0; $v.items.{"s": $string(x)} ) }"#;
    assert_both(
        &format!("( {f}; [$f(d, false), $f(d, true), $f(d, false)] )"),
        D,
        r#"[{"s":"1"},{"s":"2"},{"s":"3"},{"s":"z"},{"s":"z"},{"s":"z"},{"s":"1"},{"s":"2"},{"s":"3"}]"#,
    );
    assert_both(
        &format!("( {f}; [$f(d, true), $f(d, false), $f(d, true)] )"),
        D,
        r#"[{"s":"z"},{"s":"z"},{"s":"z"},{"s":"1"},{"s":"2"},{"s":"3"},{"s":"z"},{"s":"z"},{"s":"z"}]"#,
    );
}

#[test]
fn builtin_shadowed_in_some_calls_of_a_block_step() {
    let f = r#"$f := function($v, $s){ ( $s ? $string := function($x){ "z" } : 0; $v.items.($string(x)) ) }"#;
    assert_both(
        &format!("( {f}; [$f(d, false), $f(d, true), $f(d, false)] )"),
        D,
        r#"["1","2","3","z","z","z","1","2","3"]"#,
    );
    assert_both(
        &format!("( {f}; [$f(d, true), $f(d, false), $f(d, true)] )"),
        D,
        r#"["z","z","z","1","2","3","z","z","z"]"#,
    );
}

#[test]
fn builtin_passed_as_a_parameter_of_the_same_name() {
    // Bound to the builtin itself: unshadowed. Bound to a function: shadowed.
    assert_both(
        r#"( $f := function($v, $string){ $v.items.{"s": $string(x)} };
             [$f(d, $string), $f(d, function($x){"z"}), $f(d, $string)] )"#,
        D,
        r#"[{"s":"1"},{"s":"2"},{"s":"3"},{"s":"z"},{"s":"z"},{"s":"z"},{"s":"1"},{"s":"2"},{"s":"3"}]"#,
    );
}

#[test]
fn map_over_constructor_step_in_function_body() {
    assert_both(
        r#"$map(big, function($v){ $v.items.{"a": x, "b": y} })"#,
        r#"{"big": [{"items": [{"x": 0, "y": "a"}, {"x": 1, "y": "b"}]},
                    {"items": [{"x": 1, "y": "a"}, {"x": 2, "y": "b"}]}]}"#,
        r#"[[{"a":0,"b":"a"},{"a":1,"b":"b"}],[{"a":1,"b":"a"},{"a":2,"b":"b"}]]"#,
    );
}

#[test]
fn top_level_constructor_step() {
    assert_both(
        r#"products.{"n": name, "p": price}"#,
        r#"{"products": [{"name": "a", "price": 1}, {"name": "b", "price": 2}]}"#,
        r#"[{"n":"a","p":1},{"n":"b","p":2}]"#,
    );
}

#[test]
fn binding_shadows_builtin_in_one_evaluation_not_the_next() {
    // The same AST, so the same cached step, evaluated with `$string` bound
    // in the context, then without, then with again (jsonata-js: a binding
    // passed to `evaluate` replaces the builtin for that evaluation only).
    let data = jv(r#"{"products": [{"name": "a"}, {"name": "b"}]}"#);
    for src in [
        r#"products.{"n": $string(name)}"#,
        r#"products.($string(name))"#,
    ] {
        let expr = Expression::compile(src).unwrap();
        let unbound = |out: &str| {
            let v = Evaluator::new().evaluate(expr.ast(), &data).unwrap();
            assert_eq!(v, jv(out), "unbound: {src}");
        };
        let bound = |out: &str| {
            let mut context = Context::new();
            context.bind(
                "string".to_string(),
                JValue::Builtin {
                    name: "uppercase".into(),
                },
            );
            let v = Evaluator::with_context(context)
                .evaluate(expr.ast(), &data)
                .unwrap();
            assert_eq!(v, jv(out), "bound: {src}");
        };
        let (plain, upper) = if src.contains('{') {
            (r#"[{"n":"a"},{"n":"b"}]"#, r#"[{"n":"A"},{"n":"B"}]"#)
        } else {
            (r#"["a","b"]"#, r#"["A","B"]"#)
        };
        unbound(plain);
        bound(upper);
        unbound(plain);
        bound(upper);
    }
}
