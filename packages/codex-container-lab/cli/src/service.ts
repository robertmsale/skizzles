import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadLabConfig } from "./config";
import { internalImageTag } from "./compose";
import {
  cleanupLabLabels,
  defaultDockerRunner,
  destroyLabStack,
  dockerAvailable,
  launchDockerRun,
  prepareLabRuntime,
  provisionLabStack,
  runtimeFromLab,
  stackLogs,
  stackStatus,
  terminateDockerRun,
  type DockerRunner,
} from "./docker";
import { removeIfPresent } from "./files";
import { withFileLock } from "./locks";
import { runCommand } from "./process";
import { redactPublicText } from "./public-output";
import {
  ensureOwner,
  assertReadyLabFilesystem,
  expectedLabRuntimeRoot,
  labManifestPath,
  listLabs,
  ownerDirectory,
  ownerLockPath,
  ownerRuntimeDirectory,
  readLab,
  readReapedOwner,
  removeLabState,
  resolveRoots,
  writeLab,
  type StateRoots,
} from "./state";
import { applySync, initializeSyncBaseline, previewSync, publicSyncPreview, recoverSyncTransactions, type SyncDirection } from "./sync";
import type { LabMetadata } from "./types";

export type RunOutput = {
  stdout: (chunk: Buffer) => void;
  stderr: (chunk: Buffer) => void;
  stdin?: NodeJS.ReadableStream;
};

export class ContainerLabService {
  readonly owner: string;
  readonly roots: StateRoots;
  constructor(
    owner: string,
    roots = resolveRoots(),
    private readonly docker: DockerRunner = defaultDockerRunner,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.owner = owner;
    this.roots = roots;
  }

  async health(): Promise<{ ok: true; dockerAvailable: boolean; labs: number }> {
    await this.reconcileOwner();
    const labs = await listLabs(this.roots, this.owner);
    const secretEnvironment = [...new Set(labs.flatMap((lab) => lab.secretEnvironment))];
    return {
      ok: true,
      dockerAvailable: await dockerAvailable(this.docker, secretEnvironment, this.environment).catch(() => false),
      labs: labs.length,
    };
  }

  async createLab(name = "lab", source = process.cwd(), signal?: AbortSignal): Promise<{ labId: string; state: LabMetadata["state"] }> {
    const requested = name.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(requested)) {
      throw new Error("name must use 1..32 lowercase letters, numbers, or hyphens");
    }
    return await withFileLock(this.ownerLock(), async () => {
      if (await readReapedOwner(this.roots.stateRoot, this.owner)) {
        throw new Error("owner was archived and reaped; refusing to recreate its resources");
      }
      await ensureOwner(this.roots.stateRoot, this.owner);
      await this.reconcileOwner();
      const existing = await listLabs(this.roots, this.owner);
      if (existing.length >= 8) throw new Error("an owner may have at most 8 labs");
      const sourceRoot = (await runCommand("git", ["-C", source, "rev-parse", "--show-toplevel"], { timeoutMs: 10_000 })).stdout.toString().trim();
      const commonGit = (await runCommand("git", ["-C", sourceRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeoutMs: 10_000 })).stdout.toString().trim();
      const repoHash = createHash("sha256").update(await realpath(commonGit)).digest("hex").slice(0, 12);
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
      const id = `${requested}-${suffix}`;
      const runtimeRoot = join(ownerRuntimeDirectory(this.roots.runtimeRoot, this.owner), id);
      const lab: LabMetadata = {
        version: 1,
        id,
        name: requested,
        owner: this.owner,
        ownerKey: createHash("sha256").update(this.owner).digest("hex"),
        repoHash,
        composeProject: `ccl-${repoHash.slice(0, 8)}-${suffix}`,
        state: "provisioning",
        sourceRoot,
        runtimeRoot,
        workspace: join(runtimeRoot, "workspace"),
        manifestPath: join(sourceRoot, ".codex-container-lab.yaml"),
        commandService: "pending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        endpoints: [],
        findings: [],
        secretEnvironment: [],
      };
      await withFileLock(this.labLock(id), async () => await writeLab(this.roots, lab));
      await this.provisionLab(id, signal);
      const final = await readLab(this.roots, this.owner, id);
      return { labId: final.id, state: final.state };
    });
  }

  async listLabs(): Promise<{ labs: Array<{ labId: string; name: string; state: LabMetadata["state"]; updatedAt: string }> }> {
    await this.reconcileOwner();
    const labs = await listLabs(this.roots, this.owner);
    return { labs: labs.map((lab) => ({ labId: lab.id, name: lab.name, state: lab.state, updatedAt: lab.updatedAt })) };
  }

  async labStatus(id: string): Promise<unknown> {
    await this.reconcileOwner();
    const lab = await readLab(this.roots, this.owner, id);
    return compactLabStatus(lab, lab.state === "ready" && lab.runtime
        ? await stackStatus(runtimeFromLab(lab), this.docker)
        : undefined);
  }

  async run(
    id: string,
    argv: string[],
    cwd = ".",
    environment: Record<string, string> = {},
    timeoutSeconds = 1800,
    output: RunOutput,
    signal?: AbortSignal,
  ): Promise<number> {
    validateRun(argv, cwd, environment, timeoutSeconds);
    await this.reconcileOwner();
    try { return await withFileLock(this.activityLock(id), async () => {
      if (signal?.aborted) return signal.reason === "SIGINT" ? 130 : signal.reason === "SIGTERM" ? 143 : 124;
      const lab = await this.requireReady(id);
      const runtime = runtimeFromLab(lab);
      for (const key of Object.keys(environment)) {
        if (!runtime.config.forwardEnvironment.includes(key)) throw new Error(`run environment is not declared by the manifest: ${key}`);
      }
      const identity = { runId: crypto.randomUUID(), cwd, argv, environment };
      const child = launchDockerRun(runtime, identity, this.docker, this.environment);
      child.stdout.on("data", output.stdout);
      child.stderr.on("data", output.stderr);
      output.stdin?.pipe(child.stdin);
      let requestedExit: number | undefined;
      let stopping: Promise<void> | undefined;
      const stop = (exitCode: number, first: "INT" | "TERM") => {
        requestedExit ??= exitCode;
        if (!stopping) stopping = (async () => {
          for (let attempt = 0; attempt < 20; attempt++) {
            const result = await terminateDockerRun(runtime, identity, first, this.docker);
            if (result.confirmed) break;
            if (!result.confirmed && result.status !== "unavailable") break;
            await Bun.sleep(100);
          }
          await Promise.race([onceClosed(child), Bun.sleep(2_000)]);
          if (child.exitCode === null) {
            try {
              const final = await terminateDockerRun(runtime, identity, "KILL", this.docker);
              if (!final.confirmed) {
                await destroyLabStack(runtime, this.docker);
                await withFileLock(this.labLock(id), async () => {
                  const current = await readLab(this.roots, this.owner, id);
                  if (current.state === "ready") {
                    current.state = "failed";
                    current.error = "attached command identity became uncertain; the exact lab stack was removed and must be recreated";
                    current.updatedAt = new Date().toISOString();
                    await writeLab(this.roots, current);
                  }
                });
              }
            } finally {
              child.kill("SIGKILL");
            }
          }
        })();
      };
      const onAbort = () => stop(signal?.reason === "SIGINT" ? 130 : signal?.reason === "SIGTERM" ? 143 : 124,
        signal?.reason === "SIGINT" ? "INT" : "TERM");
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const timeout = timeoutSeconds > 0 ? setTimeout(() => stop(124, "TERM"), timeoutSeconds * 1000) : undefined;
      try {
        const code = await onceClosed(child);
        if (stopping) await stopping;
        return requestedExit ?? code;
      } finally {
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        output.stdin?.unpipe(child.stdin);
      }
    }, { attempts: 600, delayMs: 50, signal }); }
    catch (error) {
      if (signal?.aborted) return signal.reason === "SIGINT" ? 130 : signal.reason === "SIGTERM" ? 143 : 124;
      throw error;
    }
  }

  async logs(id: string, service: string, tailLines: number): Promise<unknown> {
    await this.reconcileOwner();
    const lab = await this.requireReady(id);
    const transcript = await stackLogs(runtimeFromLab(lab), service, tailLines, this.docker);
    return { labId: id, service, transcript: { ...transcript, bytes: Buffer.byteLength(transcript.text), lines: transcript.text ? transcript.text.split("\n").length : 0 } };
  }

  async preview(id: string, direction: SyncDirection) {
    await this.reconcileOwner();
    return await withFileLock(this.activityLock(id), async () => {
      const lab = await this.requireReady(id);
      await assertSourceRepositoryIdentity(lab);
      const sourceRoot = direction === "push" ? lab.sourceRoot : lab.workspace;
      const targetRoot = direction === "push" ? lab.workspace : lab.sourceRoot;
      const preview = await previewSync({ stateRoot: lab.runtimeRoot, labId: lab.id, direction, sourceRoot, targetRoot, maxEntries: 100 });
      return publicSyncPreview(preview, id, direction);
    }, { attempts: 600, delayMs: 50 });
  }

  async apply(id: string, direction: SyncDirection, token: string) {
    await this.reconcileOwner();
    return await withFileLock(this.activityLock(id), async () => {
      return await withFileLock(this.labLock(id), async () => {
        const lab = await this.requireReady(id);
        await assertSourceRepositoryIdentity(lab);
        const sourceRoot = direction === "push" ? lab.sourceRoot : lab.workspace;
        const targetRoot = direction === "push" ? lab.workspace : lab.sourceRoot;
        const result = await applySync({ stateRoot: lab.runtimeRoot, labId: lab.id, direction, token, sourceRoot, targetRoot,
          idleGuard: () => true });
        return { labId: id, direction, applied: result.applied };
      }, { attempts: 600, delayMs: 50 });
    }, { attempts: 600, delayMs: 50 });
  }

  async destroyLab(id: string): Promise<{ labId: string; destroyed: boolean }> {
    let claimed: LabMetadata | undefined;
    const exists = await withFileLock(this.labLock(id), async () => {
      let lab: LabMetadata;
      try { lab = await readLab(this.roots, this.owner, id); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      await this.assertDestroyFilesystem(lab);
      lab.state = "destroying";
      lab.updatedAt = new Date().toISOString();
      await writeLab(this.roots, lab);
      claimed = lab;
      return true;
    }, { attempts: 600, delayMs: 50 });
    if (!exists || !claimed) return { labId: id, destroyed: false };
    if (claimed.runtime) await destroyLabStack(runtimeFromLab(claimed), this.docker);
    else await cleanupLabLabels(claimed, claimed.modeKind === "dockerfile", this.docker, this.environment);
    return await withFileLock(this.activityLock(id), async () => await withFileLock(this.labLock(id), async () => {
      let lab: LabMetadata;
      try { lab = await readLab(this.roots, this.owner, id); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { labId: id, destroyed: false };
        throw error;
      }
      const runtimePresent = await this.assertDestroyFilesystem(lab);
      await recoverLabSync(this.roots, lab);
      if (lab.runtime) await destroyLabStack(runtimeFromLab(lab), this.docker);
      else await cleanupLabLabels(lab, lab.modeKind === "dockerfile", this.docker, this.environment);
      if (runtimePresent) {
        if (!await exactDirectoryChain(this.roots.runtimeRoot, [lab.ownerKey, lab.id], "lab runtime directory")) {
          throw new Error("lab runtime directory changed during cleanup");
        }
        await removeIfPresent(lab.runtimeRoot, { recursive: true });
      }
      if (!await exactDirectoryChain(this.roots.stateRoot, ["owners", lab.ownerKey], "owner state directory")) {
        throw new Error("owner state directory changed during cleanup");
      }
      await removeLabState(this.roots.stateRoot, this.owner, id);
      return { labId: id, destroyed: true };
    }, { attempts: 600, delayMs: 50 }), { attempts: 600, delayMs: 50 });
  }

  async destroyAll(): Promise<{ destroyed: number }> {
    const ids = (await listLabs(this.roots, this.owner)).map((lab) => lab.id);
    let destroyed = 0;
    for (const id of ids) if ((await this.destroyLab(id)).destroyed) destroyed++;
    return { destroyed };
  }

  private async provisionLab(id: string, signal?: AbortSignal): Promise<void> {
    let lab = await readLab(this.roots, this.owner, id);
    let runtime: Awaited<ReturnType<typeof prepareLabRuntime>> | undefined;
    let dockerMaterializationStarted = false;
    let provisioningEnvironment: NodeJS.ProcessEnv | undefined;
    let secretEnvironmentNames: string[] = [];
    let failure: unknown;
    try {
        await this.assertProvisioning(id, signal);
        await mkdir(lab.runtimeRoot, { recursive: true, mode: 0o700 });
        const config = await loadLabConfig(lab.sourceRoot);
        secretEnvironmentNames = [...config.secretEnvironment];
        lab.manifestPath = config.manifestPath;
        lab.commandService = config.mode.commandService;
        lab.modeKind = config.mode.kind;
        lab.secretEnvironment = secretEnvironmentNames;
        if (config.mode.kind === "dockerfile") lab.managedImage = internalImageTag(lab.ownerKey, lab.id);
        lab = await this.updateProvisioning(id, (current) => {
          current.manifestPath = lab!.manifestPath;
          current.commandService = lab!.commandService;
          current.modeKind = lab!.modeKind;
          current.secretEnvironment = [...lab!.secretEnvironment];
          current.managedImage = lab!.managedImage;
        });
        provisioningEnvironment = resolveProvisioningEnvironment(secretEnvironmentNames, this.environment);
        await this.assertProvisioning(id, signal);
        const head = (await runCommand("git", ["-C", lab.sourceRoot, "rev-parse", "HEAD"], { timeoutMs: 10_000, signal })).stdout.toString().trim();
        await runCommand("git", ["clone", "--no-checkout", "--no-tags", "--no-hardlinks", lab.sourceRoot, lab.workspace], { timeoutMs: 120_000, signal });
        await runCommand("git", ["-C", lab.workspace, "remote", "remove", "origin"], { timeoutMs: 10_000, signal });
        await runCommand("git", ["-C", lab.workspace, "checkout", "--detach", head], { timeoutMs: 120_000, signal });
        await this.assertProvisioning(id, signal);
        const identity = { stateRoot: lab.runtimeRoot, labId: lab.id };
        await initializeSyncBaseline(identity, lab.workspace);
        const seed = await previewSync({
          ...identity,
          direction: "push",
          sourceRoot: lab.sourceRoot,
          targetRoot: lab.workspace,
        });
        if (seed.conflicts.length) throw new Error("initial workspace synchronization unexpectedly conflicted");
        await applySync({
          ...identity,
          direction: "push",
          token: seed.token,
          sourceRoot: lab.sourceRoot,
          targetRoot: lab.workspace,
          idleGuard: () => true,
        });
        await recoverSyncTransactions({
          ...identity,
          allowedTargetRoots: [lab.sourceRoot, lab.workspace],
        });
        await this.assertProvisioning(id, signal);
        dockerMaterializationStarted = true;
        runtime = await prepareLabRuntime(lab, config, this.docker, provisioningEnvironment);
        lab.findings = runtime.findings;
        lab.runtime = {
          config: runtime.config,
          composeArgs: runtime.composeArgs,
          baseFile: runtime.baseFile,
          overrideFile: runtime.overrideFile,
          findings: runtime.findings,
        };
        lab = await this.updateProvisioning(id, (current) => {
          current.findings = lab!.findings;
          current.runtime = lab!.runtime;
        });
        await this.assertProvisioning(id, signal);
        lab.endpoints = await provisionLabStack(runtime, signal, this.docker, provisioningEnvironment);
        await this.assertProvisioning(id, signal);
      } catch (error) {
        failure = error;
        if (runtime) await destroyLabStack(runtime, this.docker).catch(() => undefined);
        else if (dockerMaterializationStarted) await cleanupLabLabels(
          lab,
          lab.modeKind === "dockerfile",
          this.docker,
          provisioningEnvironment,
        ).catch(() => undefined);
      }
    await withFileLock(this.labLock(id), async () => {
      let current: LabMetadata;
      try { current = await readLab(this.roots, this.owner, id); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (current.state !== "provisioning") return;
      current = { ...current, ...lab };
      current.state = failure ? "failed" : "ready";
      current.error = failure ? compactError(failure) : undefined;
      current.updatedAt = new Date().toISOString();
      await writeLab(this.roots, current);
    }, { attempts: 600, delayMs: 50 });
  }

  private async requireReady(id: string): Promise<LabMetadata> {
    const lab = await readLab(this.roots, this.owner, id);
    if (lab.state !== "ready") throw new Error(`lab is not ready: ${lab.state}`);
    return lab;
  }

  private async assertProvisioning(id: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("lab provisioning was cancelled");
    const current = await readLab(this.roots, this.owner, id);
    if (current.state !== "provisioning") throw new Error("lab provisioning was cancelled");
  }

  private async updateProvisioning(id: string, mutate: (lab: LabMetadata) => void): Promise<LabMetadata> {
    return await withFileLock(this.labLock(id), async () => {
      const current = await readLab(this.roots, this.owner, id);
      if (current.state !== "provisioning") throw new Error("lab provisioning was cancelled");
      mutate(current);
      current.updatedAt = new Date().toISOString();
      await writeLab(this.roots, current);
      return current;
    }, { attempts: 600, delayMs: 50 });
  }

  private async reconcileOwner(): Promise<void> {
    const labs = await listLabs(this.roots, this.owner);
    for (const snapshot of labs) {
      let lab = snapshot;
      if (lab.state === "ready") {
        const unavailable = await readyRuntimeProblem(this.roots, lab);
        if (unavailable) lab = await this.failReadyLab(lab, unavailable);
      }
    }
  }

  private async failReadyLab(snapshot: LabMetadata, problem: string): Promise<LabMetadata> {
    return await withFileLock(this.labLock(snapshot.id), async () => {
      const current = await readLab(this.roots, this.owner, snapshot.id);
      if (current.state !== "ready") return current;
      const stillUnavailable = await readyRuntimeProblem(this.roots, current);
      if (!stillUnavailable) return current;
      current.state = "failed";
      current.error = `${problem}; the disposable runtime was lost and the lab must be destroyed and recreated`;
      current.updatedAt = new Date().toISOString();
      await writeLab(this.roots, current);
      return current;
    });
  }


  private async assertDestroyFilesystem(lab: LabMetadata): Promise<boolean> {
    if (!await exactDirectoryChain(this.roots.stateRoot, ["owners", lab.ownerKey], "owner state directory")) {
      throw new Error("owner state directory is missing or unsafe");
    }
    const runtimePresent = await exactDirectoryChain(
      this.roots.runtimeRoot, [lab.ownerKey, lab.id], "lab runtime directory",
    );
    if (runtimePresent) {
      await exactDirectoryChain(
        this.roots.runtimeRoot, [lab.ownerKey, lab.id, "workspace"], "lab workspace",
      );
    }
    return runtimePresent;
  }

  private ownerLock(): string {
    return ownerLockPath(this.roots.stateRoot, this.owner);
  }

  private labLock(id: string): string {
    return join(ownerDirectory(this.roots.stateRoot, this.owner), ".locks", `lab-${id}`);
  }

  private activityLock(id: string): string {
    return join(ownerDirectory(this.roots.stateRoot, this.owner), ".locks", `activity-${id}`);
  }

}

async function exactDirectoryChain(root: string, segments: string[], label: string): Promise<boolean> {
  let path = resolve(root);
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`configured ${label} contains unsafe indirection`);
  let expected = await realpath(path);
  for (const segment of segments) {
    path = join(path, segment);
    expected = join(expected, segment);
    try { info = await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== expected) {
      throw new Error(`${label} contains unsafe indirection`);
    }
  }
  return true;
}

export async function recoverLabSync(roots: StateRoots, lab: LabMetadata): Promise<void> {
  if (lab.runtimeRoot !== expectedLabRuntimeRoot(roots, lab.owner, lab.id) || lab.workspace !== join(lab.runtimeRoot, "workspace")) {
    throw new Error("lab runtime containment is invalid");
  }
  try {
    if (!(await stat(lab.workspace)).isDirectory()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const journalDirectory = join(lab.runtimeRoot, "sync", lab.id, "journals");
  let journals: string[];
  try { journals = await readdir(journalDirectory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (journals.length === 0) return;
  await assertSourceRepositoryIdentity(lab);
  await recoverSyncTransactions({
    stateRoot: lab.runtimeRoot,
    labId: lab.id,
    allowedTargetRoots: [lab.sourceRoot, lab.workspace],
  });
}

async function readyRuntimeProblem(roots: StateRoots, lab: LabMetadata): Promise<string | undefined> {
  try {
    await assertReadyLabFilesystem(roots, lab);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "runtime or workspace is missing";
    return error instanceof Error ? error.message : String(error);
  }
}

async function assertSourceRepositoryIdentity(lab: LabMetadata): Promise<void> {
  const commonGit = (await runCommand("git", [
    "-C", lab.sourceRoot, "rev-parse", "--path-format=absolute", "--git-common-dir",
  ], { timeoutMs: 10_000 })).stdout.toString().trim();
  const actual = createHash("sha256").update(await realpath(commonGit)).digest("hex").slice(0, 12);
  if (actual !== lab.repoHash) throw new Error("lab source repository identity no longer matches durable state");
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n").slice(-8).join("\n").slice(-4000);
}

function resolveProvisioningEnvironment(names: readonly string[], environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resolved = { ...environment };
  for (const name of names) {
    delete resolved[name];
    if (!Object.hasOwn(environment, name) || typeof environment[name] !== "string") {
      throw new Error(`secret environment variable is unavailable: ${name}`);
    }
    resolved[name] = environment[name];
  }
  return resolved;
}

function compactLabStatus(lab: LabMetadata, stack: unknown): unknown {
  const endpoints = lab.endpoints.slice(0, 8).map((endpoint) => ({
    name: endpoint.name.slice(0, 128), service: endpoint.service.slice(0, 128), target: endpoint.target, url: endpoint.url.slice(0, 256),
  }));
  const findings = lab.findings.slice(0, 12).map((finding) => ({
    ...(finding.service ? { service: finding.service.slice(0, 128) } : {}), surface: finding.surface, detail: finding.detail.slice(0, 256),
  }));
  return {
    labId: lab.id,
    name: lab.name,
    state: lab.state,
    updatedAt: lab.updatedAt,
    ...(endpoints.length ? { endpoints, endpointCount: lab.endpoints.length } : {}),
    ...(findings.length ? { findings, findingCount: lab.findings.length } : {}),
    ...(lab.error ? { error: publicError(lab.error) } : {}),
    ...(stack ? { stack } : {}),
  };
}

function publicError(value: string): string {
  return redactPublicText(value, 2_000, 6);
}

function validateRun(argv: string[], cwd: string, environment: Record<string, string>, timeoutSeconds: number): void {
  if (argv.length === 0 || argv.length > 256 || argv.some((arg) => arg.includes("\0")) ||
      Buffer.byteLength(argv.join("\0")) > 64 * 1024) throw new Error("run argv must contain 1..256 bounded arguments");
  if (cwd.includes("\0") || cwd !== "." && (cwd.startsWith("/") || cwd.split(/[\\/]/).includes(".."))) {
    throw new Error("run cwd must be a relative path inside the workspace");
  }
  const entries = Object.entries(environment);
  if (entries.length > 64 || entries.some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) ||
      Buffer.byteLength(JSON.stringify(environment)) > 64 * 1024) throw new Error("run environment is invalid or exceeds 64 KiB");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 7200) {
    throw new Error("timeout-seconds must be 0..7200");
  }
}

function onceClosed(child: ReturnType<DockerRunner["spawn"]>): Promise<number> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}
