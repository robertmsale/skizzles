import { Database } from "bun:sqlite";
import { join } from "node:path";

export function resolveCodexHome(environment: NodeJS.ProcessEnv): string {
  return environment.CODEX_HOME ?? join(environment.HOME ?? "", ".codex");
}

export async function listRollouts(codexHome: string): Promise<string[]> {
  const candidates: string[] = [];
  for (const root of [
    join(codexHome, "sessions"),
    join(codexHome, "archived_sessions"),
  ]) {
    try {
      for await (
        const relative of new Bun.Glob("**/*.jsonl").scan({
          cwd: root,
          onlyFiles: true,
        })
      ) {
        candidates.push(join(root, relative));
      }
    } catch {
      // A fresh Codex home may not have both directories yet.
    }
  }

  const byId = new Map<string, { path: string; size: number }>();
  for (const path of candidates) {
    const id = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i.exec(path)?.[1] ?? path;
    const size = Bun.file(path).size;
    const existing = byId.get(id);
    if (!existing || size > existing.size) byId.set(id, { path, size });
  }
  return [...byId.values()].map(({ path }) => path).sort();
}

export async function* readLines(path: string): AsyncGenerator<string> {
  const reader = Bun.file(path).stream().getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      yield pending.slice(0, newline);
      pending = pending.slice(newline + 1);
    }
  }
  pending += decoder.decode();
  if (pending) yield pending;
}

export function loadTitles(codexHome: string): Map<string, string> {
  const titles = new Map<string, string>();
  try {
    const databases = [
      ...new Bun.Glob("state_*.sqlite").scanSync({
        cwd: codexHome,
        onlyFiles: true,
      }),
    ].sort(
      (left, right) =>
        Number(/state_(\d+)\.sqlite$/.exec(right)?.[1] ?? 0)
        - Number(/state_(\d+)\.sqlite$/.exec(left)?.[1] ?? 0),
    );
    const newest = databases[0];
    if (!newest) return titles;
    const db = new Database(join(codexHome, newest), { readonly: true });
    try {
      const rows = db.query("SELECT id, title FROM threads").all() as Array<{
        id: string;
        title: string;
      }>;
      for (const row of rows) titles.set(row.id, row.title);
    } finally {
      db.close();
    }
  } catch {
    // Rollout analysis works without Desktop's optional title index.
  }
  return titles;
}
