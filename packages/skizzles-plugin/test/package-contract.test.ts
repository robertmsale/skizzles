import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stagePlugin } from "../src/plugin-package.ts";
import { PackageTestSandbox } from "./package-fixture.ts";

const sandbox = new PackageTestSandbox();
afterEach(() => sandbox.cleanup());

describe("published plugin contracts", () => {
  test("uses the root lockfile for the Container Lab workspace", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const rootPackage = await Bun.file(join(repoRoot, "package.json")).json() as {
      workspaces?: unknown;
    };
    expect(rootPackage.workspaces).toEqual(["packages/skizzles-*"]);
    expect(
      await Bun.file(join(repoRoot, "packages/skizzles-container-lab/bun.lock")).exists(),
    ).toBe(false);
    expect(await readFile(join(repoRoot, "bun.lock"), "utf8")).toContain(
      '"@skizzles/container-lab@workspace:packages/skizzles-container-lab"',
    );
  });

  test("canonical hook discovery uses plugin-root commands", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const hooks = await Bun.file(join(repoRoot, "hooks/hooks.json")).json();

    expect(hooks).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: 'bun "${PLUGIN_ROOT}/hooks/manage-command-output.ts"',
                timeout: 3,
                statusMessage: "checking command output management",
              },
            ],
          },
        ],
      },
    });
  });

  test("stages active orchestration and installation contracts", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const root = await sandbox.createTemporaryRoot("skizzles-orchestration-contract-");
    const staged = join(root, "staged");
    await stagePlugin(repoRoot, staged);

    const canonicalFourthWall = await readFile(
      join(repoRoot, "skills/fourth-wall/SKILL.md"),
      "utf8",
    );
    const stagedFourthWall = await readFile(
      join(staged, "skills/fourth-wall/SKILL.md"),
      "utf8",
    );
    expect(stagedFourthWall).toBe(canonicalFourthWall);
    expect(stagedFourthWall).toContain("fixed-role local engineering team");
    expect(stagedFourthWall).toContain("## Evidence-First Triage");
    expect(stagedFourthWall).toContain("## Parallel Luna Implementation");
    expect(stagedFourthWall).toContain("| `worker` | `gpt-5.6-luna` | xhigh |");
    expect(stagedFourthWall).toContain("| `review` | `gpt-5.6-sol` | high |");
    expect(stagedFourthWall).toContain(
      "There are no capability variants or model-escalation ladder",
    );
    expect(stagedFourthWall).not.toContain(
      "Read before the first subagent spawn or orchestration action",
    );
    const stagedLearning = await readFile(
      join(staged, "skills/fourth-wall/references/learning-loop.md"),
      "utf8",
    );
    expect(stagedLearning).toContain("private host-local record");
    expect(stagedLearning).toContain(
      "Never copy campaign-derived observations into this public skill repository",
    );
    expect(
      await Bun.file(
        join(staged, "skills/fourth-wall/resources/learning-log.md"),
      ).exists(),
    ).toBe(false);

    const delegationPath = "skills/fourth-wall/references/delegation-contract.md";
    const canonicalDelegation = await readFile(join(repoRoot, delegationPath), "utf8");
    const stagedDelegation = await readFile(join(staged, delegationPath), "utf8");
    expect(stagedDelegation).toBe(canonicalDelegation);
    expect(stagedDelegation).toContain("## Complete Slice Test");

    const handoffPath = "skills/fourth-wall/references/handoff-packet.md";
    const canonicalHandoff = await readFile(join(repoRoot, handoffPath), "utf8");
    const stagedHandoff = await readFile(join(staged, handoffPath), "utf8");
    expect(stagedHandoff).toBe(canonicalHandoff);
    expect(stagedHandoff).toContain("# Context Renewal And Warm Handoff");
    expect(stagedHandoff).toContain("manual handoff");
    expect(stagedHandoff).not.toContain("<role>__<objective>");

    const canonicalInstaller = await readFile(
      join(repoRoot, "skills/install-skizzles/SKILL.md"),
      "utf8",
    );
    const stagedInstaller = await readFile(
      join(staged, "skills/install-skizzles/SKILL.md"),
      "utf8",
    );
    expect(stagedInstaller).toBe(canonicalInstaller);
    expect(stagedInstaller).toContain(
      "codex plugin marketplace add https://github.com/robertmsale/skizzles",
    );
    expect(stagedInstaller).toContain("codex plugin add skizzles@skizzles");
    expect(stagedInstaller).toContain(
      "Plugin and direct-skill copies are alternatives",
    );
    expect(stagedInstaller).toContain("CLI `0.145.0` is portable/partial");
    expect(stagedInstaller).not.toContain("blob/main/docs/compatibility.md");
    expect(stagedInstaller).not.toMatch(
      /reviewed local source|reviewed local marketplace|unpublished local fix/i,
    );

    const manifest = JSON.parse(
      await readFile(join(staged, ".codex-plugin/plugin.json"), "utf8"),
    ) as { homepage: string; repository: string };
    expect(manifest.homepage).toBe("https://github.com/robertmsale/skizzles");
    expect(manifest.repository).toBe("https://github.com/robertmsale/skizzles");

    for (
      const path of [
        "assets/skizzles_instructions.md",
        "assets/skizzles_subagent_instructions.md",
      ]
    ) {
      const contents = await readFile(join(staged, path), "utf8");
      expect(contents).toContain(
        "A short Python or other script is appropriate when safer or clearer",
      );
      expect(contents).toContain("do not script trivial changes");
    }

  });

  test("records the supplied compatibility boundary", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const compatibility = await readFile(
      join(repoRoot, "docs/compatibility.md"),
      "utf8",
    );

    expect(compatibility).toContain("CLI `0.145.0`: portable/partial");
    expect(compatibility).toContain(
      "CLI `>= 0.146.0-alpha.3`: full same-root core",
    );
    expect(compatibility).toContain("Supported when generated roles are configured");
    expect(compatibility).toContain("Cross-root task operations");
    expect(compatibility).toContain("Desktop-only extras when advertised");
    expect(compatibility).toContain(
      '`fork_turns="all"` bypasses selected-role configuration',
    );
    expect(compatibility).toContain(
      "Eviction or reload ends the continuity guarantee",
    );
    expect(compatibility).toContain(
      "plugin and a plain-skill copy are alternative installation surfaces",
    );
    expect(compatibility).not.toMatch(
      /reviewed local source|reviewed local marketplace|unpublished local fix/i,
    );
  });
});
