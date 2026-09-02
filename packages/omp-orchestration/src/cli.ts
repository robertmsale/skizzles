#!/usr/bin/env bun
const USAGE = `ompctl projects add --cwd PATH [--id ID] [--name NAME] [--base BRANCH] [--model MODEL] [--thinking LEVEL] [--no-auto-publish]
ompctl projects {list|start|stop|remove} [PROJECT]
ompctl maintainers {status|history|subagents|abort} PROJECT
ompctl maintainers send PROJECT --message TEXT
ompctl jobs list [--project PROJECT]
ompctl jobs {read|publish} PROJECT JOB
ompctl approvals list [--project PROJECT]
ompctl approvals approve PROJECT APPROVAL [--value VALUE]
ompctl approvals deny PROJECT APPROVAL
ompctl ingress send --project PROJECT --source SOURCE --key KEY --kind KIND --message TEXT [--payload-json JSON]
ompctl events {list|wait} [--project PROJECT] [--after SEQUENCE] [--limit COUNT] [--timeout-ms MS]

Environment:
  OMP_ORCHESTRATION_SOCKET  Local mode-0600 Unix socket
  OMP_ORCHESTRATION_URL     Remote HTTPS origin or HTTP loopback/Tailscale IP
  OMP_ORCHESTRATION_TOKEN   Bearer token for remote access`;

export async function execute(argv: string[], env: Record<string, string | undefined> = process.env): Promise<unknown> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { help: USAGE };
  const [group, action, ...rest] = argv;
  const booleanOptions = new Set(["no-auto-publish"]);
  const options = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index]!;
    if (!argument.startsWith("--")) { positionals.push(argument); continue; }
    const name = argument.slice(2);
    if (booleanOptions.has(name)) { options.set(name, "true"); continue; }
    const value = rest[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for --${name}`);
    options.set(name, value);
  }
  const required = (name: string): string => {
    const value = options.get(name)?.trim();
    if (!value) throw new Error(`missing required --${name}`);
    return value;
  };
  const positional = (index: number, label: string): string => {
    const value = positionals[index]?.trim();
    if (!value) throw new Error(`missing ${label}`);
    return value;
  };
  const integer = (name: string, fallback: number): number => {
    const raw = options.get(name);
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative integer`);
    return value;
  };
  let payload: Record<string, unknown>;
  if (group === "projects" && action === "list") payload = { op: "projects.list" };
  else if (group === "projects" && action === "add") payload = {
    op: "projects.add", cwd: required("cwd"), id: options.get("id"), name: options.get("name"),
    baseBranch: options.get("base"), model: options.get("model"), thinking: options.get("thinking"),
    autoPublish: options.get("no-auto-publish") !== "true",
  };
  else if (group === "projects" && ["start", "stop", "remove"].includes(action ?? "")) payload = { op: `projects.${action}`, projectId: positional(0, "project id") };
  else if (group === "maintainers" && action === "send") payload = { op: "maintainers.send", projectId: positional(0, "project id"), message: required("message") };
  else if (group === "maintainers" && ["status", "history", "subagents", "abort"].includes(action ?? "")) payload = {
    op: `maintainers.${action}`, projectId: positional(0, "project id"), cursor: options.get("cursor"), limit: integer("limit", 50),
  };
  else if (group === "jobs" && action === "list") payload = { op: "jobs.list", projectId: options.get("project") };
  else if (group === "jobs" && ["read", "publish"].includes(action ?? "")) payload = { op: `jobs.${action}`, projectId: positional(0, "project id"), jobId: positional(1, "job id") };
  else if (group === "approvals" && action === "list") payload = { op: "approvals.list", projectId: options.get("project") };
  else if (group === "approvals" && ["approve", "deny"].includes(action ?? "")) payload = {
    op: `approvals.${action}`, projectId: positional(0, "project id"), approvalId: positional(1, "approval id"), value: options.get("value"),
  };
  else if (group === "ingress" && action === "send") payload = {
    op: "ingress.accept", projectId: required("project"), source: required("source"), sourceKey: required("key"),
    kind: required("kind"), message: required("message"), payload: parsePayload(options.get("payload-json")),
  };
  else if (group === "events" && ["list", "wait"].includes(action ?? "")) payload = {
    op: `events.${action}`, projectId: options.get("project"), after: integer("after", 0),
    limit: integer("limit", 200), timeoutMs: integer("timeout-ms", 55_000),
  };
  else throw new Error(`usage:\n  ${USAGE.replaceAll("\n", "\n  ")}`);

  const { daemonRequest } = await import("./client.ts");
  const response = await daemonRequest(payload, {
    remoteUrl: env.OMP_ORCHESTRATION_URL,
    token: env.OMP_ORCHESTRATION_TOKEN,
  });
  if (!response.ok) throw new Error(`${response.code}: ${response.error}`);
  return response.result;
}

function parsePayload(value: string | undefined): unknown {
  if (value === undefined) return null;
  try { return JSON.parse(value); } catch { throw new Error("--payload-json must be valid JSON"); }
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await execute(process.argv.slice(2)), null, 2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); }
}
