import { createHash } from "node:crypto";
import { mkdir, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadLabConfig } from "../compose/config";
import { internalImageTag } from "../compose/definition";
import { cleanupLabLabels, destroyLabStack } from "../compose/cleanup";
import { defaultDockerRunner, dockerAvailable, type DockerRunner } from "../compose/docker-runner";
import {
  prepareLabRuntime,
  provisionLabStack,
  runtimeFromLab,
  stackLogs,
  stackStatus,
} from "../compose/runtime";
import { removeIfPresent } from "../storage/files";
import { withFileLock } from "../storage/locks";
import { exactDirectoryChain } from "../storage/safe-path";
import { runCommand } from "../execution/process";
import { compactLabStatus } from "../public/projection";
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
  type Clock, type StateRoots,
} from "../storage/state";
import {
  assertCloneHasNoAlternates,
  assertSourceRepositoryIdentity,
  recoverLabSync,
} from "../workspace/recovery";
import { applySync, initializeSyncBaseline, previewSync, publicSyncPreview, recoverSyncTransactions, type SyncDirection } from "../workspace/sync";
import type { LabMetadata } from "../storage/records";
import { runAttachedCommand, type ActivityHeartbeatScheduler, type RunOutput } from "./attached-workflow";
import { activityNow, refreshLabActivityState, refreshLockedLabActivity, withActivityLock } from "./activity";
import { compactProvisioningError, resolveProvisioningEnvironment } from "./provisioning-policy";

export type { RunOutput } from "./attached-workflow";

export class ContainerLabWorkflow {
  readonly owner: string;
  readonly roots: StateRoots;
  constructor(
    owner: string,
    roots = resolveRoots(),
    private readonly docker: DockerRunner = defaultDockerRunner,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly clock: Clock = () => new Date(),
    private readonly activityHeartbeatMs = 60_000,
    private readonly startActivityHeartbeat?: ActivityHeartbeatScheduler,
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
      const createdAt = activityNow(this.clock).toISOString();
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
        createdAt,
        updatedAt: createdAt,
        lastActivityAt: createdAt,
        endpoints: [],
        findings: [],
        secretEnvironment: [],
      };
      await withFileLock(this.labLock(id), async () => await writeLab(this.roots, lab));
      await this.provisionLab(id, signal);
      const final = await readLab(this.roots, this.owner, id);
      if (final.state === "ready") await this.refreshActivity(id);
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
    return await withActivityLock(this.activityLock(id), async () => {
      const lab = await readLab(this.roots, this.owner, id);
      const status = compactLabStatus(lab, lab.state === "ready" && lab.runtime
          ? await stackStatus(runtimeFromLab(lab), this.docker)
          : undefined);
      await this.refreshActivity(id);
      return status;
    });
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
    return await runAttachedCommand({
      owner: this.owner,
      roots: this.roots,
      docker: this.docker,
      processEnvironment: this.environment,
      labId: id,
      argv,
      cwd,
      environment,
      timeoutSeconds,
      output,
      signal,
      activityLock: this.activityLock(id),
      labLock: this.labLock(id),
      refreshActivity: async () => await this.refreshActivity(id),
      activityHeartbeatMs: this.activityHeartbeatMs,
      startActivityHeartbeat: this.startActivityHeartbeat,
      reconcileOwner: async () => await this.reconcileOwner(),
      requireReady: async () => await this.requireReady(id),
    });
  }

  async logs(id: string, service: string, tailLines: number): Promise<unknown> {
    await this.reconcileOwner();
    return await withActivityLock(this.activityLock(id), async () => {
      const lab = await this.requireReady(id);
      const transcript = await stackLogs(runtimeFromLab(lab), service, tailLines, this.docker);
      await this.refreshActivity(id);
      return { labId: id, service, transcript: { ...transcript, bytes: Buffer.byteLength(transcript.text), lines: transcript.text ? transcript.text.split("\n").length : 0 } };
    });
  }

  async preview(id: string, direction: SyncDirection) {
    await this.reconcileOwner();
    return await withActivityLock(this.activityLock(id), async () => {
      const lab = await this.requireReady(id);
      await assertSourceRepositoryIdentity(lab);
      const sourceRoot = direction === "push" ? lab.sourceRoot : lab.workspace;
      const targetRoot = direction === "push" ? lab.workspace : lab.sourceRoot;
      const preview = await previewSync({ stateRoot: lab.runtimeRoot, labId: lab.id, direction, sourceRoot, targetRoot, maxEntries: 100 });
      await this.refreshActivity(id);
      return publicSyncPreview(preview, id, direction);
    });
  }

  async apply(id: string, direction: SyncDirection, token: string) {
    await this.reconcileOwner();
    return await withActivityLock(this.activityLock(id), async () => {
      return await withFileLock(this.labLock(id), async () => {
        const lab = await this.requireReady(id);
        await assertSourceRepositoryIdentity(lab);
        const sourceRoot = direction === "push" ? lab.sourceRoot : lab.workspace;
        const targetRoot = direction === "push" ? lab.workspace : lab.sourceRoot;
        const result = await applySync({ stateRoot: lab.runtimeRoot, labId: lab.id, direction, token, sourceRoot, targetRoot,
          idleGuard: () => true });
        await refreshLabActivityState(this.roots, this.owner, id, this.clock);
        return { labId: id, direction, applied: result.applied };
      }, { attempts: 600, delayMs: 50 });
    });
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
        await runCommand("git", ["clone", "--no-checkout", "--no-tags", "--no-hardlinks", "--dissociate", lab.sourceRoot, lab.workspace], { timeoutMs: 120_000, signal });
        await assertCloneHasNoAlternates(lab.workspace, signal);
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
      current.error = failure ? compactProvisioningError(failure) : undefined;
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

  private async refreshActivity(id: string): Promise<void> {
    await refreshLockedLabActivity(this.roots, this.owner, id, this.labLock(id), this.clock);
  }

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
