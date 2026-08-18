import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { dlopen, FFIType, suffix } from "bun:ffi";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const DEFAULT_ATTEMPTS = 500;
const DEFAULT_RETRY_MS = 10;

let flockSymbol: ((fd: number, operation: number) => number) | undefined;

function loadFlock(): (fd: number, operation: number) => number {
  if (flockSymbol) return flockSymbol;
  const candidates = process.platform === "darwin"
    ? ["libSystem.B.dylib", "libc.dylib"]
    : [`libc.${suffix}`, "libc.so.6", "libc.so"];
  let last: unknown;
  for (const candidate of candidates) {
    try {
      flockSymbol = dlopen(candidate, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      }).symbols.flock;
      return flockSymbol;
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`flock is unavailable (${last instanceof Error ? last.message : String(last)})`);
}

export async function withExclusiveFileLock<T>(
  lockPath: string,
  body: () => Promise<T>,
  options: { attempts?: number; retryMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const handle = await open(lockPath, "a", 0o600);
  try {
    const flock = loadFlock();
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (flock(handle.fd, LOCK_EX | LOCK_NB) === 0) {
        try {
          return await body();
        } finally {
          flock(handle.fd, LOCK_UN);
        }
      }
      await Bun.sleep(retryMs);
    }
    throw new Error(`Timed out waiting for exclusive lock ${lockPath}`);
  } finally {
    await handle.close();
  }
}
