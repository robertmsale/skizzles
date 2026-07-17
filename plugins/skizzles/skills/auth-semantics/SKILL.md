---
name: auth-semantics
description: Preserve authentication, authorization, session, permission, access-control, and availability semantics. Use when changing login/session flows, permission checks, API auth errors, gated UI, role-based access, token refresh, logout behavior, unavailable states, or security-sensitive user access paths.
---

# Auth Semantics

Use this skill when a change touches auth, sessions, permissions, or access control. The goal is to preserve precise security semantics while improving behavior.

## Distinguish States

Keep these states separate:

- unauthenticated: no valid identity/session is present
- invalid session: identity was expected but token/session is expired, revoked, corrupt, or otherwise unusable
- unauthorized: identity is valid but lacks permission for the action/resource
- unavailable: the system cannot determine or serve the state because a dependency is unavailable
- invalid request: the caller supplied malformed or unsupported input

Do not collapse these into one generic failure path unless the product contract explicitly requires that.

## Security Rules

- Do not broaden privileges to make a flow pass.
- Do not force logout on mere permission denial unless that is the intended contract.
- Do not treat dependency outages as authorization denials.
- Do not reveal sensitive resource existence through error wording unless the product contract allows it.
- Do not replace server-side enforcement with UI-only hiding.
- Preserve audit/logging behavior where relevant.
- Ensure retries or refreshes cannot loop forever or mask denied permissions.

## UI/API Behavior

For UI, show the truthful state:

- login needed
- access denied
- session expired
- temporarily unavailable
- invalid input

For APIs, preserve status/error semantics used by callers. If the change alters status codes, error variants, response shapes, redirects, or retry behavior, treat that as a compatibility surface and verify affected callers.

## Verification

Inspect both enforcement and presentation:

- server/middleware/guard checks
- client gating and navigation
- token refresh/session invalidation paths
- error mapping
- tests or fixtures for denied, expired, unauthenticated, and unavailable cases
- logs/audit paths when applicable

Final claims should state which auth states were exercised or inspected and why privileges were not broadened.
