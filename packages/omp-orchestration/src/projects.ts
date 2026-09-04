import { constants } from "node:fs";
import { copyFile, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { ServiceError, type Project } from "./protocol.ts";
import { checkedCommand } from "./process.ts";
import { OrchestrationState } from "./state.ts";

export interface RegisterProjectInput {
  id?: string;
  name?: string;
  cwd: string;
  baseBranch?: string;
  model?: string;
  thinking?: string;
  autoPublish?: boolean;
}

export class ProjectRegistry {
  constructor(private readonly state: OrchestrationState) {}

  list(): Project[] { return this.state.projects(); }

  async register(input: RegisterProjectInput): Promise<Project> {
    const requested = validateAbsolutePath(input.cwd);
    const canonical = await realpath(requested);
    if (!(await stat(canonical)).isDirectory()) throw new ServiceError("project cwd is not a directory", "invalid_project");
    const cwd = await checkedCommand(["git", "rev-parse", "--show-toplevel"], { cwd: canonical });
    const root = await realpath(cwd);
    await assertApfsClone(root);
    const remote = await optionalGit(root, ["remote", "get-url", "origin"]);
    const baseBranch = input.baseBranch?.trim() || await discoverBaseBranch(root);
    validateBranch(baseBranch);
    try { await checkedCommand(["git", "check-ref-format", "--branch", baseBranch], { cwd: root }); }
    catch { throw new ServiceError("base branch is not a valid Git branch name", "invalid_project"); }
    const id = input.id?.trim() || slug(basename(root));
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(id)) {
      throw new ServiceError("project id must use lowercase letters, numbers, dots, dashes, or underscores", "invalid_project");
    }
    const name = input.name?.trim() || basename(root);
    if (!name || name.length > 120 || /[\0\r\n]/.test(name)) throw new ServiceError("project name is invalid", "invalid_project");
    const autoPublish = input.autoPublish ?? true;
    if (autoPublish && !isRemoteCloneUrl(remote)) {
      throw new ServiceError("auto-publish requires an SSH or HTTPS origin remote", "invalid_project");
    }
    return this.state.saveProject({
      id,
      name,
      cwd: root,
      remote,
      baseBranch,
      model: input.model?.trim() || null,
      thinking: input.thinking?.trim() || null,
      autoPublish,
      enabled: true,
    });
  }
}

async function optionalGit(cwd: string, args: string[]): Promise<string | null> {
  try { return await checkedCommand(["git", ...args], { cwd }); } catch { return null; }
}

async function discoverBaseBranch(cwd: string): Promise<string> {
  const remoteHead = await optionalGit(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead?.startsWith("origin/")) return remoteHead.slice("origin/".length);
  return await checkedCommand(["git", "branch", "--show-current"], { cwd }) || "main";
}

function validateAbsolutePath(value: string): string {
  if (!value.trim() || !value.startsWith("/") || /[\0\r\n]/.test(value)) {
    throw new ServiceError("project cwd must be an absolute path", "invalid_project");
  }
  return resolve(value);
}

function validateBranch(value: string): void {
  if (!value || value.length > 255 || /[\0\r\n]/.test(value) || value.startsWith("-") || value.includes("..")) {
    throw new ServiceError("base branch is invalid", "invalid_project");
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").slice(0, 64) || "project";
}

function isRemoteCloneUrl(value: string | null): boolean {
  if (!value) return false;
  return /^(?:https?|ssh|git):\/\/[^\s]+$/.test(value) || /^[^\s/@:]+@[^\s/:]+:.+$/.test(value);
}

async function assertApfsClone(cwd: string): Promise<void> {
  if (process.platform !== "darwin") throw new ServiceError("APFS task isolation requires macOS", "invalid_project");
  const gitDirectory = await checkedCommand(["git", "rev-parse", "--git-dir"], { cwd });
  const probe = await mkdtemp(join(isAbsolute(gitDirectory) ? gitDirectory : resolve(cwd, gitDirectory), "skizzles-apfs-probe-"));
  try {
    const source = join(probe, "source");
    await Bun.write(source, "apfs clone probe\n");
    await copyFile(source, join(probe, "clone"), constants.COPYFILE_FICLONE_FORCE);
  } catch (error) {
    throw new ServiceError(`project checkout does not support APFS copy-on-write clones: ${error instanceof Error ? error.message : String(error)}`, "invalid_project");
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}
