# Performance Benchmarks

jsonatapy is a high-performance Rust implementation of JSONata with Python bindings. This page presents benchmark comparisons against other JSONata implementations.

**These numbers come from a dedicated, self-hosted Mac Mini (Apple Silicon), not a shared cloud CI runner** — single-tenant physical hardware with no other workloads competing for CPU. This matters: single-sample measurements on a shared/virtualized runner were previously noisy enough that identical code, measured twice, swung -66% to +120%. Every number below is also the *minimum* of 5 independent measurement trials per test (not an average) — for CPU-bound microbenchmarks, interference can only make a run slower than the code's true achievable speed, never faster, so the minimum across repeated trials is the best available estimate of that true speed.

## Implementations Tested

| Implementation | Language | Version | Description |
|----------------|----------|---------|-------------|
| **jsonatapy** | Rust + Python | 2.2.12 | This project (compiled Rust extension via PyO3); data crosses the boundary as Python dicts |
| **jsonatapy** (JSON string I/O) | Rust + Python | 2.2.12 | Same library via `evaluate_json`: data crosses as JSON strings, parsed/serialized by serde per call |
| **jsonata-core** (pure Rust) | Rust | 2.2.12 | This project's engine measured as a Rust library — no Python at all, data pre-parsed, expression pre-compiled (criterion methodology, per table row) |
| **jsonata-js** | JavaScript | 2.2.2 | Reference implementation (Node.js v20.20.2) |
| **jsonata-python** | Python | unknown | Python wrapper embedding a JS engine (Duktape) |
| **jsonata-rs** | Rust | 0.3 | Third-party Rust implementation (Stedi's crate — not this project; CLI harness, no Python overhead) |

### Methodology: compile-once, evaluate-many

Every implementation below is measured the way a real caller who evaluates the same expression repeatedly would use it, not its slowest possible one-off call:

- **jsonatapy** — `jsonatapy.compile(expr)` once, then `.evaluate(data)` in the timed loop. No further reuse is available; the compiled bytecode is already cached on the expression object.
- **jsonata-core (pure Rust)** — `Expression::compile(expr)` once, input parsed to a `JValue` once, then `Expression::evaluate(&data)` in an in-process timed loop with warmup — the same methodology as the criterion suite (`benches/`), reported per table row. The gap between this column and the jsonatapy columns *is* the Python boundary cost; the engine is identical.
- **jsonata-js** — `jsonata(expr)` once, then `.evaluate(data)` in the timed loop. Same story: this is already the library's fastest repeated-call path.

- **jsonata-python** — uses its documented `Context` object (`ctx = jsonata.Context()`, then `ctx(expr, data)` in the loop) rather than the one-off `transform()` convenience function. `transform()` re-bootstraps an embedded Duktape engine — reloading the `jsonata.js` library into it — on every single call; reusing a `Context` keeps that engine warm and is the library's own documented path for repeated evaluation. It is *not* a true compile-once equivalent, since `Context.__call__` still re-parses the expression string on every call, so some of the remaining gap to jsonatapy/jsonata-js is real parsing cost this library doesn't let a caller amortize away.


Benchmarks run on 2026-10-20.

## Summary by Category

| Category | jsonatapy vs JS |
|----------|----------------|
| Simple Paths | **5.6x faster** |
| Array Operations | **3.8x faster** |
| Complex Transformations | **8.0x faster** |
| Deep Nesting | **3.3x faster** |
| String Operations | **6.8x faster** |
| Higher-Order Functions | **12.3x faster** |
| Realistic Workload | **9.7x faster** |

## Detailed Results

### Simple Paths

| Operation | Data Size | jsonatapy | jsonatapy (json I/O) | jsonata-core (pure Rust) | jsonata-js | jsonata-python | jsonata-rs | vs JS |
|-----------|-----------|-----------|----------------------|--------------------------|------------|----------------|------------|-------|
| Simple Path | tiny | 3.404 | 4.530 | 0.649 | 16.950 | 1828.735 | 61.720 | **5.0x faster** |
| Deep Path (5 levels) | tiny | 4.300 | 6.530 | 1.214 | 25.290 | 3007.201 | 72.317 | **5.9x faster** |
| Array Index Access | 100 elements | 5.223 | 9.060 | 1.322 | 11.320 | 938.527 | 86.545 | **2.2x faster** |
| Arithmetic Expression | tiny | 2.434 | 3.833 | 0.693 | 22.450 | 2610.019 | 56.884 | **9.2x faster** |

### Array Operations

| Operation | Data Size | jsonatapy | jsonatapy (json I/O) | jsonata-core (pure Rust) | jsonata-js | jsonata-python | jsonata-rs | vs JS |
|-----------|-----------|-----------|----------------------|--------------------------|------------|----------------|------------|-------|
| Array Sum (100 elements) | 100 elements | 1.552 | 2.330 | 0.764 | 6.820 | 304.152 | 17.949 | **4.4x faster** |
| Array Max (100 elements) | 100 elements | 1.338 | 2.109 | 0.519 | 6.430 | 297.051 | 17.958 | **4.8x faster** |
| Array Count (100 elements) | 100 elements | 2.129 | 3.687 | 0.520 | 8.680 | 528.524 | 34.971 | **4.1x faster** |
| Array Sum (1000 elements) | 1000 elements | 2.470 | 3.914 | 1.053 | 4.670 | 179.011 | 24.192 | **1.9x faster** |
| Array Max (1000 elements) | 1000 elements | 1.973 | 3.410 | 0.555 | 3.850 | 166.481 | 24.144 | **2.0x faster** |
| Array Sum (10000 elements) | 10000 elements | 6.103 | 10.034 | 2.523 | 8.870 | 353.030 | 59.941 | **1.5x faster** |
| Array Mapping (extract field) | 100 objects | 7.896 | 26.010 | 1.273 | 21.450 | 2674.303 | 205.974 | **2.7x faster** |
| Array Mapping + Sum | 100 objects | 7.555 | 25.315 | 2.013 | 24.770 | 2979.160 | 205.888 | **3.3x faster** |
| Array Filtering (predicate) | 100 objects | 5.207 | 16.578 | 1.972 | 50.790 | 6730.847 | 107.011 | **9.8x faster** |

### Complex Transformations

| Operation | Data Size | jsonatapy | jsonatapy (json I/O) | jsonata-core (pure Rust) | jsonata-js | jsonata-python | jsonata-rs | vs JS |
|-----------|-----------|-----------|----------------------|--------------------------|------------|----------------|------------|-------|
| Object Construction (simple) | tiny | 3.887 | 3.766 | 2.955 | 26.760 | 2532.480 | 33.965 | **6.9x faster** |
| Object Construction (nested) | tiny | 6.077 | 4.964 | 4.278 | 33.410 | 2898.102 | 36.880 | **5.5x faster** |
| Conditional Expression | tiny | 1.118 | 1.660 | 0.393 | 13.630 | 1356.527 | 26.342 | **12.2x faster** |
| Multiple Nested Functions | tiny | 2.579 | 2.946 | 2.717 | 19.180 | 1777.014 | 27.906 | **7.4x faster** |

### Deep Nesting

| Operation | Data Size | jsonatapy | jsonatapy (json I/O) | jsonata-core (pure Rust) | jsonata-js | jsonata-python | jsonata-rs | vs JS |
|-----------|-----------|-----------|----------------------|--------------------------|------------|----------------|------------|-------|
| Deep Path (12 levels) | 12 levels | 4.510 | 6.165 | 0.993 | 25.880 | 2912.411 | 55.386 | **5.7x faster** |
| Nested Array Access | 4-level nested arrays | 8.435 | 13.128 | 0.599 | 7.980 | 611.698 | 107.419 | 1.1x slower |

### String Operations

| Operation | Data Size | jsonatapy | jsonatapy (json I/O) | jsonata-core (pure Rust) | jsonata-js | jsonata-python | jsonata-rs | vs JS |
|-----------|-----------|-----------|----------------------|--------------------------|------------|----------------|------------|-------|
| String Uppercase | tiny | 3.946 | 4.569 | 3.147 | 22.560 | 2395.996 | 53.487 | **5.7x faster** |
| String Lowercase | tiny | 3.962 | 4.566 | 3.197 | 22.450 | 2397.158 | 53.252 | **5.7x faster** |
| String Length | tiny | 3.634 | 4.386 | 2.660 | 24.600 | 2597.104 | 54.863 | **6.8x faster** |
| String Concatenation | tiny | 3.063 | 3.147 | 2.786 | 25.230 | 1923.759 | 30.246 | **8.2x faster** |
| String Substring | tiny | 2.843 | 3.197 | 2.909 | 19.460 | 1684.111 | 28.590 | **6.8x faster** |
| String Contains | tiny | 2.097 | 2.534 | 1.649 | 16.170 | 1416.831 | 28.300 | **7.7x faster** |

### Higher-Order Functions

| Operation | Data Size | jsonatapy | jsonatapy (json I/O) | jsonata-core (pure Rust) | jsonata-js | jsonata-python | jsonata-rs | vs JS |
|-----------|-----------|-----------|----------------------|--------------------------|------------|----------------|------------|-------|
| $map with lambda | 100 elements | 1.600 | 1.706 | 1.509 | 23.930 | 2673.195 | 7.207 | **15.0x faster** |
| $filter with lambda | 100 elements | 1.639 | 1.763 | 1.415 | 23.490 | 2678.940 | 7.097 | **14.3x faster** |
| $reduce with lambda | 100 elements | 3.030 | 3.202 | 2.994 | 22.710 | 2690.943 | 7.747 | **7.5x faster** |

### Realistic Workload

| Operation | Data Size | jsonatapy | jsonatapy (json I/O) | jsonata-core (pure Rust) | jsonata-js | jsonata-python | jsonata-rs | vs JS |
|-----------|-----------|-----------|----------------------|--------------------------|------------|----------------|------------|-------|
| Filter by category | 100 products | 7.512 | 41.332 | 2.089 | 52.020 | 7431.301 | 313.541 | **6.9x faster** |
| Calculate total value | 100 products | 7.763 | 40.220 | 4.197 | 37.620 | 5155.273 | 313.388 | **4.8x faster** |
| Complex transformation | 100 products | 14.476 | 23.511 | 8.471 | 87.790 | 9303.218 | 135.284 | **6.1x faster** |
| Group by category (aggregate) | 100 products | 11.520 | 23.559 | 7.974 | 88.190 | N/A | 133.484 | **7.7x faster** |
| Top rated products | 100 products | 1.645 | 9.070 | 1.037 | 37.460 | 4512.405 | 66.834 | **22.8x faster** |

### Path Comparison

| Operation | jsonatapy (ms) | Iterations |
|-----------|---------------|------------|
| Filter by category (data handle) | 11.766 | 500 |
| Filter by category (data→json) | 5.640 | 500 |
| Complex transformation (data handle) | 27.195 | 500 |
| Complex transformation (data→json) | 23.194 | 500 |
| Aggregate (data handle) | 4.726 | 500 |
| Aggregate (data→json) | 4.670 | 500 |

## Performance Characteristics

**Faster than JavaScript:**

- Simple Paths (**5.6x faster**)
- Array Operations (**3.8x faster**)
- Complex Transformations (**8.0x faster**)
- Deep Nesting (**3.3x faster**)
- String Operations (**6.8x faster**)
- Higher-Order Functions (**12.3x faster**)
- Realistic Workload (**9.7x faster**)

**Comparable to JavaScript:**

- (none this run)

### Optimizing Array Workloads

For array-heavy workloads, the dominant cost is converting Python dicts to Rust values on every call. Use `JsonataData` to pre-convert data once and reuse across multiple evaluations:

```python
import jsonatapy

data = {...}  # your data
expr = jsonatapy.compile("products[price > 100]")

# Pre-convert once
jdata = jsonatapy.JsonataData(data)

# Reuse many times (3-15x faster than evaluate(dict))
result = expr.evaluate_with_data(jdata)
```

## Methodology

- **Date:** 2026-10-20
- **Platform:** GitHub Actions (self-hosted Michaels-Mini, physical/dedicated hardware, macOS ARM64)
- **Python:** 3.14.6
- **Node.js:** v20.20.2
- All times are total wall-clock time for the stated number of iterations
- Each benchmark includes a warmup phase before measurement
- 'vs JS' column shows jsonatapy speedup relative to the JavaScript reference implementation
- Values > 1x mean jsonatapy is faster; < 1x means JavaScript is faster
