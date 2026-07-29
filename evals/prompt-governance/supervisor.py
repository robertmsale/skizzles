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


def drain(stream, path: str, cap: int, state: dict[str, int | bool]) -> None:
    stored = 0
    total = 0
    truncated = False
    with open(path, "wb") as output:
        while True:
            chunk = stream.read(65536)
            if not chunk:
                break
            total += len(chunk)
            remaining = max(0, cap - stored)
            if remaining:
                kept = chunk[:remaining]
                output.write(kept)
                stored += len(kept)
            if len(chunk) > remaining:
                truncated = True
    state["bytes"] = total
    state["storedBytes"] = stored
    state["truncated"] = truncated


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
    prompt = sys.stdin.buffer.read()
    process = subprocess.Popen(
        command,
        cwd=args.cwd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
        env=dict(os.environ),
    )
    assert process.stdin is not None and process.stdout is not None and process.stderr is not None
    install_parent_death_signal()
    process.stdin.write(prompt)
    process.stdin.close()
    out_state: dict[str, int | bool] = {}
    err_state: dict[str, int | bool] = {}
    out_thread = threading.Thread(target=drain, args=(process.stdout, args.stdout, args.stdout_cap, out_state), daemon=True)
    err_thread = threading.Thread(target=drain, args=(process.stderr, args.stderr, args.stderr_cap, err_state), daemon=True)
    out_thread.start()
    err_thread.start()
    started = time.monotonic()
    timed_out = False
    interrupted = False

    def forward(signum: int, _frame: object) -> None:
        nonlocal interrupted
        interrupted = True
        terminate_group(process, signal.SIGTERM)

    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    try:
        process.wait(timeout=args.timeout_ms / 1000)
    except subprocess.TimeoutExpired:
        timed_out = True
        terminate_group(process, signal.SIGTERM)
    if timed_out or interrupted:
        try:
            process.wait(timeout=args.grace_ms / 1000)
        except subprocess.TimeoutExpired:
            pass
        # The leader may have exited while a descendant remains in the
        # session. Escalate based on process-group existence, not leader state.
        if group_exists(process.pid):
            terminate_group(process, signal.SIGKILL)
        if process.poll() is None:
            process.wait()
    remaining = max(0.0, args.timeout_ms / 1000 - (time.monotonic() - started))
    out_thread.join(timeout=remaining)
    err_thread.join(timeout=max(0.0, args.timeout_ms / 1000 - (time.monotonic() - started)))
    drain_timed_out = out_thread.is_alive() or err_thread.is_alive()
    if drain_timed_out:
        # A detached descendant can retain the pipe after the leader exits.
        # Do not close or join a blocking reader here; daemon drain threads
        # terminate with this supervisor and the bounded status can be emitted.
        timed_out = True
    result = {
        "exitCode": process.returncode if process.returncode is not None else 127,
        "timedOut": timed_out,
        "drainTimedOut": drain_timed_out,
        "interrupted": interrupted,
        # A descendant can retain an inherited pipe after the leader exits.
        # Emit a complete, bounded stream record even when its drain thread is
        # still blocked. Unknown bytes are represented as zero plus
        # ``truncated`` so callers never have to infer missing metadata from
        # an empty object.
        "stdout": complete_stream_state(out_state, drain_timed_out),
        "stderr": complete_stream_state(err_state, drain_timed_out),
    }
    status_text = json.dumps(result, separators=(",", ":"))
    print(status_text)
    if args.status:
        with open(args.status, "w", encoding="utf-8") as status_file:
            status_file.write(status_text)
    return 0


def terminate_group(process: subprocess.Popen[bytes], signum: signal.Signals) -> None:
    try:
        os.killpg(process.pid, signum)
    except ProcessLookupError:
        pass


def group_exists(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False


def complete_stream_state(state: dict[str, int | bool], drain_timed_out: bool) -> dict[str, int | bool]:
    known = all(key in state for key in ("bytes", "storedBytes", "truncated"))
    return {
        "bytes": int(state.get("bytes", 0)),
        "storedBytes": int(state.get("storedBytes", 0)),
        "truncated": bool(state.get("truncated", False)) or (drain_timed_out and not known),
    }


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
    except Exception as error:  # pragma: no cover - defensive supervisor boundary
        print(json.dumps({"error": str(error)}, separators=(",", ":")))
        raise
