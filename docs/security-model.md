# Skizzles security model

Skizzles adds developer ergonomics around Codex’s permission system. It does not implement a second operating-system sandbox.

## Authority layers

| Layer | Responsibility | Not authorized to do |
| --- | --- | --- |
| Skills and instructions | Describe expected agent behavior and workflows | Enforce filesystem, network, credential, or process isolation |
| Exec-policy rules | Route recognizable command forms to allow, prompt, or denial | Grant filesystem or network rights |
| PreToolUse hooks | Reject known-invalid input or conservatively transform a supported tool call | Interpret arbitrary shell programs or broaden host authority |
| Managed-command supervisor | Run the original script, bound output, retain owned artifacts, forward signals, and preserve final status | Override Codex permissions or create new writable/network access |
| Codex permission profile, guardian, and platform sandbox | Define the effective filesystem, network, credential, and escalation boundary | Delegated to Skizzles |

A hook decision or rewrite is not permission to escape the active Codex sandbox. The rewritten process and its descendants inherit the effective restrictions of the Codex execution that launched them.

## Managed-output transformation

The managed-output hook recognizes a narrow set of noisy local build and test commands. It rewrites an eligible script to the `codex-command` supervisor so output can be captured and compacted without changing the script’s intended status or signal behavior.

- Eligibility is based on the complete parsed command, not on `permission_mode`. Recognized commands remain eligible with ordinary or bypass permission metadata.
- Every relevant segment of a compound script must be eligible. Unsafe, effectful, ambiguous, substituted, or otherwise unrecognized shapes pass through to normal Codex handling.
- The base64url/JSON payload is transport encoding. It is not authorization, encryption, or concealment; the original script remains available to permission reviewers.
- The supervisor launches the original script as its child, captures bounded stdout and stderr into exact-owned system-temporary artifacts, reports compact progress, forwards signals to the process tree, and returns the resulting exit status.
- Output supervision must not become a general-purpose approval bypass. Commands that publish, deploy, install, mutate credentials, or perform other external effects are not made safe by wrapping them.

Prefix rules and command-text hooks cannot semantically prove what an arbitrary interpreter or opaque child process will do. Blanket bans on Bash, Python, Ruby, Perl, or similar tools would disrupt normal engineering without providing an operating-system security boundary. When Skizzles cannot confidently classify an optional optimization, it leaves the command to Codex.

## External and consequential effects

External writes, destructive operations, credential use, publication, deployment, sandbox overrides, and host configuration remain subject to the active Codex authorization path and the repository’s agent rules. A local edit or dry-run does not authorize a later push, review, release, or host mutation.

Container Lab has a separate trusted-project model for project-authored Docker Compose topology. See its [safety model](../packages/skizzles-container-lab/docs/safety.md).
