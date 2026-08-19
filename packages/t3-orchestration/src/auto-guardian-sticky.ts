import { lastUserMessageText } from "./auto-guardian-policy.ts";

export const STICKY_EXACT_ARGV_DENY_DRIVER = "grok";

export type StickyDenyClaim = {
  threadId: string;
  decision: "accept" | "decline";
  action?: { command?: string | null };
};

export type StickyDenyEvidence = {
  driver: string | null | undefined;
  command: string;
  threadId: string;
  requestId?: string | null;
  lastUserMessage?: string | null;
  messages?: ReadonlyArray<{ role?: unknown; text?: unknown }>;
  claims?: Record<string, StickyDenyClaim>;
};

/**
 * Grok Auto records an ACP RejectOnce into the live permission actor's
 * in-memory `recorded_permission_decisions` (not `$GROK_HOME/sessions/.../permission.toml`).
 * The auto-mode classifier treats that decline as binding unless the latest
 * harness-supplied user turn quotes the exact argv.
 *
 * `x.ai/permissions/reset` / `ResetPermissionState` resets persisted
 * `PermissionState` grants only; it does not clear the recorded-decision
 * ledger. T3 exposes no session-command dispatch for that reset. The
 * documented unstick is a user-shaped `thread.turn.start` (`tasks.send`)
 * whose text contains the exact command string, for example
 * `I approve \`git push origin t3code/acme\``.
 *
 * Cursor Auto-review has no equivalent session-local exact-argv sticky deny.
 * A classifier block can be retried and then surfaces a normal approval
 * prompt; persistent policy is `permissions.json` allowlists / `autoRun`
 * steering, not a reject-once argv ledger. Do not invent one.
 */
export function providerHasStickyExactArgvDeny(driver: string | null | undefined): boolean {
  return driver?.trim().toLowerCase() === STICKY_EXACT_ARGV_DENY_DRIVER;
}

export function grokStickyUnstickUserMessage(command: string): string {
  return `I approve \`${command}\``;
}

export function latestUserMessageApprovesExactArgv(
  message: string | null | undefined,
  command: string,
): boolean {
  const quoted = command.trim();
  if (!quoted || message == null) return false;
  return message.includes(quoted);
}

export function historyLatestUserMessageApprovesExactArgv(
  messages: ReadonlyArray<{ role?: unknown; text?: unknown }> | undefined,
  command: string,
): boolean {
  return latestUserMessageApprovesExactArgv(lastUserMessageText(messages ?? []), command);
}

export function priorStickyDenyOfExactArgv(
  claims: Record<string, StickyDenyClaim> | undefined,
  input: { threadId: string; command: string; requestId?: string | null },
): boolean {
  if (!claims) return false;
  const command = input.command.trim();
  if (!command) return false;
  for (const claim of Object.values(claims)) {
    if (claim.threadId !== input.threadId) continue;
    if (claim.decision !== "decline") continue;
    if (claim.action?.command?.trim() !== command) continue;
    return true;
  }
  return false;
}

export function transcriptShowsHarnessRecordedDeny(
  messages: ReadonlyArray<{ role?: unknown; text?: unknown }> | undefined,
  command: string,
): boolean {
  if (!messages) return false;
  const quoted = command.trim();
  if (!quoted) return false;
  for (const message of messages) {
    if (typeof message.text !== "string") continue;
    const text = message.text;
    if (!text.includes(quoted)) continue;
    if (
      /already declined/i.test(text) ||
      /harness-recorded permissions/i.test(text) ||
      /Auto mode blocked this action/i.test(text)
    ) {
      return true;
    }
  }
  return false;
}

export function needsGrokStickyUnstick(input: StickyDenyEvidence): boolean {
  if (!providerHasStickyExactArgvDeny(input.driver)) return false;
  const command = input.command.trim();
  if (!command) return false;
  if (latestUserMessageApprovesExactArgv(input.lastUserMessage, command)) return false;
  if (historyLatestUserMessageApprovesExactArgv(input.messages, command)) return false;
  return priorStickyDenyOfExactArgv(input.claims, input)
    || transcriptShowsHarnessRecordedDeny(input.messages, command);
}
