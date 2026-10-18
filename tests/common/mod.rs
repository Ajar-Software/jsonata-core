//! Helpers shared by the jsonata-js differential tests.

use serde_json::{json, Value};

/// Represent every number as f64, so `1` from a fixture equals `1.0` here.
pub fn norm(v: &Value) -> Value {
    match v {
        Value::Number(n) => json!(n.as_f64().unwrap()),
        Value::Array(items) => Value::Array(items.iter().map(norm).collect()),
        Value::Object(map) => {
            Value::Object(map.iter().map(|(k, v)| (k.clone(), norm(v))).collect())
        }
        other => other.clone(),
    }
}
