export const containerLabGlobalOptions = [
  "--owner",
  "--state-root",
  "--runtime-root",
] as const;

export const containerLabRunOptions = [
  "--lab",
  "--cwd",
  "--env",
  "--timeout-seconds",
] as const;

export const repeatableContainerLabRunOptions = ["--env"] as const;
export const maximumRunTimeoutSeconds = 7_200;

export type ContainerLabRunArguments = {
  lab: string;
  cwd: string;
  environment: Record<string, string>;
  timeoutSeconds: number;
  argv: string[];
};

export type RunContractResult =
  | { ok: true; value: ContainerLabRunArguments }
  | { ok: false; message: string };

const runOptions = new Set<string>(containerLabRunOptions);
const repeatableRunOptions = new Set<string>(repeatableContainerLabRunOptions);

export function parseContainerLabRunArguments(args: readonly string[]): RunContractResult {
  const separator = args.indexOf("--");
  if (separator < 0) return failure("run requires -- before the command argv");

  const values = new Map<string, string[]>();
  for (let index = 0; index < separator; index++) {
    const option = args[index]!;
    if (!runOptions.has(option)) return failure(`unknown argument: ${option}`);
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) {
      return failure(`${option} requires a value`);
    }
    const existing = values.get(option) ?? [];
    if (existing.length > 0 && !repeatableRunOptions.has(option)) {
      return failure(`${option} may be provided only once`);
    }
    existing.push(value);
    values.set(option, existing);
  }

  const argv = args.slice(separator + 1);
  if (argv.length === 0) return failure("run requires a command after --");

  const cwd = values.get("--cwd")?.[0] ?? ".";
  if (!isRepositoryRelativeRunCwd(cwd)) {
    return failure(
      "run --cwd must be a repository-relative workspace path, never an absolute container path",
    );
  }

  const environment: Record<string, string> = {};
  for (const value of values.get("--env") ?? []) {
    const separatorIndex = value.indexOf("=");
    if (separatorIndex < 1) return failure("--env must be KEY=VALUE");
    environment[value.slice(0, separatorIndex)] = value.slice(separatorIndex + 1);
  }

  const timeoutValue = values.get("--timeout-seconds")?.[0];
  if (timeoutValue !== undefined && !/^[0-9]+$/.test(timeoutValue)) {
    return failure("--timeout-seconds must be an integer");
  }

  const lab = values.get("--lab")?.[0];
  if (lab === undefined) return failure("--lab is required");

  return {
    ok: true,
    value: {
      lab,
      cwd,
      environment,
      timeoutSeconds: timeoutValue === undefined ? 1_800 : Number(timeoutValue),
      argv: [...argv],
    },
  };
}

export function isManagedContainerLabRun(result: RunContractResult): result is {
  ok: true;
  value: ContainerLabRunArguments;
} {
  return result.ok
    && result.value.timeoutSeconds <= maximumRunTimeoutSeconds
    && Object.keys(result.value.environment).every(isContainerLabEnvironmentVariableName);
}

export function isContainerLabEnvironmentVariableName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export function isRepositoryRelativeRunCwd(cwd: string): boolean {
  return cwd.length > 0
    && !cwd.includes("\0")
    && !cwd.startsWith("/")
    && !cwd.includes("\\")
    && !/^[A-Za-z]:/.test(cwd)
    && !cwd.split("/").includes("..");
}

function failure(message: string): RunContractResult {
  return { ok: false, message };
}
