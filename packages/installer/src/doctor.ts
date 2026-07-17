import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { harnessReceiptPath } from "./harness";
import { skillsReceiptPath } from "./core";

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
  installs: { skillsReceipt: boolean; harnessReceipt: boolean };
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

function adminJson(executablePath: string, args: string[], environment: Record<string, string>, maximumBytes: number): Record<string, unknown> {
  const result = Bun.spawnSync({ cmd: [executablePath, ...args], env: environment, stdout: "pipe", stderr: "pipe" });
  const output = result.stdout.toString();
  if (result.exitCode !== 0) throw new Error("external command failed");
  if (Buffer.byteLength(output, "utf8") > maximumBytes) throw new Error("external command exceeded its public output limit");
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error("external command did not return one JSON record");
  const value = JSON.parse(lines[0]!) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("external command returned invalid JSON");
  return value as Record<string, unknown>;
}

export function doctorContainerLab(pathValue = process.env.PATH ?? "", descriptorPath?: string): ContainerLabDoctor {
  const descriptor = contract(descriptorPath);
  const operational = executable(descriptor.binaries.operational, pathValue);
  const reaper = executable(descriptor.binaries.reaper, pathValue);
  const base = { version: `configured-${descriptor.configuredRuntime}-unverified` };
  if (!operational || !reaper) return { ...base, installed: false, compatible: false, ready: false, reason: "required Container Lab binaries are missing" };

  const root = mkdtempSync(join(tmpdir(), "skizzles-container-lab-doctor-"));
  try {
    const environment = { PATH: pathValue, HOME: join(root, "home") };
    const help = adminJson(operational, ["--help"], environment, descriptor.execution.adminMaxBytes);
    const reaperHelp = adminJson(reaper, ["--help"], environment, descriptor.execution.adminMaxBytes);
    if (typeof help.help !== "string" || !help.help.includes("run --lab") ||
        typeof reaperHelp.help !== "string" || !reaperHelp.help.includes("codex-container-lab-reaper")) {
      return { ...base, installed: true, compatible: false, ready: false, reason: "Container Lab command fingerprint did not match" };
    }
    const health = adminJson(operational, [
      "--owner", `skizzles-doctor-${crypto.randomUUID()}`,
      "--state-root", join(root, "state"),
      "--runtime-root", join(root, "runtime"),
      "health",
    ], environment, descriptor.execution.adminMaxBytes);
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
  return {
    ok: containerLab.compatible,
    installs: {
      skillsReceipt: existsSync(skillsReceiptPath(codexHome)),
      harnessReceipt: existsSync(harnessReceiptPath(home)),
    },
    containerLab,
  };
}
