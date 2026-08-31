import type { BackendTransport, HostBackendFactory } from "./backend.ts";
import { HOST_MACHINE_ID } from "./execution.ts";

export type HostBackendOptions = {
  codexBinary?: string | undefined;
  cwd?: string | undefined;
};

export class CodexHostBackendFactory implements HostBackendFactory {
  private readonly codexBinary: string;
  private readonly cwd: string | undefined;

  constructor(options: HostBackendOptions = {}) {
    this.codexBinary = options.codexBinary ?? "codex";
    this.cwd = options.cwd;
    validateCommand(this.codexBinary);
  }

  async create(): Promise<BackendTransport> {
    const process = Bun.spawn([this.codexBinary, "app-server", "--stdio"], {
      ...(this.cwd === undefined ? {} : { cwd: this.cwd }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    return new HostTransport(process);
  }
}

class HostTransport implements BackendTransport {
  readonly machineId = HOST_MACHINE_ID;
  readonly kind = "host" as const;
  readonly disposable = false;
  readonly ready = Promise.resolve();
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  private destroyPromise: Promise<void> | undefined;
  private destroyed = false;
  private inputEnded = false;

  constructor(private readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">) {
    this.stdout = process.stdout;
    this.stderr = process.stderr;
  }

  write(line: string): void {
    if (this.destroyed || this.inputEnded) throw new Error("host app-server is closed");
    this.process.stdin.write(line);
    this.process.stdin.flush();
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    if (this.destroyPromise) return this.destroyPromise;
    const attempt = (async () => {
      if (!this.inputEnded) {
        this.inputEnded = true;
        this.process.stdin.end();
      }
      await Promise.race([this.process.exited, Bun.sleep(2_000).then(() => this.process.kill())]);
      this.destroyed = true;
    })();
    this.destroyPromise = attempt;
    try {
      await attempt;
    } catch (error) {
      if (this.destroyPromise === attempt) this.destroyPromise = undefined;
      throw error;
    }
  }
}

function validateCommand(value: string): void {
  if (!value.trim() || /[\0\r\n]/.test(value)) throw new Error("invalid host Codex binary");
}
