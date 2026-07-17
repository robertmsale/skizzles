import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { harnessReceiptPath } from "./harness";
import { skillsReceiptPath } from "./core";
import { uninstallHarness } from "./harness";
import { uninstallSkills } from "./core";

interface ContainerLabContract {
  configuredRuntime: string;
  binaries: { operational: string; reaper: string };
  execution: { adminMaxBytes: number };
}

function contract(descriptorPath?: string): ContainerLabContract {
  const path = descriptorPath ?? resolve(import.meta.dir, "../../../integrations/container-lab.json");
  const value = JSON.parse(readFileSync(path, "utf8")) as ContainerLabContract;
  if (!value.configuredRuntime || !value.binaries?.operational || !value.binaries?.reaper || !Number.isSafeInteger(value.execution?.adminMaxBytes) || value.execution.adminMaxBytes <= 0) {
    throw new Error("Skizzles Container Lab descriptor is invalid");
  }
  return value;
}

export interface ContainerLabDoctor {
  installed: boolean;
  compatible: boolean;
  ready: boolean;
  version: string;
  dockerAvailable?: boolean;
  reason?: string;
}

export interface DoctorReport {
  ok: boolean;
  installs: { skills: "absent" | "healthy" | "drifted"; harness: "absent" | "healthy" | "drifted" };
  containerLab: ContainerLabDoctor;
}

function executable(name: string, pathValue: string): string | undefined {
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

function adminJson(
  executablePath: string,
  args: string[],
  environment: Record<string, string>,
  maximumBytes: number,
  timeoutMs: number,
): Record<string, unknown> {
  const result = Bun.spawnSync({
    cmd: [executablePath, ...args],
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    maxBuffer: maximumBytes + 1,
  });
  const output = result.stdout.toString();
  const errorOutput = result.stderr.toString();
  if (Buffer.byteLength(output, "utf8") > maximumBytes || Buffer.byteLength(errorOutput, "utf8") > maximumBytes) {
    throw new Error("external command exceeded its public output limit");
  }
  if (result.signalCode !== undefined && result.signalCode !== null) throw new Error("external command exceeded its time or output limit");
  if (result.exitCode !== 0) throw new Error("external command failed");
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error("external command did not return one JSON record");
  const value = JSON.parse(lines[0]!) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("external command returned invalid JSON");
  return value as Record<string, unknown>;
}

export function doctorContainerLab(pathValue = process.env.PATH ?? "", descriptorPath?: string, timeoutMs = 5_000): ContainerLabDoctor {
  const descriptor = contract(descriptorPath);
  const operational = executable(descriptor.binaries.operational, pathValue);
  const reaper = executable(descriptor.binaries.reaper, pathValue);
  const base = { version: `configured-${descriptor.configuredRuntime}-unverified` };
  if (!operational || !reaper) return { ...base, installed: false, compatible: false, ready: false, reason: "required Container Lab binaries are missing" };

  const root = mkdtempSync(join(tmpdir(), "skizzles-container-lab-doctor-"));
  try {
    const environment = { PATH: pathValue, HOME: join(root, "home") };
    const help = adminJson(operational, ["--help"], environment, descriptor.execution.adminMaxBytes, timeoutMs);
    const reaperHelp = adminJson(reaper, ["--help"], environment, descriptor.execution.adminMaxBytes, timeoutMs);
    if (typeof help.help !== "string" || !help.help.includes("run --lab") ||
        typeof reaperHelp.help !== "string" || !reaperHelp.help.includes("codex-container-lab-reaper")) {
      return { ...base, installed: true, compatible: false, ready: false, reason: "Container Lab command fingerprint did not match" };
    }
    const health = adminJson(operational, [
      "--owner", `skizzles-doctor-${crypto.randomUUID()}`,
      "--state-root", join(root, "state"),
      "--runtime-root", join(root, "runtime"),
      "health",
    ], environment, descriptor.execution.adminMaxBytes, timeoutMs);
    if (health.ok !== true || typeof health.dockerAvailable !== "boolean" || typeof health.labs !== "number") {
      return { ...base, installed: true, compatible: false, ready: false, reason: "Container Lab health contract did not match" };
    }
    return {
      ...base,
      installed: true,
      compatible: true,
      ready: health.dockerAvailable,
      dockerAvailable: health.dockerAvailable,
      ...(!health.dockerAvailable ? { reason: "installed but Docker is not ready" } : {}),
    };
  } catch (error) {
    const reason = error instanceof SyntaxError ? "Container Lab returned malformed JSON" :
      error instanceof Error ? error.message : "Container Lab doctor failed";
    return { ...base, installed: true, compatible: false, ready: false, reason };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function doctor(home: string, codexHome: string, pathValue = process.env.PATH ?? ""): DoctorReport {
  const containerLab = doctorContainerLab(pathValue);
  let skills: DoctorReport["installs"]["skills"] = "absent";
  let harness: DoctorReport["installs"]["harness"] = "absent";
  if (existsSync(skillsReceiptPath(codexHome))) {
    try { uninstallSkills(codexHome, true); skills = "healthy"; } catch { skills = "drifted"; }
  }
  if (existsSync(harnessReceiptPath(home))) {
    try { uninstallHarness(home, true); harness = "healthy"; } catch { harness = "drifted"; }
  }
  return {
    ok: (skills === "healthy" || harness === "healthy") && skills !== "drifted" && harness !== "drifted",
    installs: { skills, harness },
    containerLab,
  };
}
