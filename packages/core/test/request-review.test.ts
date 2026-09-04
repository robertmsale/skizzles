import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const runner = resolve(import.meta.dir, "../../../skills/request-review/scripts/request-review.ts");
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "request-review-")); roots.push(root);
  const repo = join(root, "repo"); await mkdir(repo);
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode) throw Error(p.stderr.toString()); return p.stdout.toString().trim();
  };
  git("init", "-b", "main"); git("config", "user.name", "Review Test"); git("config", "user.email", "review@example.invalid"); git("config", "commit.gpgsign", "false");
  await writeFile(join(repo, "code.txt"), "before\n"); git("add", "."); git("commit", "-m", "base"); const base = git("rev-parse", "HEAD");
  await writeFile(join(repo, "code.txt"), "after\n"); git("commit", "-am", "candidate");
  const binary = join(root, "codex");
  await writeFile(binary, `#!${process.execPath}
const args=process.argv.slice(2);
if(args[0]==="--version"){if(process.env.REVIEW_TEST_DIRTY_BEFORE) await Bun.write(process.env.REVIEW_TEST_DIRTY_BEFORE,"changed before launch");console.log("codex test");process.exit(0);}
await Bun.write(process.env.REVIEW_TEST_ARGS,JSON.stringify(args));
console.log("private progress that must not reach caller");
if(process.env.REVIEW_TEST_DELAY) await Bun.sleep(Number(process.env.REVIEW_TEST_DELAY));
if(process.env.REVIEW_TEST_DIRTY) await Bun.write("code.txt","concurrent edit");
if(process.env.REVIEW_TEST_FAIL) process.exit(2);
if(!process.env.REVIEW_TEST_EMPTY) await Bun.write(args[args.indexOf("-o")+1],"Native review report with findings.");
`); await chmod(binary, 0o755);
  const config = join(root, ".config/skizzles/request-review/config.toml"); await mkdir(join(root, ".config/skizzles/request-review"), { recursive: true });
  const configText = `model = "gpt-6-astra"\nreasoning_effort = "low"\ntimeout_seconds = 5\ncodex_binary = ${JSON.stringify(binary)}\n`;
  await writeFile(config, configText);
  const env = { ...process.env, HOME: root, REVIEW_TEST_ARGS: join(root, "args.json"), SKIZZLES_REVIEW_ACTIVE: "0" };
  const start = (args: string[], extra: Record<string, string> = {}) => Bun.spawn([process.execPath, runner, ...args], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
  const run = async (args = ["run", "--cwd", repo, "--base", base], extra: Record<string, string> = {}) => {
    const p = start(args, extra); const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, out, err, result: JSON.parse(out) };
  };
  return { root, repo, base, config, configText, git, start, run };
}

test("native review uses operator settings, exact refs, no custom prompt, and caches final reports", async () => {
  const f = await fixture(); const first = await f.run();
  expect(first.code).toBe(0); expect(first.result.status).toBe("completed"); expect(first.out).not.toContain("private progress");
  const args = JSON.parse(await readFile(join(f.root, "args.json"), "utf8")) as string[];
  expect(args.slice(-3)).toEqual(["review", "--base", f.base]);
  expect(args).toContain('review_model="gpt-6-astra"'); expect(args).toContain('model_reasoning_effort="low"');
  expect(args).toContain("--ignore-user-config"); expect(args).toContain("read-only");
  const second = await f.run(undefined, { REVIEW_TEST_FAIL: "1" });
  expect(second.code).toBe(0); expect(second.result.cached).toBe(true); expect(second.result.report).toBe(first.result.report);
  expect((await f.run(["result", first.result.id])).result.report).toBe(first.result.report);
  expect(await readFile(f.config, "utf8")).toBe(f.configText);
});

test("failure requires explicit retry and no empty output is accepted", async () => {
  const f = await fixture(); expect((await f.run(undefined, { REVIEW_TEST_FAIL: "1" })).code).toBe(1);
  expect((await f.run()).result.cached).toBe(true);
  const args = ["run", "--cwd", f.repo, "--base", f.base, "--rerun"];
  expect((await f.run(args, { REVIEW_TEST_EMPTY: "1" })).code).toBe(1);
  expect((await f.run(args)).result.status).toBe("completed");
});

test("dirty, empty, historical-commit and override requests fail before model work", async () => {
  const f = await fixture();
  for (const args of [["--base", "HEAD"], ["--commit", f.base], ["--base", f.base, "--model", "other"], ["--base", f.base, "--prompt", "bias"]]) {
    expect((await f.run(["run", "--cwd", f.repo, ...args])).code).toBe(1);
  }
  expect((await f.run(undefined, { SKIZZLES_REVIEW_ACTIVE: "1" })).result.error).toContain("Recursive");
  await writeFile(join(f.repo, "untracked.txt"), "change"); expect((await f.run()).result.error).toContain("clean committed");
  expect(await Bun.file(join(f.root, "args.json")).exists()).toBe(false);
});

test("commit selection works and concurrent edits make a review stale", async () => {
  const f = await fixture();
  const out = await f.run(["run", "--cwd", f.repo, "--commit", "HEAD"], { REVIEW_TEST_DIRTY: "1" });
  expect(out.code).toBe(1); expect(out.result.status).toBe("stale"); expect(out.result.report).toContain("Native review");
});

test("workspace gate rejects overlapping reviews", async () => {
  const f = await fixture(); const p = f.start(["run", "--cwd", f.repo, "--base", f.base], { REVIEW_TEST_DELAY: "400" });
  for (let i = 0; i < 500 && !await Bun.file(join(f.root, "args.json")).exists(); i++) await Bun.sleep(10);
  expect((await f.run()).result.error).toContain("already active");
  expect(await p.exited).toBe(0);
});

test("timeout is failure and operator settings invalidate the cache", async () => {
  const f = await fixture(); const first = await f.run();
  await writeFile(f.config, f.configText.replace('"low"', '"medium"').replace('= 5', '= 1'));
  const timed = await f.run(undefined, { REVIEW_TEST_DELAY: "3000" });
  expect(timed.code).toBe(1); expect(timed.result.error).toContain("timed out"); expect(timed.result.id).not.toBe(first.result.id);
}, 10000);


test("pre-launch mutation finalizes failure and permits explicit recovery", async () => {
  const f = await fixture();
  const failed = await f.run(undefined, { REVIEW_TEST_DIRTY_BEFORE: join(f.repo, "code.txt") });
  expect(failed.code).toBe(1); expect(failed.result.status).toBe("failed");
  expect(await Bun.file(join(f.root, "args.json")).exists()).toBe(false);
  f.git("restore", "code.txt");
  const recovered = await f.run(["run", "--cwd", f.repo, "--base", f.base, "--rerun"]);
  expect(recovered.code).toBe(0); expect(recovered.result.status).toBe("completed");
});
