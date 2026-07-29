# Optional Luna V2 model catalog

This host-wiring surface is for owners who have independently verified Luna
with MultiAgentV2. It preserves the complete official catalog and changes only
`gpt-5.6-luna.multi_agent_version` from `v1` to `v2`. It is intentionally
separate from ordinary skill/plugin installation.

## Generate and inspect

Choose the Codex binary that owns app-server and run the canonical or bundled runtime:

```sh
/absolute/path/to/bun /absolute/path/to/runtime/model-catalog.ts refresh \
  --codex-home /absolute/path/to/.codex \
  --codex-binary /absolute/path/to/codex
```

The default output is `CODEX_HOME/skizzles/model-catalog.json`; bounded status
is written beside it. The generator uses a normal cache only when its whole
client version matches the selected binary, its timestamp is within Codex's
5-minute TTL, and it contains the expected complete model family. Otherwise
it invokes `codex debug models --bundled`. Before replacing the last-known-good
output, it makes the selected binary load the completed catalog in an isolated
credential-free `CODEX_HOME`. Every subprocess has a deadline and hard output
limits. The generator does not read, copy, or refresh authentication.

Verify that the output contains every expected model and exactly one Luna entry
marked V2. Configure Codex with the absolute generated path:

```toml
model_catalog_json = "/absolute/path/to/.codex/skizzles/model-catalog.json"
```

The custom catalog is authoritative and startup-only. `catalogChanged: true`
reports a change made by that specific refresh; `generation` is the stable
SHA-256 identity of the current catalog. Restart app-server after a reported
change; existing tasks retain their initial catalog and tool schema.

## Render and load the LaunchAgent on macOS

Render the portable template into the user's LaunchAgents directory using
absolute Bun, runtime, and Codex paths:

```sh
/absolute/path/to/bun /absolute/path/to/runtime/model-catalog.ts render-launch-agent \
  --template /absolute/path/to/assets/com.openai.skizzles-model-catalog.plist \
  --output /absolute/path/to/Library/LaunchAgents/com.openai.skizzles-model-catalog.plist \
  --bun /absolute/path/to/bun \
  --script /absolute/path/to/runtime/model-catalog.ts \
  --codex-home /absolute/path/to/.codex \
  --codex-binary /absolute/path/to/codex
```

Validate the rendered file with `plutil -lint`, then deliberately load it with
`launchctl bootstrap gui/UID PLIST`. The one-shot service runs at load, every
5 minutes, and when the normal cache or selected binary changes. It applies
an owner-only umask, is silent under launchd, and replaces one bounded status
file instead of accumulating service logs. It never restarts app-server
automatically.

## Rollback

Unload and remove the rendered LaunchAgent, remove `model_catalog_json` from
global configuration, and restart app-server. Retain the generated catalog
until the restart succeeds; deleting it while configuration still references it
makes startup fail closed. The normal remote/cache-backed model manager resumes
after the override is removed.
