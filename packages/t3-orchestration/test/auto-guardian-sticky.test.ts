import { describe, expect, test } from "bun:test";
import {
  grokStickyUnstickUserMessage,
  latestUserMessageApprovesExactArgv,
  needsGrokStickyUnstick,
  priorStickyDenyOfExactArgv,
  providerHasStickyExactArgvDeny,
  transcriptShowsHarnessRecordedDeny,
} from "../src/auto-guardian-sticky.ts";

const push = "git push origin t3code/acme";

describe("Grok sticky exact-argv deny", () => {
  test("applies only to the Grok driver, not Cursor Auto-review", () => {
    expect(providerHasStickyExactArgvDeny("grok")).toBe(true);
    expect(providerHasStickyExactArgvDeny("GROK")).toBe(true);
    expect(providerHasStickyExactArgvDeny("cursor")).toBe(false);
    expect(providerHasStickyExactArgvDeny("opencode")).toBe(false);
    expect(providerHasStickyExactArgvDeny(null)).toBe(false);
  });

  test("generic please-push text does not quote the exact argv", () => {
    expect(latestUserMessageApprovesExactArgv("please push", push)).toBe(false);
    expect(latestUserMessageApprovesExactArgv("Push your branch", push)).toBe(false);
    expect(latestUserMessageApprovesExactArgv(`I approve \`${push}\``, push)).toBe(true);
    expect(latestUserMessageApprovesExactArgv(push, push)).toBe(true);
  });

  test("builds the documented user-shaped unstick message", () => {
    expect(grokStickyUnstickUserMessage(push)).toBe(`I approve \`${push}\``);
  });

  test("detects a prior guardian decline of the exact argv", () => {
    expect(priorStickyDenyOfExactArgv({
      a: { threadId: "grok-task", decision: "decline", action: { command: push } },
    }, { threadId: "grok-task", command: push })).toBe(true);
    expect(priorStickyDenyOfExactArgv({
      a: { threadId: "grok-task", decision: "accept", action: { command: push } },
    }, { threadId: "grok-task", command: push })).toBe(false);
    expect(priorStickyDenyOfExactArgv({
      a: { threadId: "other", decision: "decline", action: { command: push } },
    }, { threadId: "grok-task", command: push })).toBe(false);
  });

  test("detects harness-recorded deny language that quotes the argv", () => {
    expect(transcriptShowsHarnessRecordedDeny([
      { role: "tool", text: `Auto mode blocked this action (This exact git push was already declined in harness-recorded permissions, and the latest user message does not approve it): ${push}` },
    ], push)).toBe(true);
    expect(transcriptShowsHarnessRecordedDeny([
      { role: "assistant", text: "I will try a safer approach" },
    ], push)).toBe(false);
  });

  test("needs an unstick only for Grok when the latest user message does not quote the argv", () => {
    const claims = {
      prior: { threadId: "grok-task", decision: "decline" as const, action: { command: push } },
    };
    expect(needsGrokStickyUnstick({
      driver: "grok",
      command: push,
      threadId: "grok-task",
      lastUserMessage: "please push",
      claims,
    })).toBe(true);
    expect(needsGrokStickyUnstick({
      driver: "grok",
      command: push,
      threadId: "grok-task",
      lastUserMessage: `I approve \`${push}\``,
      claims,
    })).toBe(false);
    expect(needsGrokStickyUnstick({
      driver: "cursor",
      command: push,
      threadId: "cursor-task",
      lastUserMessage: "please push",
      claims: {
        prior: { threadId: "cursor-task", decision: "decline", action: { command: push } },
      },
    })).toBe(false);
  });
});
