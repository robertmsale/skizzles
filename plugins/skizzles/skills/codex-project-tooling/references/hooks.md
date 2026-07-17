# Codex Hooks Reference

Codex hooks are repo/user/plugin-configured command handlers. Use them for lightweight policy checks, context injection, and lifecycle automation. Keep hooks fast, deterministic, non-interactive, and safe to run repeatedly.

## Where Hooks Live

Inline TOML in `.codex/config.toml`:

```toml
[features]
hooks = true

[hooks]

[[hooks.PreToolUse]]
matcher = "Bash"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "python3 .codex/hooks/check-shell.py"
timeout = 5
statusMessage = "checking shell command"
```

JSON in `.codex/hooks.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "python3 .codex/hooks/check-shell.py",
            "timeout": 5,
            "statusMessage": "checking shell command"
          }
        ]
      }
    ]
  }
}
```

Prefer inline TOML for small project-local hook declarations. Use `hooks.json` when the project already keeps hook config separate or when generated/plugin-style hook config is easier to manage as JSON.

## Event Names

Supported hook events:

- `PreToolUse`
- `PermissionRequest`
- `PostToolUse`
- `PreCompact`
- `PostCompact`
- `SessionStart`
- `UserPromptSubmit`
- `SubagentStart`
- `SubagentStop`
- `Stop`

Event tables contain matcher groups. A matcher group has optional `matcher` and a `hooks` array.

## Command Handler Fields

Command hooks use:

```toml
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "bun .codex/hooks/prompt-context.ts"
commandWindows = "node .codex/hooks/prompt-context.js"
timeout = 10
async = false
statusMessage = "loading project context"
```

Fields:

- `type`: Use `"command"` for executable hooks.
- `command`: Shell command for Unix/macOS.
- `commandWindows`: Optional Windows-specific command.
- `timeout`: Optional timeout in seconds.
- `async`: Optional boolean; use only when the hook should not block the user flow.
- `statusMessage`: Optional UI status text while the hook runs.

`prompt` and `agent` handler types exist in the config shape but are not the normal project-authoring path. Prefer `command` unless the repository already uses another handler type successfully.

## Matchers

Matchers select which occurrences of an event run a hook.

- Omitted matcher, `""`, or `"*"` matches all occurrences.
- Simple ASCII names use exact matching, such as `"Bash"` or `"Edit|Write"`.
- Pipe alternatives match exact candidates.
- Regex is used when the matcher contains regex syntax.
- `UserPromptSubmit` and `Stop` ignore matcher input.
- Tool-related events match tool names and aliases.
- `SubagentStart` and `SubagentStop` match agent type.
- Compact events match compact trigger.

## Stdin And Stdout

Hooks receive JSON on stdin. Common input fields include:

- `session_id`
- `turn_id` when available
- `transcript_path`
- `cwd`
- `hook_event_name`
- `model`
- `permission_mode`
- `agent_id` and `agent_type` for subagent-aware events

Tool hooks also receive `tool_name`, `tool_input`, and, for post-use hooks, tool output fields. Prompt hooks receive `prompt`. Stop hooks receive the last assistant message when available.

Plain non-empty stdout is usually rendered as hook output or additional model context depending on the event. JSON stdout can express structured decisions.

## Useful Output Patterns

Inject context for `SessionStart`, `SubagentStart`, or `UserPromptSubmit`:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "Project-specific context for the next model turn."
  }
}
```

Block a tool before it runs:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Use the project wrapper instead of this raw command."
  }
}
```

Allow or deny an approval request:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow"
    }
  }
}
```

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "deny",
      "message": "Do not push branches from agent sessions."
    }
  }
}
```

Block or reject a result after a tool runs:

```json
{
  "decision": "block",
  "reason": "The generated file contains a local absolute path."
}
```

Stop processing for prompt/session/compact/stop-style hooks:

```json
{
  "continue": false,
  "stopReason": "Required project context is missing."
}
```

## Safety Guidance

- Use hooks to enforce narrow, observable policy. Do not turn hooks into a second agent.
- Avoid network calls unless the hook is explicitly about network-backed validation.
- Avoid long builds in hooks. Use hooks to remind, route, or block; run heavyweight validation as an explicit task.
- Include clear failure messages. A blocked operation should tell the agent what to do instead.
- Keep scripts in a stable repo path such as `.codex/hooks/`.
- Validate hook config by parsing the TOML/JSON and, when available, using app or CLI hook-listing commands.
