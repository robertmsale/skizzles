---
name: designer-runtime
description: Pilot local iOS Simulators for UI/design/QA work on macOS, especially Flutter or native iOS visual verification. Use explicitly when Codex needs to list booted simulators, launch or stop a simulator app, run or hot reload Flutter through a background unified_exec terminal, inspect accessibility hierarchy with idb, tap/type/swipe, capture screenshots, crop screenshots, or provide visual proof from an iOS Simulator.
---

# Designer Runtime

Use this skill for direct local iOS Simulator piloting from Designer or QA agents. It is macOS-only and prerequisite-gated: use it only when the host is macOS with Xcode command-line tools and an iOS Simulator runtime available. Keep it small and evidence-oriented: interact with the app, capture proof, report what changed or failed.

Before starting, confirm the required host tools are available. `xcrun` is required for simulator discovery and app launch; `idb` is required for hierarchy and interaction commands; and ImageMagick's `magick` is required for selector crops and manual crops. Flutter loops additionally require `flutter`. If a prerequisite is missing, stop with an actionable blocker rather than installing software or mutating host configuration.

Prefer existing XcodeBuildMCP simulator tools when they are available for a native iOS app. Use Codex's background shell session support for long-running Flutter/dev-server processes. Use the bundled `designer-sim` script for ad-hoc `idb` interaction, screenshot capture, and crop evidence.

## Guardrails

- Use one simulator per active loop and run commands sequentially.
- Do not erase, delete, or shut down simulators.
- Do not kill Simulator, CoreSimulator, or CoreSimulator services.
- Do not run project-wide build/analyze/test/format commands while parallel edits may still be active unless the parent asks for a verification sync point.
- Keep long-running app processes in one background terminal session and poll that session for output instead of wrapping it in tmux.
- Capture screenshots or logs for product blockers and include absolute paths in the result.
- Prefer selector-based taps/crops when accessibility labels or identifiers are available; use coordinates only when the hierarchy is insufficient.

## Scripts

The scripts live in this skill's `scripts/` directory. Run them by absolute path if they are not on `PATH`.

```sh
designer-sim devices
designer-sim hierarchy --device-id <UDID>
designer-sim screenshot --device-id <UDID> --out /tmp/proof.png
designer-sim screenshot --device-id <UDID> --selector '{"text":"Continue"}' --out /tmp/continue.png
designer-sim tap-on --device-id <UDID> --selector '{"text":"Continue"}'
designer-sim tap --device-id <UDID> --x 120 --y 240
designer-sim text --device-id <UDID> --text "hello"
designer-sim swipe --device-id <UDID> --from 180,700 --to 180,220
designer-sim launch --device-id <UDID> --bundle-id com.example.app
designer-sim terminate --device-id <UDID> --bundle-id com.example.app
designer-sim open-url --device-id <UDID> --url myapp://debug
```

## Flutter Loop

1. Start the app in a background terminal with the shell tool's session mode, from the app workdir:

   ```sh
   flutter run -d <UDID>
   ```

2. Poll the session output until Flutter reports the app is running or shows a concrete failure.
3. Inspect state with `designer-sim hierarchy` or `designer-sim screenshot`.
4. Make one interaction at a time with `designer-sim tap-on`, `tap`, `text`, or `swipe`.
5. After code edits, send `r` to the same background session to hot reload, then poll for the reload result.
6. Capture final proof with `designer-sim screenshot --out <absolute-path>`.
7. Stop the app by sending `q` or Ctrl-C to the same background session when the loop is done.

Do not use tmux for this workflow unless the user explicitly asks for it or the shell session tool is unavailable.

## Selector JSON

Selectors are small JSON objects. Common keys:

```json
{"text":"Continue"}
{"label":"Settings"}
{"id":"save-button"}
{"name":"Close"}
{"value":"Selected"}
```

Matching is case-insensitive exact text by default. Add `"contains": true` for substring matching:

```json
{"text":"continue", "contains": true}
```

## Visual Proof

Use screenshot paths under `/tmp/codex-designer-runtime/` or another absolute path. For final reports, include:

- device UDID or simulator name
- command or flow tested
- screenshot path
- observed blocker, if any
