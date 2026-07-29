import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export async function boundedRemove(root: string, maxEntries: number): Promise<void> {
  let count = 0;
  async function scan(path: string): Promise<void> {
    let info;
    try { info = await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      return;
    }
    for (const name of await readdir(path)) {
      if (++count > maxEntries) throw new Error("cleanup path exceeds bounded entry limit");
      await scan(join(path, name));
    }
  }
  await scan(root);
  await rm(root, { recursive: true, force: true });
}
