# Coordination Loop

Use only native tools advertised in the current task.

| Tool | Use |
| --- | --- |
| `spawn_agent` | Create one bounded leaf with exclusive ownership. |
| `send_message` | Deliver a correction, decision, or dependency to a running child. |
| `followup_task` | Start coherent follow-on work for an idle child when continuity is not a required guarantee. |
| `wait_agent` | Wait for mailbox activity or a bounded timeout. |
| `list_agents` | Inspect the current root tree and task status. |
| `interrupt_agent` | Stop obsolete, unsafe, or overlapping work. |

Messages are asynchronous. A successful send proves delivery to the task mailbox, not that the recipient has acted on it. Use `followup_task` rather than `send_message` to start a new turn for an idle child.

## Root loop

1. Spawn only children that can progress independently.
2. Continue root-only decisions or integration work; do not duplicate child execution.
3. Send dependency results as soon as their contracts stabilize.
4. Wait with `wait_agent` instead of polling.
5. Inspect completion claims and the shared worktree.
6. Return fixes to the existing owner when continuity is useful and reliable.
7. Use a fresh explicitly configured sibling when residency eviction, independence, escalation, or changed ownership makes continuity uncertain.

Native task paths and messages remain inside one root tree. When the current task does not advertise a cross-root operation, write a compact `/tmp` packet and use a manual handoff.
