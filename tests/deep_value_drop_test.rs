// Dropping a very deeply nested value must not overflow the stack (#233).
//
// Each test builds a value about 100,000 levels deep and frees it on a thread
// with a 1MB stack (Windows' main-thread default). Freed by plain recursion,
// such a value overflowed at about 10,000 levels and aborted the process.

use indexmap::IndexMap;
use jsonata_core::{evaluator::Evaluator, parser::parse, value::JValue};

const DEPTH: usize = 100_000;

/// Run `f` on a thread with a 1MB stack, failing the test if it panics (a
/// stack overflow aborts the whole test binary instead).
fn on_small_stack<F: FnOnce() + Send + 'static>(f: F) {
    std::thread::Builder::new()
        .stack_size(1024 * 1024)
        .spawn(f)
        .unwrap()
        .join()
        .unwrap();
}

fn deep_array(depth: usize) -> JValue {
    let mut value = JValue::array(vec![]);
    for i in 0..depth {
        value = JValue::array(vec![JValue::from(i as i64), value, JValue::from("x")]);
    }
    value
}

fn deep_object(depth: usize) -> JValue {
    let mut value = JValue::object(IndexMap::new());
    for i in 0..depth {
        let mut map = IndexMap::new();
        map.insert("i".to_string(), JValue::from(i as i64));
        map.insert("a".to_string(), value);
        value = JValue::object(map);
    }
    value
}

/// Arrays and objects alternating, as a mixed document would nest them.
fn deep_mixed(depth: usize) -> JValue {
    let mut value = JValue::Null;
    for i in 0..depth {
        value = if i % 2 == 0 {
            JValue::array(vec![value])
        } else {
            let mut map = IndexMap::new();
            map.insert("a".to_string(), value);
            JValue::object(map)
        };
    }
    value
}

/// The nesting depth of `value`, following the last item of each array and
/// the `a` field of each object.
fn depth_of(value: &JValue) -> usize {
    let mut depth = 0;
    let mut node = value;
    loop {
        node = match node {
            JValue::Array(arr) if arr.len() == 3 => &arr[1],
            JValue::Array(arr) if arr.len() == 1 => &arr[0],
            JValue::Object(map) if map.contains_key("a") => &map["a"],
            _ => return depth,
        };
        depth += 1;
    }
}

#[test]
fn dropping_a_deep_array_does_not_overflow() {
    on_small_stack(|| {
        let value = deep_array(DEPTH);
        assert_eq!(depth_of(&value), DEPTH);
        drop(value);
    });
}

#[test]
fn dropping_a_deep_object_does_not_overflow() {
    on_small_stack(|| {
        let value = deep_object(DEPTH);
        assert_eq!(depth_of(&value), DEPTH);
        drop(value);
    });
}

#[test]
fn dropping_deep_mixed_arrays_and_objects_does_not_overflow() {
    on_small_stack(|| drop(deep_mixed(DEPTH)));
}

#[test]
fn dropping_a_shared_deep_value_frees_it_with_the_last_reference() {
    on_small_stack(|| {
        for make in [deep_array, deep_object, deep_mixed] {
            let value = make(DEPTH);
            let clone = value.clone();
            // Only a reference goes: the clone must still be whole.
            drop(value);
            assert_eq!(depth_of(&clone), depth_of(&make(10)) * DEPTH / 10);
            drop(clone);
        }
    });
}

#[test]
fn dropping_a_deep_value_shared_partway_down_keeps_the_shared_part() {
    on_small_stack(|| {
        let value = deep_array(DEPTH);
        // Hold a level halfway down, then free the outer value from the top.
        let mut node = &value;
        for _ in 0..DEPTH / 2 {
            node = match node {
                JValue::Array(arr) => &arr[1],
                _ => unreachable!(),
            };
        }
        let inner = node.clone();
        drop(value);
        assert_eq!(depth_of(&inner), DEPTH / 2);
        drop(inner);
    });
}

#[test]
fn into_vec_of_a_deep_array_keeps_the_items() {
    on_small_stack(|| {
        let JValue::Array(arr) = deep_array(DEPTH) else {
            unreachable!()
        };
        let items = arr.into_vec();
        assert_eq!(items.len(), 3);
        assert_eq!(depth_of(&items[1]), DEPTH - 1);
    });
}

fn evaluate(expr: &str) -> JValue {
    let ast = parse(expr).unwrap();
    let mut evaluator = Evaluator::new();
    evaluator.evaluate(&ast, &JValue::Null).unwrap()
}

#[test]
fn dropping_a_deep_array_built_by_reduce_does_not_overflow() {
    on_small_stack(|| {
        let value = evaluate(&format!(
            "$reduce([1..{DEPTH}], function($acc, $i){{ [$i, [$acc], 'x'] }}, [])"
        ));
        assert_eq!(depth_of(&value), DEPTH);
        drop(value);
    });
}

#[test]
fn dropping_a_deep_object_built_by_reduce_does_not_overflow() {
    on_small_stack(|| {
        let value = evaluate(&format!(
            "$reduce([1..{DEPTH}], function($acc, $i){{ {{'i': $i, 'a': $acc}} }}, {{}})"
        ));
        assert_eq!(depth_of(&value), DEPTH);
        drop(value);
    });
}

#[test]
fn a_deep_value_freed_inside_an_evaluation_does_not_overflow() {
    // The deep value is a binding the evaluation drops before returning.
    on_small_stack(|| {
        let value = evaluate(&format!(
            "($v := $reduce([1..{DEPTH}], function($acc, $i){{ {{'a': [$acc]}} }}, {{}}); $count($keys($v)))"
        ));
        assert_eq!(value, JValue::from(1i64));
    });
}
