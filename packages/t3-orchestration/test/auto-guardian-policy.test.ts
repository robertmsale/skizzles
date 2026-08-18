import { describe, expect, test } from "bun:test";
import {
  buildGuardianUserPrompt,
  decodeGuardianAssessment,
  lastUserMessageText,
  officialGuardianPolicyPrompt,
  OFFICIAL_AUTO_REVIEW_MODEL,
  PINNED_AUTO_REVIEW_MODEL,
} from "../src/auto-guardian-policy.ts";

describe("guardian assessment decode", () => {
  test("accepts official allow and deny payloads", () => {
    expect(decodeGuardianAssessment('{"outcome":"allow"}')).toEqual({
      ok: true,
      assessment: { outcome: "allow", rationale: "Auto-review returned a low-risk allow decision." },
    });
    expect(decodeGuardianAssessment('{"outcome":"deny","rationale":"destructive"}')).toEqual({
      ok: true,
      assessment: { outcome: "deny", rationale: "destructive" },
    });
  });

  test("fails closed on prose-wrapped JSON, extra keys, or a missing decision", () => {
    expect(decodeGuardianAssessment(null).ok).toBe(false);
    expect(decodeGuardianAssessment("not json").ok).toBe(false);
    expect(decodeGuardianAssessment('preface {"outcome":"allow"} suffix').ok).toBe(false);
    expect(decodeGuardianAssessment("{}").reason).toContain("missing a valid outcome");
    expect(decodeGuardianAssessment('{"decision":"allow"}').reason).toContain("unknown keys");
    expect(decodeGuardianAssessment('{"outcome":"allow","extra":true}').reason).toContain("unknown keys");
    expect(decodeGuardianAssessment('{"outcome":"maybe"}').reason).toContain("missing a valid outcome");
    expect(decodeGuardianAssessment('{"outcome":"allow","risk_level":"extreme"}').ok).toBe(false);
  });
});

describe("guardian prompt", () => {
  test("uses the official auto-review model id and extracted policy", () => {
    expect(OFFICIAL_AUTO_REVIEW_MODEL).toBe("codex-auto-review");
    expect(PINNED_AUTO_REVIEW_MODEL).toBe("gpt-5.6-luna");
    expect(officialGuardianPolicyPrompt()).toContain("You are judging one planned coding-agent action.");
    expect(officialGuardianPolicyPrompt()).toContain('"outcome": "allow" | "deny"');
    expect(officialGuardianPolicyPrompt()).toContain("default generic tenant");
  });

  test("passes the last user message and identifiable command", () => {
    expect(lastUserMessageText([
      { role: "user", text: "Implement the feature" },
      { role: "assistant", text: "working" },
      { role: "user", text: "Push your branch" },
    ])).toBe("Push your branch");
    expect(lastUserMessageText([{ role: "assistant", text: "hello" }])).toBeNull();
    const prompt = buildGuardianUserPrompt({
      lastUserMessage: "Push your branch",
      action: { requestKind: "command", command: "git push origin t3code/acme", cwd: "/worktree", toolName: "Shell" },
    });
    expect(prompt).toContain("user: Push your branch");
    expect(prompt).toContain("git push origin t3code/acme");
  });
});
