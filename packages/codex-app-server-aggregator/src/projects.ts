import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { AggregatorState, type RegisteredProject } from "./state.ts";

export class ProjectRegistry {
  constructor(private readonly state: AggregatorState) {}

  list(): RegisteredProject[] {
    return this.state.projects();
  }

  canonicalCwd(rawCwd: string): Promise<string> {
    return canonicalDirectory(rawCwd);
  }

  async register(rawCwd: string): Promise<RegisteredProject> {
    const cwd = await this.canonicalCwd(rawCwd);
    const root = await git(cwd, "rev-parse", "--show-toplevel");
    if (await realpath(root) !== cwd) throw new Error("project cwd must be the Git checkout root");
    const cloneUrl = await git(cwd, "remote", "get-url", "origin");
    if (!isRemoteCloneUrl(cloneUrl)) {
      throw new Error("project origin must be a container-reachable Git remote");
    }
    return this.state.saveProject({ cwd, cloneUrl });
  }

  async find(rawCwd: string): Promise<RegisteredProject | undefined> {
    const cwd = await canonicalPath(rawCwd);
    return this.state.project(cwd);
  }

  async remove(rawCwd: string): Promise<boolean> {
    const cwd = await canonicalPath(rawCwd);
    return this.state.removeProject(cwd);
  }
}

async function canonicalDirectory(rawPath: string): Promise<string> {
  const path = validatePath(rawPath);
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) throw new Error("project cwd is not a directory");
  return canonical;
}

async function canonicalPath(rawPath: string): Promise<string> {
  const path = validatePath(rawPath);
  try {
    return await realpath(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return path;
    throw error;
  }
}

function validatePath(rawPath: string): string {
  if (!rawPath.trim() || /[\0\r\n]/.test(rawPath)) throw new Error("invalid project cwd");
  if (!rawPath.startsWith("/")) throw new Error("project cwd must be absolute");
  return resolve(rawPath);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `git ${args[0] ?? "command"} failed`);
  const value = stdout.trim();
  if (!value) throw new Error(`git ${args[0] ?? "command"} returned no value`);
  return value;
}

function isRemoteCloneUrl(value: string): boolean {
  if (/^(?:https?|ssh|git):\/\/[^\s]+$/.test(value)) return true;
  return /^[^\s/@:]+@[^\s/:]+:.+$/.test(value);
}
