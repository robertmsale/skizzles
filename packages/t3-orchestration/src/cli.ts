#!/usr/bin/env bun
import {
  clientTimeoutMessage,
  clampWaitTimeoutMs,
  createClientDeadline,
  daemonRequest,
  maxWaitTimeoutMs,
  resolveClientDeadlineMs,
  withClientDeadline,
} from "./client.ts";
import { clearRemoteUrl, configuredRemoteUrl, configureRemoteUrl, REMOTE_CONFIG_PATH } from "./remote-config.ts";

const clientDeadlineMs = resolveClientDeadlineMs();
const maxWaitMs = maxWaitTimeoutMs(clientDeadlineMs);
const USAGE = `t3ctl remote {configure --url HTTPS_URL|status|clear}
t3ctl projects {list|import}
t3ctl handoff create --project ID --title TITLE --message TEXT [--provider codex|grok|cursor]
t3ctl tasks create [--project ID] --title TITLE --message TEXT [--provider codex|grok|cursor]
t3ctl tasks list [--project ID] [--limit 1..200] [--include-settled] [--include-archived]
t3ctl tasks {read|history|status} ID
t3ctl tasks wait ID [ID ...] [--timeout-ms 0..${maxWaitMs}] [--after ID=CURSOR]
t3ctl tasks send ID --message TEXT
t3ctl tasks title ID --title TITLE
t3ctl tasks {archive|unarchive|pin|unpin|settle|unsettle|interrupt} ID
t3ctl tasks approvals [--project ID]
t3ctl tasks approve ID [REQUEST_ID]
t3ctl tasks deny ID [REQUEST_ID] [--reason TEXT]`;
const [group, action, ...args] = process.argv.slice(2);
if (group === "--help" || group === "-h") {
  console.log(JSON.stringify({ help: USAGE }));
  process.exit(0);
}
const booleanOptions = new Set(["include-settled", "include-archived"]);
const options = new Map<string, string[]>();
const positionals: string[] = [];
for (let i = 0; i < args.length; i++) {
  const argument = args[i]!;
  if (!argument.startsWith("--")) {
    positionals.push(argument);
    continue;
  }
  const name = argument.slice(2);
  const value = booleanOptions.has(name) ? "true" : args[++i];
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
  options.set(name, [...options.get(name) ?? [], value]);
}
const option = (name: string): string | undefined => options.get(name)?.at(-1);
const requiredPositional = (value: string | undefined, label: string): string => {
  if (!value?.trim()) throw new Error(`Missing ${label}`);
  return value;
};
if (group === "auth" && action === "configure") {
  const pairingToken = (await new Response(Bun.stdin.stream()).text()).trim();
  if (!pairingToken) throw new Error("Pipe a one-time T3 pairing token on stdin");
  const { origin } = await import("./config.ts");
  const deadline = createClientDeadline(clientDeadlineMs);
  let body = "";
  let failure: string | undefined;
  try {
    const response = await withClientDeadline(fetch(`${await origin()}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: pairingToken,
        subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        scope: "orchestration:read orchestration:operate",
        client_label: "t3ctl",
        client_device_type: "bot",
        client_os: "macOS",
      }),
      signal: deadline.signal,
    }), deadline.signal, "auth.configure", clientDeadlineMs);
    body = await withClientDeadline(response.text(), deadline.signal, "auth.configure", clientDeadlineMs);
    if (!response.ok) throw new Error(`T3 pairing exchange failed (${response.status}): ${body}`);
  } catch (error) {
    failure = deadline.signal.aborted
      ? clientTimeoutMessage("auth.configure", clientDeadlineMs)
      : error instanceof Error ? error.message : String(error);
  } finally {
    deadline.dispose();
  }
  if (failure) {
    process.stderr.write(`${failure}\n`);
    process.exit(1);
  }
  const accessToken = (JSON.parse(body) as { access_token?: unknown }).access_token;
  if (typeof accessToken !== "string" || !accessToken) throw new Error("T3 pairing response did not contain an access token");
  const { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE } = await import("./config.ts");
  const result = await Bun.$`security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w ${accessToken}`.nothrow().quiet();
  if (result.exitCode !== 0) throw new Error(`Could not store T3 token in Keychain: ${result.stderr.toString()}`);
  console.log(JSON.stringify({ ok: true, scopes: "orchestration:read orchestration:operate" }));
  process.exit(0);
}

if (group === "remote" && ["configure", "clear", "status"].includes(action ?? "")) {
  if (action === "configure") {
    const url = option("url")?.trim();
    if (!url) throw new Error("Missing required --url");
    console.log(JSON.stringify({ ok: true, url: await configureRemoteUrl(url), configPath: REMOTE_CONFIG_PATH }, null, 2));
  } else if (action === "clear") {
    await clearRemoteUrl();
    console.log(JSON.stringify({ ok: true, remote: false, configPath: REMOTE_CONFIG_PATH }, null, 2));
  } else {
    console.log(JSON.stringify({ ok: true, url: await configuredRemoteUrl() ?? null, configPath: REMOTE_CONFIG_PATH }, null, 2));
  }
  process.exit(0);
}

const required = (name: string): string => {
  const value = option(name)?.trim();
  if (!value) throw new Error(`Missing required --${name}`);
  return value;
};
const turns = (): number => {
  const raw = option("turns")?.trim() || "3";
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 10) throw new Error("--turns must be an integer from 1 through 10");
  return value;
};
const boundedInteger = (name: string, fallback: number, minimum: number, maximum: number): number => {
  const raw = option(name)?.trim() || String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
};
const waitAfter = (): Record<string, string> => Object.fromEntries((options.get("after") ?? []).map((entry) => {
  const separator = entry.indexOf("=");
  if (separator < 1 || separator === entry.length - 1) throw new Error("--after must use THREAD_ID=CURSOR");
  return [entry.slice(0, separator), entry.slice(separator + 1)];
}));
const waitIds = (): string[] => {
  const ids = [...new Set(positionals.map((value) => value.trim()).filter(Boolean))];
  if (ids.length < 1 || ids.length > 8) throw new Error("tasks wait requires 1 through 8 task ids");
  return ids;
};
const callerThreadId = process.env.CODEX_THREAD_ID?.trim();
const payload = group === "projects" && action === "import" ? { op: "projects.import" }
  : group === "projects" && action === "list" ? { op: "projects.list" }
  : group === "handoff" && action === "create" ? { op: "handoff.create", projectId: required("project"), title: required("title"), message: required("message"), baseBranch: option("base"), provider: option("provider") }
  : group === "tasks" && action === "create" ? { op: "tasks.create", callerThreadId, projectId: option("project")?.trim() || "current", title: required("title"), message: required("message"), baseBranch: option("base"), provider: option("provider") }
  : group === "tasks" && action === "list" ? { op: "tasks.list", limit: boundedInteger("limit", 50, 1, 200), projectId: option("project")?.trim(), includeSettled: option("include-settled") === "true", includeArchived: option("include-archived") === "true" }
  : group === "tasks" && action === "wait" ? { op: "tasks.wait", threadIds: waitIds(), timeoutMs: clampWaitTimeoutMs(boundedInteger("timeout-ms", maxWaitMs, 0, 3_600_000), clientDeadlineMs), after: waitAfter() }
  : group === "tasks" && action === "send" ? { op: "tasks.send", threadId: requiredPositional(positionals[0], "thread id"), message: required("message") }
  : group === "tasks" && action === "status" ? { op: "tasks.status", threadId: requiredPositional(positionals[0], "thread id") }
  : group === "tasks" && (action === "history" || action === "read") ? { op: "tasks.history", threadId: requiredPositional(positionals[0], "thread id"), turns: turns(), before: option("before") }
  : group === "tasks" && action === "title" ? { op: "tasks.title", threadId: requiredPositional(positionals[0], "thread id"), title: required("title") }
  : group === "tasks" && ["archive", "unarchive", "pin", "unpin", "settle", "unsettle", "interrupt"].includes(action ?? "") ? { op: `tasks.${action}`, threadId: requiredPositional(positionals[0], "thread id") }
  : group === "tasks" && action === "approvals" ? { op: "tasks.approvals", projectId: option("project")?.trim() }
  : group === "tasks" && action === "approve" ? { op: "tasks.approve", threadId: requiredPositional(positionals[0], "thread id"), requestId: positionals[1]?.trim() }
  : group === "tasks" && action === "deny" ? { op: "tasks.deny", threadId: requiredPositional(positionals[0], "thread id"), requestId: positionals[1]?.trim(), reason: option("reason")?.trim() }
  : (() => { throw new Error(`Usage:\n  ${USAGE.replaceAll("\n", "\n  ")}`); })();

try {
  const result = await daemonRequest(payload, undefined, clientDeadlineMs, await configuredRemoteUrl());
  console.log(JSON.stringify(result.ok ? result.result : { error: result.error }, null, 2));
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
