import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { doctorContainerLab } from "../src/doctor";
import { doctor } from "../src/doctor";
import { installSkills } from "../src/core";
import { installHarness } from "../src/harness";

const roots: string[] = [];
function stubs(mode: "ready" | "not-ready" | "malformed" | "oversized" | "stderr" | "hang"): string {
  const root = `${process.env.TMPDIR ?? "/tmp"}/skizzles-doctor-test-${crypto.randomUUID()}`;
  roots.push(root);
  mkdirSync(root, { recursive: true });
  const operational = join(root, "codex-container-lab");
  const reaper = join(root, "codex-container-lab-reaper");
  const response = mode === "ready" ? '{"ok":true,"dockerAvailable":true,"labs":0}' :
    '{"ok":true,"dockerAvailable":false,"labs":0}';
  const body = mode === "malformed" ? "console.log('not-json')" : mode === "oversized" ?
    "console.log(JSON.stringify({help:'x'.repeat(17000)}))" : mode === "stderr" ?
    "console.error('x'.repeat(17000)); console.log(JSON.stringify({help:'codex-container-lab run --lab ID -- COMMAND'}))" : mode === "hang" ?
    "setInterval(() => {}, 1000)" :
    `if (process.argv.includes('--help')) console.log(JSON.stringify({help:'codex-container-lab run --lab ID -- COMMAND'})); else console.log('${response}')`;
  writeFileSync(operational, `#!${process.execPath}\n${body}\n`);
  writeFileSync(reaper, `#!${process.execPath}\nconsole.log(JSON.stringify({help:'codex-container-lab-reaper [--db PATH]'}))\n`);
  chmodSync(operational, 0o755);
  chmodSync(reaper, 0o755);
  return root;
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("Container Lab doctor", () => {
  test("reports missing binaries without exposing paths", () => {
    const report = doctorContainerLab("");
    expect(report).toMatchObject({ installed: false, compatible: false, ready: false });
    expect(JSON.stringify(report)).not.toContain(process.cwd());
  });
  test("classifies ready and installed-not-ready", () => {
    const descriptor = JSON.parse(readFileSync(resolve(import.meta.dir, "../../../integrations/container-lab.json"), "utf8"));
    expect(doctorContainerLab(stubs("ready"))).toMatchObject({ installed: true, compatible: true, ready: true, version: `configured-${descriptor.configuredRuntime}-unverified` });
    expect(doctorContainerLab(stubs("not-ready"))).toMatchObject({ installed: true, compatible: true, ready: false, dockerAvailable: false });
  });
  test("rejects malformed and oversized public output", () => {
    expect(doctorContainerLab(stubs("malformed"))).toMatchObject({ compatible: false, reason: "Container Lab returned malformed JSON" });
    expect(doctorContainerLab(stubs("oversized"))).toMatchObject({ compatible: false, reason: "external command exceeded its public output limit" });
  });
  test("uses the descriptor version and output cap", () => {
    const path = stubs("ready");
    const descriptorPath = join(path, "contract.json");
    writeFileSync(descriptorPath, JSON.stringify({
      configuredRuntime: "9.8.7",
      binaries: { operational: "codex-container-lab", reaper: "codex-container-lab-reaper" },
      execution: { adminMaxBytes: 8 },
    }));
    expect(doctorContainerLab(path, descriptorPath)).toMatchObject({
      version: "configured-9.8.7-unverified",
      compatible: false,
      reason: "external command exceeded its public output limit",
    });
  });
  test("bounds hanging commands and stderr", () => {
    expect(doctorContainerLab(stubs("hang"), undefined, 50)).toMatchObject({ compatible: false, ready: false });
    expect(doctorContainerLab(stubs("stderr"))).toMatchObject({ compatible: false, ready: false });
  });
  test("reports Skizzles install health independently of optional Container Lab", () => {
    const root = `${process.env.TMPDIR ?? "/tmp"}/skizzles-install-doctor-${crypto.randomUUID()}`;
    roots.push(root);
    const sourceRoot = join(root, "source");
    const home = join(root, "home");
    const codexHome = join(root, "codex");
    mkdirSync(join(sourceRoot, "skills/example"), { recursive: true });
    writeFileSync(join(sourceRoot, "skills/example/SKILL.md"), "---\nname: example\ndescription: fixture\n---\n");
    mkdirSync(join(sourceRoot, "plugins/skizzles/.codex-plugin"), { recursive: true });
    writeFileSync(join(sourceRoot, "plugins/skizzles/.codex-plugin/plugin.json"), '{"name":"skizzles"}\n');
    installSkills({ codexHome, sourceRoot, transfer: "link" });
    installHarness({ home, sourceRoot, transfer: "link" });
    expect(doctor(home, codexHome, "")).toMatchObject({
      ok: true,
      installs: { skills: "healthy", harness: "healthy" },
      containerLab: { installed: false },
    });
    writeFileSync(join(sourceRoot, "skills/example/SKILL.md"), "changed");
    expect(doctor(home, codexHome, "")).toMatchObject({ ok: true });
    rmSync(join(codexHome, "skills/example"));
    expect(doctor(home, codexHome, "")).toMatchObject({ ok: false, installs: { skills: "drifted" } });
  });
});
