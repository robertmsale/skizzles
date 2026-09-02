import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmpManager } from "../src/manager.ts";
import { checkedCommand } from "../src/process.ts";
import { OrchestrationState } from "../src/state.ts";

const temporaryRoots: string[] = [];
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("OmpManager", () => {
  test("owns one persistent maintainer and records native APFS subagent jobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "skizzles-omp-manager-"));
    temporaryRoots.push(root);
    const repo = join(root, "repo");
    const runtimeRoot = join(root, "runtime");
    await mkdir(repo);
    await checkedCommand(["git", "init", "-b", "main"], { cwd: repo });
    await checkedCommand(["git", "config", "user.name", "Fixture"], { cwd: repo });
    await checkedCommand(["git", "config", "user.email", "fixture@example.test"], { cwd: repo });
    await Bun.write(join(repo, "README.md"), "fixture\n");
    await checkedCommand(["git", "add", "README.md"], { cwd: repo });
    await checkedCommand(["git", "commit", "-m", "fixture"], { cwd: repo });

    const fake = join(root, "omp");
    const promptLog = join(root, "prompts.log");
    await Bun.write(fake, `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nimport { createInterface } from "node:readline";\nconsole.log(JSON.stringify({type:"ready",protocolVersion:1,supportedProtocolVersions:[1,2],maxFrameBytes:1048576,maxReassembledFrameBytes:67108864}));\nconst rl=createInterface({input:process.stdin});\nrl.on("line",line=>{const x=JSON.parse(line);const respond=data=>console.log(JSON.stringify({id:x.id,type:"response",command:x.type,success:true,...(data===undefined?{}:{data})}));if(x.type==="get_state")respond({sessionId:"maintainer-1",sessionFile:"${root}/session.jsonl",isStreaming:false});else if(x.type==="prompt"){appendFileSync(${JSON.stringify(promptLog)},JSON.stringify(x.message)+"\\n");respond({agentInvoked:true});console.log(JSON.stringify({type:"subagent_lifecycle",payload:{id:"agent-7",agent:"worker",agentSource:"bundled",status:"started",index:0,description:"Implement feature"}}));console.log(JSON.stringify({type:"subagent_progress",payload:{agent:"worker",agentSource:"bundled",task:"Implement feature",assignment:"Change code",progress:{id:"agent-7",status:"running"},index:0}}));console.log(JSON.stringify({type:"subagent_lifecycle",payload:{id:"agent-7",agent:"worker",agentSource:"bundled",status:"completed",index:0}}));}else respond();});\n`);
    await chmod(fake, 0o755);

    const state = new OrchestrationState(":memory:");
    const manager = new OmpManager(state, {
      ompBinary: fake,
      projectStateRoot: (id) => join(runtimeRoot, id),
      maintainerPromptPath: join(import.meta.dir, "../prompts/maintainer.md"),
    });
    const project = await manager.registerProject({ id: "fixture", cwd: repo, autoPublish: false });
    expect(project).toMatchObject({ id: "fixture", baseBranch: "main", autoPublish: false });
    expect(state.maintainer("fixture")).toMatchObject({ state: "ready", sessionId: "maintainer-1" });
    await manager.send("fixture", "Please delegate the work");
    await waitUntil(() => state.job("fixture", "agent-7")?.status === "completed");
    expect(state.job("fixture", "agent-7")).toMatchObject({
      status: "completed",
      assignment: "Change code",
      branchName: "omp/task/agent-7",
      baseSha: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    const config = await Bun.file(join(runtimeRoot, "fixture", "maintainer-config.yml")).text();
    expect(config).toContain("mode: apfs");
    expect(config).toContain("apply: false");
    expect(config).toContain("merge: branch");
    const ingress = {
      projectId: "fixture", source: "github", sourceKey: "delivery-1", kind: "issues.opened",
      payload: { issue: 1 }, message: "Assess issue 1",
    };
    const deliveries = await Promise.all([manager.acceptIngress(ingress), manager.acceptIngress(ingress)]);
    expect(deliveries).toEqual([
      { id: 1, duplicate: false, delivered: true },
      { id: 1, duplicate: true, delivered: true },
    ]);
    expect((await readFile(promptLog, "utf8")).trim().split("\n")).toHaveLength(2);
    await manager.stopProject("fixture");
    expect(state.project("fixture")?.enabled).toBe(false);
    expect(manager.send("fixture", "must stay stopped")).rejects.toThrow("project is stopped");
    await manager.stop();
    state.close();
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`condition was not met within ${timeoutMs}ms`);
    await Bun.sleep(20);
  }
}
