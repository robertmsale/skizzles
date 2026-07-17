import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = join(dirname(fileURLToPath(import.meta.url)), "..");

async function runInstall(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bun", ["install", "--silent"], {
      cwd: projectDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`bun install failed with exit code ${code}`));
    });
  });
}

await runInstall();

const server = spawn("bun", ["run", "src/index.ts"], {
  cwd: projectDir,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.kill(signal);
  });
}

server.on("error", (error) => {
  console.error(`[mcp-start] failed to launch server: ${error.message}`);
  process.exit(1);
});

server.on("close", (code, signal) => {
  if (signal) {
    console.error(`[mcp-start] server exited from ${signal}`);
  }
  process.exit(code ?? 0);
});
