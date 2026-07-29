export type SupervisedSignal = "SIGINT" | "SIGTERM" | "SIGHUP";
export type ManagedChild = Bun.Subprocess<"inherit", "pipe", "pipe">;

const forcedExitWaitMilliseconds = 500;
const supervisedSignals: readonly SupervisedSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const signalExitCodes = new Map<SupervisedSignal, number>([
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
]);

export function superviseProcessTree(child: ManagedChild, signalGraceMilliseconds: number) {
  let receivedSignal: SupervisedSignal | undefined;
  let signalAfterShellExit = false;
  let shellExited = false;
  let escalationTimer: ReturnType<typeof setTimeout> | undefined;
  let escalationComplete = false;
  let resolveEscalation: () => void = () => {};
  const escalation = new Promise<void>((resolve) => {
    resolveEscalation = resolve;
  });

  const finishEscalation = () => {
    if (escalationComplete) return;
    escalationComplete = true;
    if (escalationTimer) clearTimeout(escalationTimer);
    escalationTimer = undefined;
    resolveEscalation();
  };
  const forceExit = () => {
    if (escalationComplete) return;
    signalProcessTree(child, "SIGKILL");
    finishEscalation();
  };
  const handlers = new Map<SupervisedSignal, () => void>();
  for (const supervisedSignal of supervisedSignals) {
    const handler = () => {
      if (receivedSignal !== undefined) {
        forceExit();
        return;
      }
      receivedSignal = supervisedSignal;
      signalAfterShellExit = shellExited;
      signalProcessTree(child, supervisedSignal);
      escalationTimer = setTimeout(forceExit, signalGraceMilliseconds);
    };
    handlers.set(supervisedSignal, handler);
    process.on(supervisedSignal, handler);
  }

  return {
    get receivedSignal() {
      return receivedSignal;
    },
    markShellExited() {
      shellExited = true;
    },
    async finish(shellExitCode: number): Promise<number> {
      await Bun.sleep(0);
      if (receivedSignal === undefined) {
        await terminateProcessTree(child, signalGraceMilliseconds);
      } else {
        if (processTreeExists(child)) {
          const exitedBeforeEscalation = await Promise.race([
            waitForProcessTreeExit(child, signalGraceMilliseconds + 25),
            escalation.then(() => false),
          ]);
          if (exitedBeforeEscalation) finishEscalation();
          else await escalation;
        } else {
          finishEscalation();
        }
        await waitForProcessTreeExit(child, forcedExitWaitMilliseconds);
      }
      return receivedSignal !== undefined && signalAfterShellExit
        ? (signalExitCodes.get(receivedSignal) ?? shellExitCode)
        : shellExitCode;
    },
    close() {
      finishEscalation();
      for (const [supervisedSignal, handler] of handlers) {
        process.off(supervisedSignal, handler);
      }
    },
  };
}

function missingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function signalProcessTree(child: ManagedChild, signal: SupervisedSignal | "SIGKILL"): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (missingProcess(error)) return;
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may have exited between observation and delivery.
  }
}

function processTreeExists(child: ManagedChild): boolean {
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessTreeExit(
  child: ManagedChild,
  timeoutMilliseconds: number,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMilliseconds;
  while (processTreeExists(child)) {
    if (performance.now() >= deadline) return false;
    await Bun.sleep(10);
  }
  return true;
}

async function terminateProcessTree(
  child: ManagedChild,
  signalGraceMilliseconds: number,
): Promise<void> {
  if (!processTreeExists(child)) return;
  signalProcessTree(child, "SIGTERM");
  if (await waitForProcessTreeExit(child, signalGraceMilliseconds)) return;
  signalProcessTree(child, "SIGKILL");
  await waitForProcessTreeExit(child, forcedExitWaitMilliseconds);
}
