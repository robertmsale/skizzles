export function compactProvisioningError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .split("\n")
    .slice(-8)
    .join("\n")
    .slice(-4000);
}

export function resolveProvisioningEnvironment(
  names: readonly string[],
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
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
