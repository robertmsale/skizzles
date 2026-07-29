import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function exactDirectoryChain(
  root: string,
  segments: readonly string[],
  label: string,
): Promise<boolean> {
  let current = resolve(root);
  let info;
  try {
    info = await lstat(current);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`configured ${label} contains unsafe indirection`);
  }

  let expected = await realpath(current);
  for (const segment of segments) {
    current = join(current, segment);
    expected = join(expected, segment);
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== expected) {
      throw new Error(`${label} contains unsafe indirection`);
    }
  }
  return true;
}
