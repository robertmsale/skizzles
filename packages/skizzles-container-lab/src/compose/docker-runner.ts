import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { runCommand, type CommandResult, type RunOptions } from "../execution/process";

export interface DockerRunner {
  run(args: string[], options?: RunOptions): Promise<CommandResult>;
  spawn(args: string[], options?: DockerSpawnOptions): ChildProcessWithoutNullStreams;
}

export type DockerSpawnOptions = { env?: NodeJS.ProcessEnv };

export const defaultDockerRunner: DockerRunner = {
  run: async (args, options = {}) => await runCommand("docker", args, options),
  spawn: (args, options = {}) => spawn("docker", args, {
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  }),
};

export async function dockerAvailable(
  runner: DockerRunner = defaultDockerRunner,
  secretEnvironment: readonly string[] = [],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return (await runner.run(["info", "--format", "{{.ServerVersion}}"], {
    allowFailure: true,
    timeoutMs: 10_000,
    env: scrubSecretEnvironment(secretEnvironment, environment),
  })).code === 0;
}

export function secretComposeEnvironment(
  names: readonly string[],
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result = scrubSecretEnvironment(names, environment);
  for (const name of names) {
    if (Object.hasOwn(environment, name) && typeof environment[name] === "string") {
      result[name] = environment[name];
    }
  }
  return result;
}

export function scrubSecretEnvironment(
  names: readonly string[],
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const name of names) delete result[name];
  return result;
}

export function scrubDockerRunnerEnvironment(
  runner: DockerRunner,
  names: readonly string[],
  environment: NodeJS.ProcessEnv,
): DockerRunner {
  if (names.length === 0) return runner;
  return {
    run: async (args, options = {}) => await runner.run(args, {
      ...options,
      env: scrubSecretEnvironment(names, options.env ?? environment),
    }),
    spawn: (args, options = {}) => runner.spawn(args, {
      ...options,
      env: scrubSecretEnvironment(names, options.env ?? environment),
    }),
  };
}
