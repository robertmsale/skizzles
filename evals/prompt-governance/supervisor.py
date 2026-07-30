#!/usr/bin/env python3
"""Bounded Unix process-group supervisor for one local Codex evaluation run."""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time

READ_CHUNK_BYTES = 64 * 1024
SUPERVISOR_STATUS_SCHEMA = "supervisor-status-v2"
SUPERVISOR_FAILURE_EXIT = 125
FAILURE_CATEGORIES = {"", "stream-open", "stream-read", "stream-write", "stream-close", "spawn", "input", "status-write", "internal"}

def new_state() -> dict[str, int | bool | str]:
    return {"bytes": 0, "storedBytes": 0, "truncated": False, "captureFailed": False, "failureCategory": ""}


def record_failure(state: dict[str, int | bool | str], state_lock: threading.Lock, capture_failed: threading.Event, category: str) -> None:
    with state_lock:
        if not bool(state["captureFailed"]):
            state["captureFailed"] = True
            state["failureCategory"] = category if category in FAILURE_CATEGORIES else "internal"
    capture_failed.set()


def write_all(output: object, data: memoryview) -> tuple[int, bool]:
    written = 0
    while written < len(data):
        try:
            result = output.write(data[written:])
        except InterruptedError:
            continue
        except Exception:
            return written, False
        if isinstance(result, bool) or not isinstance(result, int) or result <= 0 or result > len(data) - written:
            return written, False
        written += result
    return written, True


def close_output(output: object, state: dict[str, int | bool | str], state_lock: threading.Lock, capture_failed: threading.Event) -> None:
    failed = False
    try:
        output.flush()
    except Exception:
        failed = True
    try:
        output.close()
    except Exception:
        failed = True
    if failed:
        record_failure(state, state_lock, capture_failed, "stream-close")


def drain(stream, path: str, cap: int, state: dict[str, int | bool | str], state_lock: threading.Lock, capture_failed: threading.Event) -> None:
    output = None
    try:
        try:
            output = open(path, "wb", buffering=0)
        except Exception:
            record_failure(state, state_lock, capture_failed, "stream-open")
            return
        while True:
            try:
                chunk = os.read(stream.fileno(), READ_CHUNK_BYTES)
            except Exception:
                record_failure(state, state_lock, capture_failed, "stream-read")
                return
            if not chunk:
                return
            try:
                with state_lock:
                    state["bytes"] = int(state["bytes"]) + len(chunk)
                    remaining = max(0, cap - int(state["storedBytes"]))
            except Exception:
                record_failure(state, state_lock, capture_failed, "internal")
                return
            written, complete = write_all(output, memoryview(chunk[:remaining])) if remaining else (0, True)
            with state_lock:
                state["storedBytes"] = int(state["storedBytes"]) + written
                if len(chunk) > remaining:
                    state["truncated"] = True
            if not complete:
                record_failure(state, state_lock, capture_failed, "stream-write")
                return
    except Exception:
        record_failure(state, state_lock, capture_failed, "internal")
    finally:
        if output is not None:
            close_output(output, state, state_lock, capture_failed)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--stdout", required=True)
    parser.add_argument("--stderr", required=True)
    parser.add_argument("--stdout-cap", required=True, type=int)
    parser.add_argument("--stderr-cap", required=True, type=int)
    parser.add_argument("--timeout-ms", required=True, type=int)
    parser.add_argument("--grace-ms", required=True, type=int)
    parser.add_argument("--status")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        raise SystemExit("supervisor requires a command")
    out_state = new_state()
    err_state = new_state()
    out_lock = threading.Lock()
    err_lock = threading.Lock()
    capture_failed = threading.Event()
    process = None
    timed_out = False
    interrupted = False
    failure_category = ""
    try:
        try:
            prompt = sys.stdin.buffer.read()
        except Exception:
            return emit_status(args.status, build_status(out_state, err_state, out_lock, err_lock, 125, False, False, False, "input"))
        try:
            process = subprocess.Popen(command, cwd=args.cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, env=dict(os.environ))
        except Exception:
            return emit_status(args.status, build_status(out_state, err_state, out_lock, err_lock, 125, False, False, False, "spawn"))
        assert process.stdin is not None and process.stdout is not None and process.stderr is not None
        install_parent_death_signal()
        out_thread = threading.Thread(target=drain, args=(process.stdout, args.stdout, args.stdout_cap, out_state, out_lock, capture_failed), daemon=True)
        err_thread = threading.Thread(target=drain, args=(process.stderr, args.stderr, args.stderr_cap, err_state, err_lock, capture_failed), daemon=True)
        out_thread.start()
        err_thread.start()

        def forward(signum: int, _frame: object) -> None:
            nonlocal interrupted
            interrupted = True
            terminate_group(process, signal.SIGTERM)

        signal.signal(signal.SIGTERM, forward)
        signal.signal(signal.SIGINT, forward)
        try:
            process.stdin.write(prompt)
            process.stdin.close()
        except Exception:
            failure_category = "input"
            capture_failed.set()
            terminate_group(process, signal.SIGTERM)
        started = time.monotonic()
        deadline = started + args.timeout_ms / 1000
        while process.poll() is None and not timed_out:
            if capture_failed.is_set():
                terminate_group(process, signal.SIGTERM)
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                terminate_group(process, signal.SIGTERM)
                break
            try:
                process.wait(timeout=min(remaining, 0.05))
            except subprocess.TimeoutExpired:
                continue
            except Exception:
                failure_category = "internal"
                capture_failed.set()
                terminate_group(process, signal.SIGTERM)
                break
        if timed_out or interrupted or capture_failed.is_set():
            try:
                process.wait(timeout=args.grace_ms / 1000)
            except subprocess.TimeoutExpired:
                pass
            if group_exists(process.pid):
                terminate_group(process, signal.SIGKILL)
            if process.poll() is None:
                process.wait()
        remaining = max(0.0, deadline - time.monotonic())
        out_thread.join(timeout=remaining)
        err_thread.join(timeout=max(0.0, deadline - time.monotonic()))
        drain_timed_out = out_thread.is_alive() or err_thread.is_alive()
        if drain_timed_out:
            timed_out = True
        if not failure_category:
            failure_category = first_failure_category(out_state, err_state, out_lock, err_lock)
        status = build_status(out_state, err_state, out_lock, err_lock, process.returncode if process.returncode is not None else 127, timed_out, drain_timed_out, interrupted, failure_category, capture_failed.is_set())
        return emit_status(args.status, status)
    except Exception:
        if process is not None:
            terminate_group(process, signal.SIGTERM)
            try:
                process.wait(timeout=args.grace_ms / 1000)
            except Exception:
                terminate_group(process, signal.SIGKILL)
                try:
                    process.wait()
                except Exception:
                    pass
        return emit_status(args.status, build_status(out_state, err_state, out_lock, err_lock, 125, False, False, False, "internal", True))


def terminate_group(process: subprocess.Popen[bytes], signum: signal.Signals) -> None:
    try:
        os.killpg(process.pid, signum)
    except ProcessLookupError:
        pass


def group_exists(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
        return True
    except OSError:
        return False


def first_failure_category(out_state: dict[str, int | bool | str], err_state: dict[str, int | bool | str], out_lock: threading.Lock, err_lock: threading.Lock) -> str:
    for state, lock in ((out_state, out_lock), (err_state, err_lock)):
        with lock:
            category = state["failureCategory"]
            if isinstance(category, str) and category in FAILURE_CATEGORIES and category:
                return category
    return ""


def complete_stream_state(state: dict[str, int | bool | str], state_lock: threading.Lock) -> dict[str, int | bool]:
    with state_lock:
        return {"bytes": int(state["bytes"]), "storedBytes": int(state["storedBytes"]), "truncated": bool(state["truncated"])}


def build_status(out_state: dict[str, int | bool | str], err_state: dict[str, int | bool | str], out_lock: threading.Lock, err_lock: threading.Lock, child_exit: int, timed_out: bool, drain_timed_out: bool, interrupted: bool, failure_category: str, capture_failed: bool = False) -> dict[str, object]:
    category = failure_category if failure_category in FAILURE_CATEGORIES else first_failure_category(out_state, err_state, out_lock, err_lock)
    failed = capture_failed or bool(category) or timed_out or drain_timed_out or interrupted
    return {
        "schemaVersion": SUPERVISOR_STATUS_SCHEMA,
        "status": "failed" if failed else "complete",
        "exitCode": SUPERVISOR_FAILURE_EXIT if failed else child_exit,
        "timedOut": timed_out,
        "drainTimedOut": drain_timed_out,
        "interrupted": interrupted,
        "captureComplete": not failed,
        "failureCategory": category,
        "stdout": complete_stream_state(out_state, out_lock),
        "stderr": complete_stream_state(err_state, err_lock),
    }


def write_status_atomic(path: str, status_text: str) -> None:
    temporary = f"{path}.tmp.{os.getpid()}"
    try:
        with open(temporary, "w", encoding="utf-8", newline="") as status_file:
            status_file.write(status_text)
            status_file.flush()
            os.fsync(status_file.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        except OSError:
            pass


def emit_status(path: str | None, status: dict[str, object]) -> int:
    try:
        status_text = json.dumps(status, separators=(",", ":"))
    except Exception:
        status = {"schemaVersion": SUPERVISOR_STATUS_SCHEMA, "status": "failed", "exitCode": SUPERVISOR_FAILURE_EXIT, "timedOut": False, "drainTimedOut": False, "interrupted": False, "captureComplete": False, "failureCategory": "internal", "stdout": {"bytes": 0, "storedBytes": 0, "truncated": False}, "stderr": {"bytes": 0, "storedBytes": 0, "truncated": False}}
        status_text = json.dumps(status, separators=(",", ":"))
    try:
        if path:
            write_status_atomic(path, status_text)
        print(status_text, flush=True)
    except Exception:
        return SUPERVISOR_FAILURE_EXIT
    return SUPERVISOR_FAILURE_EXIT if status.get("status") == "failed" else 0


def install_parent_death_signal() -> None:
    if sys.platform != "linux":
        return
    try:
        import ctypes

        libc = ctypes.CDLL(None)
        libc.prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG
    except Exception:
        # Signal handlers still cover explicit TERM/INT; unsupported hosts are
        # reported by the surrounding harness rather than weakening cleanup.
        return


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:  # pragma: no cover - defensive supervisor boundary
        try:
            print(json.dumps({"schemaVersion": SUPERVISOR_STATUS_SCHEMA, "status": "failed", "exitCode": SUPERVISOR_FAILURE_EXIT, "timedOut": False, "drainTimedOut": False, "interrupted": False, "captureComplete": False, "failureCategory": "internal", "stdout": {"bytes": 0, "storedBytes": 0, "truncated": False}, "stderr": {"bytes": 0, "storedBytes": 0, "truncated": False}}, separators=(",", ":")), flush=True)
        except Exception:
            pass
        raise SystemExit(SUPERVISOR_FAILURE_EXIT)
