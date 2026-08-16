import { Database } from "bun:sqlite";
import { join } from "node:path";
import { CODEX_HOME, T3_HOME } from "./config.ts";

type Edge = { parent_thread_id: string; child_thread_id: string };

function rootProviderId(id: string, db: Database): string {
  const edges = db.query<Edge, []>("SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges").all();
  const parentByChild = new Map(edges.map((edge) => [edge.child_thread_id, edge.parent_thread_id]));
  const seen = new Set<string>();
  let current = id;
  while (parentByChild.has(current)) {
    if (!seen.add(current)) throw new Error("Codex spawn graph contains a cycle");
    current = parentByChild.get(current)!;
  }
  return current;
}

export function resolveCallerThread(correlationId: unknown): { codexThreadId: string; t3ThreadId: string; projectId: string } {
  const codexThreadId = typeof correlationId === "string" ? correlationId.trim() : "";
  if (!codexThreadId) throw new Error("CODEX_THREAD_ID is required for task-to-task orchestration");
  const codexDb = new Database(join(CODEX_HOME, "state_5.sqlite"), { readonly: true });
  const root = rootProviderId(codexThreadId, codexDb);
  codexDb.close();
  const t3Db = new Database(join(T3_HOME, "userdata/state.sqlite"), { readonly: true });
  const rows = t3Db.query<{ thread_id: string; project_id: string }, [string]>(
    "SELECT thread_id, project_id FROM projection_threads WHERE json_extract((SELECT resume_cursor_json FROM provider_session_runtime WHERE thread_id = projection_threads.thread_id), '$.threadId') = ? AND deleted_at IS NULL",
  ).all(root);
  t3Db.close();
  if (rows.length !== 1) throw new Error(`Could not uniquely map Codex root ${root} to a live T3 task`);
  const row = rows[0]!;
  return { codexThreadId, t3ThreadId: row.thread_id, projectId: row.project_id };
}
