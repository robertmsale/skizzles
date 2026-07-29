import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { posix } from "node:path";
import type { CommandResult } from "../execution/process";
import { defaultDockerRunner, scrubSecretEnvironment, type DockerRunner } from "./docker-runner";
import { composeCommand, type LabRuntime } from "./runtime";

export type DockerRunIdentity = {
  runId: string;
  cwd: string;
  argv: string[];
  environment: Record<string, string>;
};

export type DockerRunTerminationResult =
  | { confirmed: true; status: "signaled" | "absent" }
  | { confirmed: false; status: "identity-mismatch" | "unavailable" | "docker-failure" };

export function launchDockerRun(
  runtime: LabRuntime,
  invocation: DockerRunIdentity,
  runner: DockerRunner = defaultDockerRunner,
  environment: NodeJS.ProcessEnv = process.env,
): ChildProcessWithoutNullStreams {
  const workdir = invocation.cwd === "." ? runtime.config.runtime.workspace : posix.join(runtime.config.runtime.workspace, invocation.cwd);
  const pidFile = `/tmp/.codex-container-lab-run-${invocation.runId}.pid`;
  const processIdentity = `CODEX_CONTAINER_LAB_RUN_ID=${invocation.runId}`;
  const wrapper = [
    "command -v setsid >/dev/null 2>&1 || { echo 'configured command service requires setsid' >&2; exit 127; }",
    "exec 3<&0",
    `${processIdentity} setsid "$@" <&3 3<&- & child=$!`,
    "exec 3<&-",
    `printf '%s %s\\n' ${shellQuote(invocation.runId)} "$child" > ${shellQuote(pidFile)}`,
    'wait "$child"; code=$?',
    'kill -TERM -- -"$child" 2>/dev/null || :',
    'attempt=0; while kill -0 -- -"$child" 2>/dev/null && [ "$attempt" -lt 20 ]; do sleep 0.1; attempt=$((attempt + 1)); done',
    'kill -KILL -- -"$child" 2>/dev/null || :',
    `rm -f ${shellQuote(pidFile)}`,
    'exit "$code"',
  ].join("; ");
  const args = [
    ...runtime.composeArgs, "exec", "-T", "--workdir", workdir,
    ...Object.entries(invocation.environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    runtime.config.mode.commandService, ...runtime.config.runtime.shell, wrapper,
    "codex-container-lab-run", ...invocation.argv,
  ];
  return runner.spawn(args, { env: scrubSecretEnvironment(runtime.config.secretEnvironment, environment) });
}

export async function terminateDockerRun(
  runtime: LabRuntime,
  identity: Pick<DockerRunIdentity, "runId">,
  signal: "INT" | "TERM" | "KILL",
  runner: DockerRunner = defaultDockerRunner,
): Promise<DockerRunTerminationResult> {
  const pidFile = `/tmp/.codex-container-lab-run-${identity.runId}.pid`;
  const expectedIdentity = `CODEX_CONTAINER_LAB_RUN_ID=${identity.runId}`;
  const marker = "codex-container-lab-termination:";
  const killScript = [
    `termination_result() { printf '%s\\n' ${shellQuote(marker)}"$1"; exit 0; }`,
    `recorded_token=; pid=; extra=; read -r recorded_token pid extra < ${shellQuote(pidFile)} 2>/dev/null || termination_result unavailable`,
    `case "$pid" in ''|*[!0-9]*) termination_result identity-mismatch;; esac`,
    `[ -z "$extra" ] || termination_result identity-mismatch`,
    `[ "$recorded_token" = ${shellQuote(identity.runId)} ] || termination_result identity-mismatch`,
    `kill -0 -- -"$pid" 2>/dev/null || { rm -f ${shellQuote(pidFile)}; termination_result absent; }`,
    `[ -r "/proc/$pid/environ" ] || termination_result unavailable`,
    `command -v tr >/dev/null 2>&1 && command -v grep >/dev/null 2>&1 || termination_result unavailable`,
    `tr '\\000' '\\n' < "/proc/$pid/environ" | grep -Fqx -- ${shellQuote(expectedIdentity)} || termination_result identity-mismatch`,
    `kill -${signal} -- -"$pid" 2>/dev/null && { [ "${signal}" != KILL ] || rm -f ${shellQuote(pidFile)}; termination_result signaled; }`,
    `kill -0 -- -"$pid" 2>/dev/null || { rm -f ${shellQuote(pidFile)}; termination_result absent; }`,
    `termination_result unavailable`,
  ].join("; ");
  let result: CommandResult;
  try {
    result = await composeCommand(runtime, [
      "exec", "-T", runtime.config.mode.commandService, ...runtime.config.runtime.shell, killScript,
    ], { allowFailure: true, timeoutMs: 10_000 }, runner);
  } catch {
    return { confirmed: false, status: "docker-failure" };
  }
  if (result.code !== 0) return { confirmed: false, status: "docker-failure" };
  switch (result.stdout.toString().trim()) {
    case `${marker}signaled`: return { confirmed: true, status: "signaled" };
    case `${marker}absent`: return { confirmed: true, status: "absent" };
    case `${marker}identity-mismatch`: return { confirmed: false, status: "identity-mismatch" };
    case `${marker}unavailable`: return { confirmed: false, status: "unavailable" };
    default: return { confirmed: false, status: "unavailable" };
  }
}


function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
