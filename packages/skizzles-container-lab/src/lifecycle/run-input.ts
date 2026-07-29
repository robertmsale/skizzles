import {
  isContainerLabEnvironmentVariableName,
  isRepositoryRelativeRunCwd,
  maximumRunTimeoutSeconds,
} from "../../run-contract";

export function validateRunInput(
  argv: string[],
  cwd: string,
  environment: Record<string, string>,
  timeoutSeconds: number,
): void {
  if (argv.length === 0 || argv.length > 256 || argv.some((arg) => arg.includes("\0")) ||
      Buffer.byteLength(argv.join("\0")) > 64 * 1024) {
    throw new Error("run argv must contain 1..256 bounded arguments");
  }
  if (!isRepositoryRelativeRunCwd(cwd)) {
    throw new Error("run --cwd must be a repository-relative workspace path, never an absolute container path");
  }
  const entries = Object.entries(environment);
  if (entries.length > 64 ||
      entries.some(([key, value]) => !isContainerLabEnvironmentVariableName(key) || value.includes("\0")) ||
      Buffer.byteLength(JSON.stringify(environment)) > 64 * 1024) {
    throw new Error("run environment is invalid or exceeds 64 KiB");
  }
  if (
    !Number.isInteger(timeoutSeconds)
    || timeoutSeconds < 0
    || timeoutSeconds > maximumRunTimeoutSeconds
  ) {
    throw new Error("timeout-seconds must be 0..7200");
  }
}

export { isRepositoryRelativeRunCwd } from "../../run-contract";
