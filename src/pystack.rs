//! Native stack for Python callbacks made from deep inside an evaluation.
//!
//! Deep evaluation levels run on heap-allocated stack segments
//! (`stacker::maybe_grow` in `Evaluator::evaluate_internal`), with only a
//! red zone of a few hundred KB guaranteed. CPython's own guard against
//! C-stack overflow (which turns runaway C recursion, such as `json.dumps` of
//! a deeply nested list, into `RecursionError`) knows nothing about those
//! segments:
//!
//! - 3.12 and 3.13 count C recursion levels against a fixed limit sized for
//!   a normal thread stack, so on a small segment the process crashes before
//!   the count runs out.
//! - 3.14 compares the stack pointer with the thread's stack bounds and does
//!   nothing at all when it is outside them, as it is on a segment.
//!
//! So a Python host function is called directly only while the evaluation is
//! still near where it started, on the caller's own stack: there it is as
//! safe as Python code at the call site, and costs what it always did (on
//! 3.13 a 1MB thread is too small for Python's own limit, with or without
//! this library). Otherwise it runs
//! on a fresh segment at least as large as the stack the caller had (and at
//! least [`HOST_MIN_STACK`]), and on 3.14+ CPython is told that segment's
//! bounds (`PyUnstable_ThreadState_SetStackProtection`) for the duration of
//! the call, so its checks raise `RecursionError` before the segment runs out.

use std::cell::RefCell;
use std::ffi::{c_int, c_void};
use std::sync::OnceLock;

use pyo3::ffi;
use pyo3::prelude::*;

/// How much stack an evaluation may have used since it was entered from
/// Python for a host call to still run directly on that stack.
const HOST_DIRECT_BUDGET: usize = 256 * 1024;

/// The least stack a host call made on a fresh segment is given. 3.13 can
/// overflow a 1MB thread by itself (`json.dumps` of a deep list); 2MB holds.
const HOST_MIN_STACK: usize = 2 * 1024 * 1024;

/// Where an evaluation was entered from Python: the stack pointer and the
/// stack left there.
#[derive(Clone, Copy)]
pub(crate) struct StackEntry {
    sp: usize,
    remaining: usize,
}

impl StackEntry {
    /// The current position, recorded when an evaluation with host functions
    /// starts. `None` when the stack's size is unknown.
    pub(crate) fn here() -> Option<StackEntry> {
        Some(StackEntry {
            sp: approximate_sp(),
            remaining: stacker::remaining_stack()?,
        })
    }
}

/// An address in the current stack frame, close to the stack pointer.
#[inline(never)]
fn approximate_sp() -> usize {
    let marker = 0u8;
    std::hint::black_box(&marker) as *const u8 as usize
}

type SetStackProtection =
    unsafe extern "C" fn(*mut ffi::PyThreadState, *mut c_void, usize) -> c_int;
type ResetStackProtection = unsafe extern "C" fn(*mut ffi::PyThreadState);

/// CPython 3.14's stack-protection API, looked up at run time: it is absent
/// from early 3.14 releases and from older versions, and an extension that
/// linked against it directly would fail to import there.
fn stack_protection_api(py: Python<'_>) -> Option<(SetStackProtection, ResetStackProtection)> {
    static API: OnceLock<Option<(usize, usize)>> = OnceLock::new();
    let (set, reset) = (*API.get_or_init(|| {
        let lookup = || -> PyResult<(usize, usize)> {
            let ctypes = py.import("ctypes")?;
            let api = ctypes.getattr("pythonapi")?;
            let c_void_p = ctypes.getattr("c_void_p")?;
            let address = |name: &str| -> PyResult<usize> {
                let func = api.getattr(name)?;
                ctypes
                    .getattr("cast")?
                    .call1((func, &c_void_p))?
                    .getattr("value")?
                    .extract()
            };
            Ok((
                address("PyUnstable_ThreadState_SetStackProtection")?,
                address("PyUnstable_ThreadState_ResetStackProtection")?,
            ))
        };
        lookup().ok().filter(|&(set, reset)| set != 0 && reset != 0)
    }))?;
    // SAFETY: both addresses are CPython's own exported functions with these
    // signatures (Include/cpython/pystate.h), found by name in the running
    // interpreter.
    unsafe {
        Some((
            std::mem::transmute::<usize, SetStackProtection>(set),
            std::mem::transmute::<usize, ResetStackProtection>(reset),
        ))
    }
}

thread_local! {
    /// Bounds (base, size) of the segments host calls are running on, outermost
    /// first, so a nested call can hand the outer one's bounds back to CPython.
    static PROTECTED: RefCell<Vec<(usize, usize)>> = const { RefCell::new(Vec::new()) };
}

/// Run `call` (a call into Python) with enough native stack for CPython's
/// recursion guard to work. `entry` is where the evaluation started.
pub(crate) fn with_python_stack<R>(
    py: Python<'_>,
    entry: Option<StackEntry>,
    call: impl FnOnce() -> R,
) -> R {
    let Some(entry) = entry else {
        return call();
    };
    let sp = approximate_sp();
    if sp <= entry.sp && entry.sp - sp <= HOST_DIRECT_BUDGET {
        // Near the start, on the caller's own stack: CPython's checks see
        // the stack they expect.
        return call();
    }
    let size = entry.remaining.max(HOST_MIN_STACK);
    let Some((set, reset)) = stack_protection_api(py) else {
        // Count-based CPython: as much stack as the caller had is as safe as
        // calling Python there.
        return stacker::grow(size, call);
    };
    // SAFETY (both blocks): the GIL is held (`py`), so the thread state is
    // valid, and the bounds passed are those of the stack in use.
    let tstate = unsafe { ffi::PyThreadState_Get() };
    let (result, protected) = stacker::grow(size, || {
        let top = approximate_sp();
        let Some(left) = stacker::remaining_stack() else {
            return (call(), false);
        };
        let base = top - left;
        if unsafe { set(tstate, base as *mut c_void, left) } != 0 {
            // Below CPython's minimum stack size: cannot happen at `size`.
            unsafe { ffi::PyErr_Clear() };
            return (call(), false);
        }
        PROTECTED.with(|p| p.borrow_mut().push((base, left)));
        (call(), true)
    });
    if protected {
        PROTECTED.with(|p| {
            let mut p = p.borrow_mut();
            p.pop();
            match p.last() {
                Some(&(base, len)) => unsafe {
                    set(tstate, base as *mut c_void, len);
                },
                None => unsafe { reset(tstate) },
            }
        });
    }
    result
}
