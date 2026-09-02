export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runCommand(
  command: string[],
  options: { cwd: string; stdin?: string; timeoutMs?: number; env?: Record<string, string | undefined> },
): Promise<CommandResult> {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.stdin !== undefined && child.stdin) {
    child.stdin.write(options.stdin);
    child.stdin.end();
  }
  const timeoutMs = options.timeoutMs ?? 60_000;
  let timedOut = false;
  const timeout = Bun.sleep(timeoutMs).then(() => { timedOut = true; return false; });
  const exited = child.exited.then(() => true);
  if (!await Promise.race([exited, timeout])) {
    try { child.kill("SIGTERM"); } catch {}
    if (!await Promise.race([exited, Bun.sleep(2_000).then(() => false)])) {
      try { child.kill("SIGKILL"); } catch {}
    }
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (timedOut) throw new Error(`${command[0] ?? "command"} timed out after ${timeoutMs}ms`);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

export async function checkedCommand(command: string[], options: Parameters<typeof runCommand>[1]): Promise<string> {
  const result = await runCommand(command, options);
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `${command[0] ?? "command"} exited with ${result.exitCode}`);
  return result.stdout;
}
