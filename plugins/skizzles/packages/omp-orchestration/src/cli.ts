#!/usr/bin/env bun
// @bun
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);

// packages/omp-orchestration/src/config.ts
import { isAbsolute, join, resolve } from "path";
function requiredHome() {
  const value = process.env.HOME?.trim();
  if (!value || !isAbsolute(value))
    throw new Error("HOME must be an absolute path");
  return value;
}
function absolutePath(value, fallback, label) {
  const path = value?.trim() || fallback;
  if (!isAbsolute(path) || /[\0\r\n]/.test(path))
    throw new Error(`${label} must be an absolute path`);
  return resolve(path);
}
function parsePort(value) {
  if (!value?.trim())
    return;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("OMP_ORCHESTRATION_HTTP_PORT must be an integer from 1024 through 65535");
  }
  return port;
}
function parseAllowedProjects(value) {
  const projects = value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
  return projects.length > 0 ? new Set(projects) : undefined;
}
function parseModelRouting(env) {
  const maintainerModel = optionalSelector(env.OMP_ORCHESTRATION_MAINTAINER_MODEL, "OMP_ORCHESTRATION_MAINTAINER_MODEL");
  const maintainerThinking = env.OMP_ORCHESTRATION_MAINTAINER_THINKING?.trim() || undefined;
  if (maintainerThinking && !THINKING_LEVELS.has(maintainerThinking)) {
    throw new Error("OMP_ORCHESTRATION_MAINTAINER_THINKING is invalid");
  }
  const rawOverrides = env.OMP_ORCHESTRATION_AGENT_MODELS?.trim();
  if (!rawOverrides)
    return { maintainerModel, maintainerThinking, agentModelOverrides: Object.freeze({}) };
  let parsed;
  try {
    parsed = JSON.parse(rawOverrides);
  } catch {
    throw new Error("OMP_ORCHESTRATION_AGENT_MODELS must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OMP_ORCHESTRATION_AGENT_MODELS must be a JSON object");
  }
  const overrides = {};
  for (const [agent, value] of Object.entries(parsed)) {
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(agent)) {
      throw new Error(`OMP_ORCHESTRATION_AGENT_MODELS contains invalid agent ${JSON.stringify(agent)}`);
    }
    if (typeof value === "string") {
      overrides[agent] = requiredSelector(value, `model selector for ${agent}`);
      continue;
    }
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`model selectors for ${agent} must be a string or non-empty string array`);
    }
    overrides[agent] = Object.freeze(value.map((selector) => {
      if (typeof selector !== "string")
        throw new Error(`model selectors for ${agent} must contain only strings`);
      return requiredSelector(selector, `model selector for ${agent}`);
    }));
  }
  return { maintainerModel, maintainerThinking, agentModelOverrides: Object.freeze(overrides) };
}
function optionalSelector(value, label) {
  const selector = value?.trim();
  if (!selector)
    return;
  if (selector.length > 255 || /[\0\r\n]/.test(selector))
    throw new Error(`${label} is invalid`);
  return selector;
}
function requiredSelector(value, label) {
  const selector = optionalSelector(value, label);
  if (!selector)
    throw new Error(`${label} is invalid`);
  return selector;
}
var THINKING_LEVELS, userHome, ORCHESTRATION_HOME, SOCKET_PATH, DATABASE_PATH, OMP_BINARY, HTTP_PORT, HTTP_HOST, HTTP_TOKEN, HTTP_ALLOWED_PROJECTS, MODEL_ROUTING;
var init_config = __esm(() => {
  THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);
  userHome = requiredHome();
  ORCHESTRATION_HOME = absolutePath(process.env.OMP_ORCHESTRATION_HOME, join(userHome, ".omp-orchestration"), "OMP_ORCHESTRATION_HOME");
  SOCKET_PATH = absolutePath(process.env.OMP_ORCHESTRATION_SOCKET, join(ORCHESTRATION_HOME, "omp-orchestration.sock"), "OMP_ORCHESTRATION_SOCKET");
  DATABASE_PATH = absolutePath(process.env.OMP_ORCHESTRATION_DATABASE, join(ORCHESTRATION_HOME, "state.sqlite"), "OMP_ORCHESTRATION_DATABASE");
  OMP_BINARY = process.env.OMP_BINARY?.trim() || "omp";
  HTTP_PORT = parsePort(process.env.OMP_ORCHESTRATION_HTTP_PORT);
  HTTP_HOST = process.env.OMP_ORCHESTRATION_HTTP_HOST?.trim() || "127.0.0.1";
  HTTP_TOKEN = process.env.OMP_ORCHESTRATION_HTTP_TOKEN?.trim() || undefined;
  HTTP_ALLOWED_PROJECTS = parseAllowedProjects(process.env.OMP_ORCHESTRATION_HTTP_PROJECTS);
  MODEL_ROUTING = parseModelRouting(process.env);
});

// packages/omp-orchestration/src/protocol.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var MAX_REQUEST_BYTES, MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RPC_CHUNK_PAYLOAD_BYTES;
var init_protocol = __esm(() => {
  MAX_REQUEST_BYTES = 1024 * 1024;
  MAX_RPC_FRAME_BYTES = 1024 * 1024;
  MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;
  RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;
});

// packages/omp-orchestration/src/client.ts
var exports_client = {};
__export(exports_client, {
  CLIENT_DEADLINE_MS: () => CLIENT_DEADLINE_MS,
  daemonRequest: () => daemonRequest,
  normalizeRemoteUrl: () => normalizeRemoteUrl
});
import { connect, isIP } from "net";
async function daemonRequest(payload, options = {}) {
  const deadlineMs = options.deadlineMs ?? CLIENT_DEADLINE_MS;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > CLIENT_DEADLINE_MS)
    throw new Error("invalid client deadline");
  return options.remoteUrl ? remoteRequest(payload, normalizeRemoteUrl(options.remoteUrl), options.token, deadlineMs) : localRequest(payload, options.socketPath ?? SOCKET_PATH, deadlineMs);
}
function localRequest(payload, socketPath, deadlineMs) {
  return new Promise((resolve2, reject) => {
    const socket = connect(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => finish(() => {
      socket.destroy();
      reject(new Error(`ompctl request timed out after ${deadlineMs}ms`));
    }), deadlineMs);
    timer.unref?.();
    const finish = (callback) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}
`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf(`
`);
      if (newline < 0)
        return;
      finish(() => {
        socket.end();
        try {
          resolve2(parseDaemonResponse(buffer.slice(0, newline), "omp-orchestrationd"));
        } catch (error) {
          reject(error);
        }
      });
    });
    socket.once("error", (error) => finish(() => {
      const code = "code" in error ? String(error.code) : "";
      reject(code === "ENOENT" || code === "ECONNREFUSED" ? new Error("omp-orchestrationd is unavailable; install or start the Skizzles OMP orchestration service") : error);
    }));
    socket.once("end", () => finish(() => reject(new Error("omp-orchestrationd closed without a complete response"))));
  });
}
async function remoteRequest(payload, remoteUrl, token, deadlineMs) {
  if (!token?.trim())
    throw new Error("OMP_ORCHESTRATION_TOKEN is required for remote access");
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  timer.unref?.();
  try {
    const response = await fetch(`${remoteUrl}/v1/request`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: controller.signal
    });
    const text = await response.text();
    const parsed = parseDaemonResponse(text, "remote omp-orchestrationd");
    if (!response.ok && parsed.ok)
      throw new Error(`remote omp-orchestrationd failed with HTTP ${response.status}`);
    return parsed;
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error(`ompctl request timed out after ${deadlineMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
function parseDaemonResponse(text, source) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${source} returned malformed JSON`);
  }
  if (!isRecord(parsed) || typeof parsed.ok !== "boolean" || parsed.ok && !("result" in parsed) || !parsed.ok && (typeof parsed.error !== "string" || typeof parsed.code !== "string"))
    throw new Error(`${source} returned an invalid response envelope`);
  return parsed;
}
function normalizeRemoteUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OMP_ORCHESTRATION_URL is invalid");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const httpAllowed = url.protocol === "http:" && (isLoopbackHost(hostname) || isTailscaleAddress(hostname));
  if (url.protocol !== "https:" && !httpAllowed) {
    throw new Error("remote OMP orchestration requires HTTPS or an HTTP loopback/Tailscale IP endpoint");
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error("OMP_ORCHESTRATION_URL must not contain credentials, query, or fragment");
  return url.toString().replace(/\/$/, "");
}
function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
function isTailscaleAddress(hostname) {
  const family = isIP(hostname);
  if (family === 6)
    return hostname.startsWith("fd7a:115c:a1e0:");
  if (family !== 4)
    return false;
  const [first, second] = hostname.split(".").map(Number);
  return first === 100 && second >= 64 && second <= 127;
}
var CLIENT_DEADLINE_MS = 60000;
var init_client = __esm(() => {
  init_config();
  init_protocol();
});

// packages/omp-orchestration/src/cli.ts
var USAGE = `ompctl projects add --cwd PATH [--id ID] [--name NAME] [--base BRANCH] [--model MODEL] [--thinking LEVEL] [--no-auto-publish]
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
async function execute(argv, env = process.env) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h")
    return { help: USAGE };
  const [group, action, ...rest] = argv;
  const booleanOptions = new Set(["no-auto-publish"]);
  const options = new Map;
  const positionals = [];
  for (let index = 0;index < rest.length; index++) {
    const argument = rest[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (booleanOptions.has(name)) {
      options.set(name, "true");
      continue;
    }
    const value = rest[++index];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`missing value for --${name}`);
    options.set(name, value);
  }
  const required = (name) => {
    const value = options.get(name)?.trim();
    if (!value)
      throw new Error(`missing required --${name}`);
    return value;
  };
  const positional = (index, label) => {
    const value = positionals[index]?.trim();
    if (!value)
      throw new Error(`missing ${label}`);
    return value;
  };
  const integer = (name, fallback) => {
    const raw = options.get(name);
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`--${name} must be a non-negative integer`);
    return value;
  };
  let payload;
  if (group === "projects" && action === "list")
    payload = { op: "projects.list" };
  else if (group === "projects" && action === "add")
    payload = {
      op: "projects.add",
      cwd: required("cwd"),
      id: options.get("id"),
      name: options.get("name"),
      baseBranch: options.get("base"),
      model: options.get("model"),
      thinking: options.get("thinking"),
      autoPublish: options.get("no-auto-publish") !== "true"
    };
  else if (group === "projects" && ["start", "stop", "remove"].includes(action ?? ""))
    payload = { op: `projects.${action}`, projectId: positional(0, "project id") };
  else if (group === "maintainers" && action === "send")
    payload = { op: "maintainers.send", projectId: positional(0, "project id"), message: required("message") };
  else if (group === "maintainers" && ["status", "history", "subagents", "abort"].includes(action ?? ""))
    payload = {
      op: `maintainers.${action}`,
      projectId: positional(0, "project id"),
      cursor: options.get("cursor"),
      limit: integer("limit", 50)
    };
  else if (group === "jobs" && action === "list")
    payload = { op: "jobs.list", projectId: options.get("project") };
  else if (group === "jobs" && ["read", "publish"].includes(action ?? ""))
    payload = { op: `jobs.${action}`, projectId: positional(0, "project id"), jobId: positional(1, "job id") };
  else if (group === "approvals" && action === "list")
    payload = { op: "approvals.list", projectId: options.get("project") };
  else if (group === "approvals" && ["approve", "deny"].includes(action ?? ""))
    payload = {
      op: `approvals.${action}`,
      projectId: positional(0, "project id"),
      approvalId: positional(1, "approval id"),
      value: options.get("value")
    };
  else if (group === "ingress" && action === "send")
    payload = {
      op: "ingress.accept",
      projectId: required("project"),
      source: required("source"),
      sourceKey: required("key"),
      kind: required("kind"),
      message: required("message"),
      payload: parsePayload(options.get("payload-json"))
    };
  else if (group === "events" && ["list", "wait"].includes(action ?? ""))
    payload = {
      op: `events.${action}`,
      projectId: options.get("project"),
      after: integer("after", 0),
      limit: integer("limit", 200),
      timeoutMs: integer("timeout-ms", 55000)
    };
  else
    throw new Error(`usage:
  ${USAGE.replaceAll(`
`, `
  `)}`);
  const { daemonRequest: daemonRequest2 } = await Promise.resolve().then(() => (init_client(), exports_client));
  const response = await daemonRequest2(payload, {
    remoteUrl: env.OMP_ORCHESTRATION_URL,
    token: env.OMP_ORCHESTRATION_TOKEN
  });
  if (!response.ok)
    throw new Error(`${response.code}: ${response.error}`);
  return response.result;
}
function parsePayload(value) {
  if (value === undefined)
    return null;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("--payload-json must be valid JSON");
  }
}
if (import.meta.main) {
  try {
    console.log(JSON.stringify(await execute(process.argv.slice(2)), null, 2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
    process.exit(1);
  }
}
export {
  execute
};
