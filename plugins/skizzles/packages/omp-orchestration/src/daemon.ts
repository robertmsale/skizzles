#!/usr/bin/env bun
// @bun

// packages/omp-orchestration/src/daemon.ts
import { connect } from "net";
import { chmod, lstat, mkdir as mkdir2, unlink } from "fs/promises";
import { dirname as dirname2 } from "path";

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
var userHome = requiredHome();
var ORCHESTRATION_HOME = absolutePath(process.env.OMP_ORCHESTRATION_HOME, join(userHome, ".omp-orchestration"), "OMP_ORCHESTRATION_HOME");
var SOCKET_PATH = absolutePath(process.env.OMP_ORCHESTRATION_SOCKET, join(ORCHESTRATION_HOME, "omp-orchestration.sock"), "OMP_ORCHESTRATION_SOCKET");
var DATABASE_PATH = absolutePath(process.env.OMP_ORCHESTRATION_DATABASE, join(ORCHESTRATION_HOME, "state.sqlite"), "OMP_ORCHESTRATION_DATABASE");
var OMP_BINARY = process.env.OMP_BINARY?.trim() || "omp";
var HTTP_PORT = parsePort(process.env.OMP_ORCHESTRATION_HTTP_PORT);
var HTTP_HOST = process.env.OMP_ORCHESTRATION_HTTP_HOST?.trim() || "127.0.0.1";
var HTTP_TOKEN = process.env.OMP_ORCHESTRATION_HTTP_TOKEN?.trim() || undefined;
var HTTP_ALLOWED_PROJECTS = parseAllowedProjects(process.env.OMP_ORCHESTRATION_HTTP_PROJECTS);
function projectStateRoot(projectId) {
  return join(ORCHESTRATION_HOME, "projects", projectId);
}

// packages/omp-orchestration/src/http-server.ts
import { createServer as createServer2 } from "http";
import { timingSafeEqual } from "crypto";

// packages/omp-orchestration/src/protocol.ts
var SERVICE_SCHEMA = 1;
var MAX_REQUEST_BYTES = 1024 * 1024;
var MAX_RPC_FRAME_BYTES = 1024 * 1024;
var MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;
var RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;

class ServiceError extends Error {
  code;
  status;
  constructor(message, code, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "ServiceError";
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requiredString(value, label, maximum = 1e6) {
  if (typeof value !== "string" || !value.trim() || /\0/.test(value) || value.length > maximum) {
    throw new ServiceError(`${label} is invalid`, "invalid_request");
  }
  return value.trim();
}
function optionalString(value, label, maximum = 1e6) {
  if (value === undefined || value === null)
    return;
  return requiredString(value, label, maximum);
}
function requireProjectId(value) {
  const id = requiredString(value, "project id", 64);
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(id)) {
    throw new ServiceError("project id must use lowercase letters, numbers, dots, dashes, or underscores", "invalid_request");
  }
  return id;
}

// packages/omp-orchestration/src/commands.ts
async function executeCommand(command, manager) {
  const op = requiredString(command.op, "operation", 80);
  switch (op) {
    case "health":
      return { service: "omp-orchestrationd", schema: 1 };
    case "projects.list":
      return manager.projects.list();
    case "projects.add":
      return manager.registerProject({
        id: optionalString(command.id, "project id", 64),
        name: optionalString(command.name, "project name", 120),
        cwd: requiredString(command.cwd, "project cwd", 4096),
        baseBranch: optionalString(command.baseBranch, "base branch", 255),
        model: optionalString(command.model, "model", 255),
        thinking: optionalString(command.thinking, "thinking", 32),
        autoPublish: command.autoPublish === undefined ? true : requireBoolean(command.autoPublish, "autoPublish")
      });
    case "projects.remove":
      return manager.removeProject(requireProjectId(command.projectId));
    case "projects.start":
      await manager.enableProject(requireProjectId(command.projectId));
      return manager.status(requireProjectId(command.projectId));
    case "projects.stop":
      await manager.stopProject(requireProjectId(command.projectId));
      return manager.status(requireProjectId(command.projectId));
    case "maintainers.status":
      return manager.status(requireProjectId(command.projectId));
    case "maintainers.send":
      return manager.send(requireProjectId(command.projectId), requiredString(command.message, "message"));
    case "maintainers.history":
      return manager.history(requireProjectId(command.projectId), optionalString(command.cursor, "cursor", 4096), boundedInteger(command.limit, 50, 1, 200, "limit"));
    case "maintainers.subagents":
      return manager.subagents(requireProjectId(command.projectId));
    case "maintainers.abort":
      return manager.abort(requireProjectId(command.projectId));
    case "jobs.list":
      return manager.state.jobs(optionalProjectId(command.projectId));
    case "jobs.read": {
      const projectId = requireProjectId(command.projectId);
      const job = manager.state.job(projectId, requiredString(command.jobId, "job id", 128));
      if (!job)
        throw new ServiceError("job not found", "not_found", 404);
      return job;
    }
    case "jobs.publish":
      return manager.publish(requireProjectId(command.projectId), requiredString(command.jobId, "job id", 128));
    case "approvals.list":
      return manager.approvals(optionalProjectId(command.projectId));
    case "approvals.approve":
      return manager.resolveApproval(requireProjectId(command.projectId), requiredString(command.approvalId, "approval id", 128), { approved: true, ...command.value !== undefined ? { value: requiredString(command.value, "approval value") } : {} });
    case "approvals.deny":
      return manager.resolveApproval(requireProjectId(command.projectId), requiredString(command.approvalId, "approval id", 128), { approved: false });
    case "events.list":
      return manager.events(boundedInteger(command.after, 0, 0, Number.MAX_SAFE_INTEGER, "after"), optionalProjectId(command.projectId), boundedInteger(command.limit, 200, 1, 1000, "limit"));
    case "events.wait": {
      const after = boundedInteger(command.after, 0, 0, Number.MAX_SAFE_INTEGER, "after");
      const projectId = optionalProjectId(command.projectId);
      await manager.waitForEvent(after, boundedInteger(command.timeoutMs, 55000, 0, 58000, "timeoutMs"), projectId);
      return manager.events(after, projectId, boundedInteger(command.limit, 200, 1, 1000, "limit"));
    }
    case "ingress.accept":
      return manager.acceptIngress({
        projectId: requireProjectId(command.projectId),
        source: requiredString(command.source, "ingress source", 120),
        sourceKey: requiredString(command.sourceKey, "ingress source key", 255),
        kind: requiredString(command.kind, "ingress kind", 120),
        payload: command.payload ?? null,
        message: requiredString(command.message, "ingress message")
      });
    default:
      throw new ServiceError(`unknown operation: ${op}`, "not_found", 404);
  }
}
function optionalProjectId(value) {
  return value === undefined || value === null ? undefined : requireProjectId(value);
}
function requireBoolean(value, label) {
  if (typeof value !== "boolean")
    throw new ServiceError(`${label} must be a boolean`, "invalid_request");
  return value;
}
function boundedInteger(value, fallback, minimum, maximum, label) {
  if (value === undefined || value === null)
    return fallback;
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ServiceError(`${label} must be an integer from ${minimum} through ${maximum}`, "invalid_request");
  }
  return parsed;
}

// packages/omp-orchestration/src/local-server.ts
import { createServer } from "net";
function createLocalServer(manager) {
  const sockets = new Set;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    let work = Promise.resolve();
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
        socket.end(`${JSON.stringify(failure(new ServiceError("request exceeds 1 MiB", "too_large", 413)))}
`);
        return;
      }
      let newline = buffer.indexOf(`
`);
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf(`
`);
        work = work.then(async () => {
          let response;
          try {
            let parsed;
            try {
              parsed = JSON.parse(line);
            } catch {
              throw new ServiceError("command must be valid JSON", "invalid_request");
            }
            if (!isRecord(parsed))
              throw new ServiceError("command must be an object", "invalid_request");
            response = { ok: true, result: await executeCommand(parsed, manager) };
          } catch (error) {
            response = failure(error);
          }
          socket.write(`${JSON.stringify(response)}
`);
        });
      }
    });
    socket.on("error", () => {
      return;
    });
  });
  return Object.assign(server, {
    closeActiveConnections: () => {
      for (const socket of sockets)
        socket.destroy();
    }
  });
}
function failure(error) {
  if (error instanceof ServiceError)
    return { ok: false, error: error.message, code: error.code };
  return { ok: false, error: error instanceof Error ? error.message : String(error), code: "internal_error" };
}

// packages/omp-orchestration/src/http-server.ts
function createHttpServer(manager, options) {
  if (options.token.length < 24 || /[\0\r\n]/.test(options.token)) {
    throw new Error("HTTP ingress requires an OMP_ORCHESTRATION_HTTP_TOKEN of at least 24 characters");
  }
  return createServer2(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/health") {
      send(response, 200, { ok: true, result: { service: "omp-orchestrationd", schema: 1 } });
      return;
    }
    const auth = authorize(request, options.token);
    if (auth) {
      send(response, auth.status, { ok: false, error: auth.message, code: auth.code });
      return;
    }
    if (request.headers.origin) {
      send(response, 403, { ok: false, error: "browser-origin requests are not allowed", code: "unauthorized" });
      return;
    }
    try {
      if (request.method === "GET" && request.url?.startsWith("/v1/events")) {
        await eventsRequest(request, response, manager, options.allowedProjects);
        return;
      }
      let command;
      const ingress = request.url?.match(/^\/v1\/projects\/([^/]+)\/inbox$/);
      if (request.method === "POST" && ingress) {
        requireJson(request);
        const body = await readJson(request);
        let projectId;
        try {
          projectId = decodeURIComponent(ingress[1]);
        } catch {
          throw new ServiceError("project id encoding is invalid", "invalid_request");
        }
        command = { ...body, op: "ingress.accept", projectId };
      } else if (request.method === "POST" && request.url === "/v1/request") {
        requireJson(request);
        command = await readJson(request);
      } else {
        throw new ServiceError("not found", "not_found", 404);
      }
      const scopedResult = scopedCommand(command, manager, options.allowedProjects);
      send(response, 200, { ok: true, result: scopedResult ?? await executeCommand(command, manager) });
    } catch (error) {
      const body = failure(error);
      send(response, error instanceof ServiceError ? error.status : 500, body);
    }
  });
}
function authorize(request, token) {
  const header = request.headers.authorization;
  if (!header)
    return { status: 401, code: "unauthenticated", message: "bearer token required" };
  const supplied = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${token}`);
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    return { status: 401, code: "invalid_session", message: "bearer token is invalid" };
  }
  return;
}
function enforceProjectScope(value, allowed) {
  if (!allowed)
    return;
  if (value === undefined || value === null)
    throw new ServiceError("token requires an explicit authorized project", "unauthorized", 403);
  if (typeof value !== "string" || !allowed.has(value))
    throw new ServiceError("token is not authorized for this project", "unauthorized", 403);
}
function scopedCommand(command, manager, allowed) {
  if (!allowed)
    return;
  if (command.op === "health")
    return { service: "omp-orchestrationd", schema: 1 };
  if (command.op === "projects.list")
    return manager.projects.list().filter((project) => allowed.has(project.id));
  if (command.op === "projects.add")
    throw new ServiceError("scoped tokens cannot register projects", "unauthorized", 403);
  enforceProjectScope(command.projectId, allowed);
  return;
}
async function eventsRequest(request, response, manager, allowed) {
  const url = new URL(request.url, "http://localhost");
  const projectId = url.searchParams.get("project") ?? undefined;
  enforceProjectScope(projectId, allowed);
  const after = parseInteger(url.searchParams.get("after"), 0, 0, Number.MAX_SAFE_INTEGER);
  if (url.pathname === "/v1/events") {
    send(response, 200, { ok: true, result: manager.events(after, projectId) });
    return;
  }
  if (url.pathname !== "/v1/events/stream")
    throw new ServiceError("not found", "not_found", 404);
  response.writeHead(200, {
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
    "x-omp-orchestration": "1"
  });
  let cursor = after;
  let closed = false;
  response.once("close", () => {
    closed = true;
  });
  response.write(`: connected

`);
  while (!closed) {
    const events = manager.events(cursor, projectId);
    for (const event of events) {
      cursor = event.sequence;
      response.write(`id: ${event.sequence}
event: ${event.kind}
data: ${JSON.stringify(event)}

`);
    }
    if (!closed)
      await manager.waitForEvent(cursor, 25000, projectId);
    if (!closed && events.length === 0)
      response.write(`: keepalive

`);
  }
}
function requireJson(request) {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new ServiceError("application/json required", "invalid_request", 415);
  }
}
async function readJson(request) {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES)
    throw new ServiceError("request exceeds 1 MiB", "too_large", 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_REQUEST_BYTES)
      throw new ServiceError("request exceeds 1 MiB", "too_large", 413);
    chunks.push(bytes);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ServiceError("request body must be valid JSON", "invalid_request");
  }
  if (!isRecord(parsed))
    throw new ServiceError("request body must be an object", "invalid_request");
  return parsed;
}
function parseInteger(value, fallback, minimum, maximum) {
  if (value === null)
    return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new ServiceError("invalid integer query parameter", "invalid_request");
  return parsed;
}
function send(response, status, body) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "x-omp-orchestration": "1"
  });
  response.end(`${JSON.stringify(body)}
`);
}

// packages/omp-orchestration/src/manager.ts
import { EventEmitter } from "events";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { resolve as resolve3 } from "path";

// packages/omp-orchestration/src/process.ts
async function runCommand(command, options) {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe"
  });
  if (options.stdin !== undefined && child.stdin) {
    child.stdin.write(options.stdin);
    child.stdin.end();
  }
  const timeoutMs = options.timeoutMs ?? 60000;
  let timedOut = false;
  const timeout = Bun.sleep(timeoutMs).then(() => {
    timedOut = true;
    return false;
  });
  const exited = child.exited.then(() => true);
  if (!await Promise.race([exited, timeout])) {
    try {
      child.kill("SIGTERM");
    } catch {}
    if (!await Promise.race([exited, Bun.sleep(2000).then(() => false)])) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);
  if (timedOut)
    throw new Error(`${command[0] ?? "command"} timed out after ${timeoutMs}ms`);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}
async function checkedCommand(command, options) {
  const result = await runCommand(command, options);
  if (result.exitCode !== 0)
    throw new Error(result.stderr || result.stdout || `${command[0] ?? "command"} exited with ${result.exitCode}`);
  return result.stdout;
}

// packages/omp-orchestration/src/projects.ts
import { constants } from "fs";
import { copyFile, mkdtemp, realpath, rm, stat } from "fs/promises";
import { basename, isAbsolute as isAbsolute2, join as join2, resolve as resolve2 } from "path";
class ProjectRegistry {
  state;
  constructor(state) {
    this.state = state;
  }
  list() {
    return this.state.projects();
  }
  async register(input) {
    const requested = validateAbsolutePath(input.cwd);
    const canonical = await realpath(requested);
    if (!(await stat(canonical)).isDirectory())
      throw new ServiceError("project cwd is not a directory", "invalid_project");
    const cwd = await checkedCommand(["git", "rev-parse", "--show-toplevel"], { cwd: canonical });
    const root = await realpath(cwd);
    await assertApfsClone(root);
    const remote = await optionalGit(root, ["remote", "get-url", "origin"]);
    const baseBranch = input.baseBranch?.trim() || await discoverBaseBranch(root);
    validateBranch(baseBranch);
    try {
      await checkedCommand(["git", "check-ref-format", "--branch", baseBranch], { cwd: root });
    } catch {
      throw new ServiceError("base branch is not a valid Git branch name", "invalid_project");
    }
    const id = input.id?.trim() || slug(basename(root));
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(id)) {
      throw new ServiceError("project id must use lowercase letters, numbers, dots, dashes, or underscores", "invalid_project");
    }
    const name = input.name?.trim() || basename(root);
    if (!name || name.length > 120 || /[\0\r\n]/.test(name))
      throw new ServiceError("project name is invalid", "invalid_project");
    const autoPublish = input.autoPublish ?? true;
    if (autoPublish && !isRemoteCloneUrl(remote)) {
      throw new ServiceError("auto-publish requires an SSH or HTTPS origin remote", "invalid_project");
    }
    return this.state.saveProject({
      id,
      name,
      cwd: root,
      remote,
      baseBranch,
      model: input.model?.trim() || null,
      thinking: input.thinking?.trim() || null,
      autoPublish,
      enabled: true
    });
  }
}
async function optionalGit(cwd, args) {
  try {
    return await checkedCommand(["git", ...args], { cwd });
  } catch {
    return null;
  }
}
async function discoverBaseBranch(cwd) {
  const remoteHead = await optionalGit(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead?.startsWith("origin/"))
    return remoteHead.slice("origin/".length);
  return await checkedCommand(["git", "branch", "--show-current"], { cwd }) || "main";
}
function validateAbsolutePath(value) {
  if (!value.trim() || !value.startsWith("/") || /[\0\r\n]/.test(value)) {
    throw new ServiceError("project cwd must be an absolute path", "invalid_project");
  }
  return resolve2(value);
}
function validateBranch(value) {
  if (!value || value.length > 255 || /[\0\r\n]/.test(value) || value.startsWith("-") || value.includes("..")) {
    throw new ServiceError("base branch is invalid", "invalid_project");
  }
}
function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").slice(0, 64) || "project";
}
function isRemoteCloneUrl(value) {
  if (!value)
    return false;
  return /^(?:https?|ssh|git):\/\/[^\s]+$/.test(value) || /^[^\s/@:]+@[^\s/:]+:.+$/.test(value);
}
async function assertApfsClone(cwd) {
  if (process.platform !== "darwin")
    throw new ServiceError("APFS task isolation requires macOS", "invalid_project");
  const gitDirectory = await checkedCommand(["git", "rev-parse", "--git-dir"], { cwd });
  const probe = await mkdtemp(join2(isAbsolute2(gitDirectory) ? gitDirectory : resolve2(cwd, gitDirectory), "skizzles-apfs-probe-"));
  try {
    const source = join2(probe, "source");
    await Bun.write(source, `apfs clone probe
`);
    await copyFile(source, join2(probe, "clone"), constants.COPYFILE_FICLONE_FORCE);
  } catch (error) {
    throw new ServiceError(`project checkout does not support APFS copy-on-write clones: ${error instanceof Error ? error.message : String(error)}`, "invalid_project");
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

// packages/omp-orchestration/src/publisher.ts
class PullRequestPublisher {
  state;
  commands;
  active = new Set;
  constructor(state, commands = { checked: checkedCommand, run: runCommand }) {
    this.state = state;
    this.commands = commands;
  }
  async publish(project, job) {
    const key = `${project.id}:${job.id}`;
    if (this.active.has(key))
      return this.state.job(project.id, job.id) ?? job;
    this.active.add(key);
    try {
      if (!project.remote)
        throw new Error("project has no supported origin remote");
      if (!job.baseSha)
        throw new Error("job has no recorded base commit");
      if (job.branchName !== `omp/task/${job.id}` || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(job.id)) {
        throw new Error("job branch does not match the native OMP task namespace");
      }
      if (!["completed", "publish_failed"].includes(job.status))
        throw new Error(`job is not publishable from state ${job.status}`);
      this.state.setJobPublishState(project.id, job.id, { status: "publishing", error: null });
      const currentRemote = await this.commands.checked(["git", "remote", "get-url", "origin"], { cwd: project.cwd });
      if (currentRemote !== project.remote)
        throw new Error("origin remote changed after project registration");
      await this.commands.checked(["git", "show-ref", "--verify", `refs/heads/${job.branchName}`], { cwd: project.cwd });
      await this.commands.checked(["git", "merge-base", "--is-ancestor", job.baseSha, job.branchName], { cwd: project.cwd });
      await this.commands.checked(["git", "merge-base", "--is-ancestor", job.baseSha, project.baseBranch], { cwd: project.cwd });
      const commits = await this.commands.checked(["git", "rev-list", "--count", `${job.baseSha}..${job.branchName}`], { cwd: project.cwd });
      if (Number(commits) < 1)
        throw new Error("job branch contains no commits beyond its recorded base");
      const existing = await findPullRequest(project, job.branchName, this.commands);
      if (existing)
        return this.remember(project.id, job.id, existing);
      await this.commands.checked(["git", "push", "--set-upstream", "origin", `${job.branchName}:refs/heads/${job.branchName}`], {
        cwd: project.cwd,
        timeoutMs: 120000
      });
      const afterPush = await findPullRequest(project, job.branchName, this.commands);
      if (afterPush)
        return this.remember(project.id, job.id, afterPush);
      const title = (job.description || job.assignment || `OMP task ${job.id}`).replaceAll(/\s+/g, " ").slice(0, 120);
      const body = [
        "Created by the Skizzles OMP orchestration daemon from an APFS-isolated OMP subagent.",
        "",
        `Subagent: ${job.agent}`,
        `Job: ${job.id}`,
        job.assignment ? `
Assignment:

${job.assignment.slice(0, 8000)}` : ""
      ].filter(Boolean).join(`
`);
      await this.commands.checked(["gh", "pr", "create", "--draft", "--base", project.baseBranch, "--head", job.branchName, "--title", title, "--body", body], {
        cwd: project.cwd,
        timeoutMs: 120000
      });
      const created = await findPullRequest(project, job.branchName, this.commands);
      if (!created)
        throw new Error("GitHub accepted PR creation but the PR could not be rediscovered");
      return this.remember(project.id, job.id, created);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.setJobPublishState(project.id, job.id, { status: "publish_failed", error: message });
      throw error;
    } finally {
      this.active.delete(key);
    }
  }
  remember(projectId, jobId, pullRequest) {
    this.state.setJobPublishState(projectId, jobId, {
      status: "published",
      error: null,
      prUrl: pullRequest.url,
      prNumber: pullRequest.number
    });
    return this.state.job(projectId, jobId);
  }
}
async function findPullRequest(project, branch, commands) {
  const result = await commands.run(["gh", "pr", "list", "--head", branch, "--state", "all", "--json", "number,url,state,isDraft", "--limit", "2"], {
    cwd: project.cwd,
    timeoutMs: 30000
  });
  if (result.exitCode !== 0)
    throw new Error(result.stderr || "unable to query GitHub pull requests");
  const parsed = JSON.parse(result.stdout || "[]");
  if (!Array.isArray(parsed))
    throw new Error("gh pr list returned malformed JSON");
  const candidate = parsed[0];
  if (!candidate || typeof candidate !== "object" || typeof candidate.number !== "number" || typeof candidate.url !== "string")
    return;
  return candidate;
}

// packages/omp-orchestration/src/rpc.ts
class OmpRpcError extends Error {
  command;
  code;
  constructor(message, command, code) {
    super(message);
    this.command = command;
    this.code = code;
    this.name = "OmpRpcError";
  }
}

class RpcFrameDecoder {
  pending;
  push(value) {
    if (!isRecord(value) || value.type !== "rpc_chunk") {
      if (this.pending)
        throw new OmpRpcError("RPC chunk sequence was interrupted");
      if (!isRecord(value))
        throw new OmpRpcError("RPC frame must be an object");
      return value;
    }
    const chunkId = value.chunkId;
    const index = value.index;
    const count = value.count;
    const byteLength = value.byteLength;
    const data = value.data;
    if (typeof chunkId !== "string" || chunkId.length === 0 || chunkId.length > 128 || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || !Number.isSafeInteger(byteLength) || index < 0 || count < 2 || index >= count || count > Math.ceil(MAX_RPC_REASSEMBLED_BYTES / RPC_CHUNK_PAYLOAD_BYTES) || byteLength < MAX_RPC_FRAME_BYTES || byteLength > MAX_RPC_REASSEMBLED_BYTES || typeof data !== "string" || data.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
      throw new OmpRpcError("Invalid RPC chunk frame");
    const bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64") !== data || bytes.byteLength > RPC_CHUNK_PAYLOAD_BYTES) {
      throw new OmpRpcError("Invalid RPC chunk payload");
    }
    if (!this.pending) {
      if (index !== 0)
        throw new OmpRpcError("RPC chunk sequence must start at index zero");
      this.pending = { chunkId, count, byteLength, nextIndex: 0, chunks: [], receivedBytes: 0 };
    }
    const pending = this.pending;
    if (pending.chunkId !== chunkId || pending.count !== count || pending.byteLength !== byteLength || pending.nextIndex !== index) {
      throw new OmpRpcError("RPC chunk sequence does not match");
    }
    pending.chunks.push(bytes);
    pending.nextIndex += 1;
    pending.receivedBytes += bytes.byteLength;
    if (pending.receivedBytes > pending.byteLength)
      throw new OmpRpcError("RPC chunk sequence exceeds its declared length");
    if (pending.nextIndex < pending.count)
      return;
    this.pending = undefined;
    if (pending.receivedBytes !== pending.byteLength)
      throw new OmpRpcError("RPC chunk sequence length does not match");
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks));
    const frame = JSON.parse(decoded);
    if (!isRecord(frame))
      throw new OmpRpcError("Reassembled RPC frame must be an object");
    return frame;
  }
}

class OmpRpcClient {
  options;
  process;
  sink;
  sequence = 0;
  pending = new Map;
  stopped = false;
  stderr = "";
  protocolV2 = false;
  constructor(options) {
    this.options = options;
  }
  get pid() {
    return this.process?.pid;
  }
  async start() {
    if (this.process)
      throw new OmpRpcError("OMP RPC client is already started");
    this.stopped = false;
    const child = Bun.spawn(this.options.command, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    this.process = child;
    this.sink = child.stdin;
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve3, reject) => {
      resolveReady = resolve3;
      rejectReady = reject;
    });
    this.readStderr(child);
    this.readStdout(child, resolveReady, rejectReady);
    child.exited.then(async (code) => {
      const wasCurrent = this.process === child;
      if (wasCurrent) {
        this.process = undefined;
        this.sink = undefined;
        const error = new OmpRpcError(`OMP exited with code ${code}${this.stderr ? `: ${this.stderr}` : ""}`);
        this.rejectPending(error);
        if (!this.stopped)
          rejectReady(error);
        await this.options.onExit?.(code, this.stderr);
      }
    });
    const startupTimeoutMs = this.options.startupTimeoutMs ?? 30000;
    const timeout = Bun.sleep(startupTimeoutMs).then(() => {
      throw new OmpRpcError(`OMP did not become ready within ${startupTimeoutMs}ms`);
    });
    let readyFrame;
    try {
      readyFrame = await Promise.race([ready, timeout]);
      if (!supportsProtocolV2(readyFrame))
        throw new OmpRpcError("OMP RPC protocol v2 is required");
      this.protocolV2 = true;
      await this.request("negotiate_protocol", { protocolVersion: 2 });
      await this.request("set_subagent_subscription", { level: "events" });
      return await this.getState();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  async stop() {
    this.stopped = true;
    const child = this.process;
    this.process = undefined;
    const sink = this.sink;
    this.sink = undefined;
    this.rejectPending(new OmpRpcError("OMP RPC client stopped"));
    try {
      sink?.end();
    } catch {}
    if (!child)
      return;
    try {
      child.kill("SIGTERM");
    } catch {}
    const exited = child.exited.then(() => true, () => true);
    if (!await Promise.race([exited, Bun.sleep(2000).then(() => false)])) {
      try {
        child.kill("SIGKILL");
      } catch {}
      await child.exited.catch(() => {
        return;
      });
    }
  }
  async request(command, payload = {}, timeoutMs = this.options.requestTimeoutMs ?? 60000) {
    if (!this.process || !this.sink)
      throw new OmpRpcError("OMP RPC process is unavailable", command);
    const id = `skz-${Date.now().toString(36)}-${(++this.sequence).toString(36)}`;
    let resolveRequest;
    let rejectRequest;
    const result = new Promise((resolve3, reject) => {
      resolveRequest = resolve3;
      rejectRequest = reject;
    });
    const timer = setTimeout(() => {
      this.pending.delete(id);
      rejectRequest(new OmpRpcError(`OMP RPC ${command} timed out after ${timeoutMs}ms`, command, "timeout"));
    }, timeoutMs);
    timer.unref?.();
    this.pending.set(id, { command, resolve: resolveRequest, reject: rejectRequest, timer });
    try {
      this.write({ id, type: command, ...payload });
    } catch (error) {
      clearTimeout(timer);
      this.pending.delete(id);
      throw error;
    }
    return result;
  }
  getState() {
    return this.request("get_state");
  }
  getMessagesPage(cursor, limit = 50) {
    return this.request("get_messages_page", { ...cursor ? { cursor } : {}, limit });
  }
  getSubagents() {
    return this.request("get_subagents");
  }
  prompt(message, streamingBehavior = "followUp") {
    return this.request("prompt", { message, streamingBehavior });
  }
  abort() {
    return this.request("abort");
  }
  respondToUi(id, response) {
    this.write({ type: "extension_ui_response", id, ...response });
  }
  write(frame) {
    if (!this.sink)
      throw new OmpRpcError("OMP RPC input is closed");
    const line = `${JSON.stringify(frame)}
`;
    if (Buffer.byteLength(line, "utf8") > MAX_RPC_FRAME_BYTES)
      throw new OmpRpcError("OMP RPC command exceeds 1 MiB");
    this.sink.write(line);
    this.sink.flush();
  }
  async readStderr(child) {
    const text = await new Response(child.stderr).text().catch(() => "");
    this.stderr = text.trim().slice(-16384);
  }
  async readStdout(child, resolveReady, rejectReady) {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder;
    const frames = new RpcFrameDecoder;
    let buffer = "";
    let sawReady = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done)
          break;
        buffer += decoder.decode(value, { stream: true });
        if (Buffer.byteLength(buffer, "utf8") > MAX_RPC_FRAME_BYTES * 2)
          throw new OmpRpcError("OMP RPC output line exceeds transport limit");
        let newline = buffer.indexOf(`
`);
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf(`
`);
          if (!line.trim())
            continue;
          if (Buffer.byteLength(line, "utf8") + 1 > MAX_RPC_FRAME_BYTES)
            throw new OmpRpcError("OMP RPC output frame exceeds 1 MiB");
          const parsed = JSON.parse(line);
          if (!sawReady && isRecord(parsed) && parsed.type === "ready") {
            sawReady = true;
            resolveReady(parsed);
            continue;
          }
          if (isRecord(parsed) && parsed.type === "rpc_chunk" && !this.protocolV2) {
            throw new OmpRpcError("OMP sent RPC chunks before protocol negotiation");
          }
          const frame = frames.push(parsed);
          if (frame)
            await this.handleFrame(frame);
        }
      }
      if (!sawReady) {
        await Promise.race([child.exited.catch(() => {
          return;
        }), Bun.sleep(250)]);
        await Bun.sleep(0);
        rejectReady(new OmpRpcError(`OMP output closed before the ready frame${this.stderr ? `: ${this.stderr}` : ""}`));
      }
    } catch (error) {
      const failure2 = error instanceof Error ? error : new Error(String(error));
      rejectReady(failure2);
      this.rejectPending(failure2);
      try {
        child.kill("SIGTERM");
      } catch {}
    } finally {
      reader.releaseLock();
    }
  }
  async handleFrame(frame) {
    if (frame.type === "response" && typeof frame.id === "string") {
      const pending = this.pending.get(frame.id);
      if (pending) {
        this.pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.success === true)
          pending.resolve(frame);
        else
          pending.reject(new OmpRpcError(typeof frame.error === "string" ? frame.error : `OMP RPC ${pending.command} failed`, pending.command, typeof frame.code === "string" ? frame.code : undefined));
      }
    }
    await this.options.onFrame?.(frame);
  }
  rejectPending(error) {
    const requests = [...this.pending.values()];
    this.pending.clear();
    for (const request of requests) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }
}
function supportsProtocolV2(frame) {
  return frame.type === "ready" && Array.isArray(frame.supportedProtocolVersions) && frame.supportedProtocolVersions.includes(2) && frame.maxFrameBytes === MAX_RPC_FRAME_BYTES && frame.maxReassembledFrameBytes === MAX_RPC_REASSEMBLED_BYTES;
}

// packages/omp-orchestration/src/manager.ts
var PERSISTED_FRAME_TYPES = new Set([
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_end",
  "tool_execution_end",
  "subagent_lifecycle",
  "subagent_progress",
  "notice",
  "goal_updated",
  "extension_ui_request"
]);
var BLOCKING_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

class OmpManager {
  state;
  projects;
  publisher;
  runtimes = new Map;
  starts = new Map;
  ingressDeliveries = new Map;
  eventEmitter = new EventEmitter;
  shuttingDown = false;
  ompBinary;
  resolveProjectStateRoot;
  maintainerPromptPath;
  constructor(state, options = {}) {
    this.state = state;
    this.projects = new ProjectRegistry(state);
    this.publisher = new PullRequestPublisher(state);
    this.ompBinary = options.ompBinary ?? OMP_BINARY;
    this.resolveProjectStateRoot = options.projectStateRoot ?? projectStateRoot;
    this.maintainerPromptPath = options.maintainerPromptPath ?? resolve3(import.meta.dir, "../prompts/maintainer.md");
    this.eventEmitter.setMaxListeners(0);
  }
  async start() {
    this.state.recoverMaintainers();
    const enabled = this.state.projects().filter((project) => project.enabled);
    await Promise.allSettled(enabled.map((project) => this.startProject(project.id)));
    for (const project of enabled.filter((candidate) => candidate.autoPublish)) {
      for (const job of this.state.jobs(project.id).filter((candidate) => candidate.status === "completed")) {
        this.reconcileAndPublish(project, job.id);
      }
    }
  }
  async stop() {
    this.shuttingDown = true;
    await Promise.allSettled([...this.runtimes.values()].map(async (runtime) => {
      runtime.stopping = true;
      await runtime.client.stop();
      this.state.saveMaintainer(runtime.project.id, { state: "stopped", pid: null, heartbeatAt: Date.now() });
    }));
    this.runtimes.clear();
  }
  async registerProject(input) {
    const project = await this.projects.register(input);
    this.emit(this.state.appendEvent(project.id, "project.registered", project));
    await this.starts.get(project.id)?.catch(() => {
      return;
    });
    const previousRuntime = this.runtimes.get(project.id);
    if (previousRuntime) {
      previousRuntime.stopping = true;
      this.runtimes.delete(project.id);
      await previousRuntime.client.stop();
      this.state.saveMaintainer(project.id, { state: "stopped", pid: null, heartbeatAt: Date.now() });
    }
    await this.startProject(project.id);
    return project;
  }
  async removeProject(projectId) {
    await this.stopProject(projectId);
    const removed = this.state.removeProject(projectId);
    if (removed)
      this.emit(this.state.appendEvent(null, "project.removed", { projectId }));
    return { removed };
  }
  async startProject(projectId) {
    if (this.runtimes.has(projectId))
      return;
    const project = this.requireProject(projectId);
    if (!project.enabled)
      throw new ServiceError("project is stopped", "unavailable", 503);
    const pending = this.starts.get(projectId);
    if (pending)
      return pending;
    const start = this.launchProject(projectId).finally(() => this.starts.delete(projectId));
    this.starts.set(projectId, start);
    return start;
  }
  async stopProject(projectId) {
    this.requireProject(projectId);
    this.state.setProjectEnabled(projectId, false);
    await this.starts.get(projectId)?.catch(() => {
      return;
    });
    const runtime = this.runtimes.get(projectId);
    if (!runtime) {
      this.state.saveMaintainer(projectId, { state: "stopped", pid: null, heartbeatAt: Date.now() });
      return;
    }
    runtime.stopping = true;
    this.runtimes.delete(projectId);
    await runtime.client.stop();
    this.state.saveMaintainer(projectId, { state: "stopped", pid: null, heartbeatAt: Date.now() });
    this.emit(this.state.appendEvent(projectId, "maintainer.stopped", { projectId }));
  }
  async enableProject(projectId) {
    this.requireProject(projectId);
    this.state.setProjectEnabled(projectId, true);
    await this.startProject(projectId);
  }
  async send(projectId, message) {
    const runtime = await this.requireRuntime(projectId);
    const response = await runtime.client.prompt(message);
    this.emit(this.state.appendEvent(projectId, "maintainer.message.accepted", { messageLength: message.length }));
    return response.data ?? null;
  }
  async status(projectId) {
    const project = this.requireProject(projectId);
    const maintainer = this.state.maintainer(projectId) ?? null;
    const runtime = this.runtimes.get(projectId);
    let rpcState = null;
    if (runtime) {
      try {
        rpcState = (await runtime.client.getState()).data ?? null;
      } catch {}
    }
    return { project, maintainer, rpcState };
  }
  async history(projectId, cursor, limit = 50) {
    const runtime = await this.requireRuntime(projectId);
    return (await runtime.client.getMessagesPage(cursor, Math.max(1, Math.min(200, limit)))).data ?? null;
  }
  async subagents(projectId) {
    const runtime = await this.requireRuntime(projectId);
    return (await runtime.client.getSubagents()).data ?? null;
  }
  async abort(projectId) {
    const runtime = await this.requireRuntime(projectId);
    return (await runtime.client.abort()).data ?? null;
  }
  async acceptIngress(input) {
    this.requireProject(input.projectId);
    const accepted = this.state.acceptInbox(input);
    if (accepted.delivered)
      return accepted;
    if (!accepted.duplicate) {
      this.emit(this.state.appendEvent(input.projectId, "inbox.accepted", { inboxId: accepted.id, source: input.source, sourceKey: input.sourceKey, kind: input.kind }));
    }
    let delivery = this.ingressDeliveries.get(accepted.id);
    if (!delivery) {
      delivery = (async () => {
        await this.send(input.projectId, `[Ingress: ${input.source}/${input.kind} id=${input.sourceKey}]

${input.message}`);
        this.state.markInboxDelivered(accepted.id);
        this.emit(this.state.appendEvent(input.projectId, "inbox.delivered", { inboxId: accepted.id }));
      })().finally(() => this.ingressDeliveries.delete(accepted.id));
      this.ingressDeliveries.set(accepted.id, delivery);
    }
    await delivery;
    return { ...accepted, delivered: true };
  }
  async publish(projectId, jobId) {
    const project = this.requireProject(projectId);
    const job = this.state.job(projectId, jobId);
    if (!job)
      throw new ServiceError("job not found", "not_found", 404);
    const published = await this.publisher.publish(project, job);
    this.emit(this.state.appendEvent(projectId, "job.published", published));
    this.send(projectId, `[System notification] Subagent job ${jobId} was published as draft PR ${published.prUrl}.`).catch(() => {
      return;
    });
    return published;
  }
  approvals(projectId) {
    return this.state.approvals(projectId, true);
  }
  resolveApproval(projectId, approvalId, input) {
    const approval = this.state.approval(projectId, approvalId);
    if (!approval)
      throw new ServiceError("approval not found", "not_found", 404);
    if (approval.status !== "pending")
      throw new ServiceError("approval is no longer pending", "conflict", 409);
    const runtime = this.runtimes.get(projectId);
    if (!runtime)
      throw new ServiceError("maintainer is unavailable", "unavailable", 503);
    const response = input.approved ? approval.method === "confirm" ? { confirmed: true } : input.value !== undefined ? { value: input.value } : { cancelled: true } : { cancelled: true };
    if (input.approved && approval.method !== "confirm" && input.value === undefined) {
      throw new ServiceError("this approval requires a value", "invalid_request");
    }
    runtime.client.respondToUi(approvalId, response);
    if (!this.state.resolveApproval(projectId, approvalId, input.approved ? "approved" : "denied", response)) {
      throw new ServiceError("approval resolution raced with another caller", "conflict", 409);
    }
    const resolved = this.state.approval(projectId, approvalId);
    this.emit(this.state.appendEvent(projectId, `approval.${resolved.status}`, resolved));
    return resolved;
  }
  events(after = 0, projectId, limit = 200) {
    return this.state.events(after, projectId, limit);
  }
  waitForEvent(after, timeoutMs, projectId) {
    if (this.state.events(after, projectId, 1).length > 0 || timeoutMs <= 0)
      return Promise.resolve();
    return new Promise((resolveWait) => {
      const finish = () => {
        clearTimeout(timer);
        this.eventEmitter.off("event", onEvent);
        resolveWait();
      };
      const onEvent = (event) => {
        if (event.sequence > after && (!projectId || event.projectId === projectId))
          finish();
      };
      const timer = setTimeout(finish, Math.min(58000, timeoutMs));
      this.eventEmitter.on("event", onEvent);
    });
  }
  async launchProject(projectId) {
    const project = this.requireProject(projectId);
    const previous = this.state.maintainer(projectId);
    this.state.saveMaintainer(projectId, { state: "starting", lastError: null, restartCount: previous?.restartCount ?? 0 });
    const root = this.resolveProjectStateRoot(projectId);
    const sessionRoot = resolve3(root, "sessions");
    const configPath = resolve3(root, "maintainer-config.yml");
    await mkdir(sessionRoot, { recursive: true, mode: 448 });
    await Bun.write(configPath, maintainerConfig());
    const promptPath = this.maintainerPromptPath;
    const command = [
      this.ompBinary,
      "--mode",
      "rpc",
      "--cwd",
      project.cwd,
      "--session-dir",
      sessionRoot,
      "--config",
      configPath,
      "--append-system-prompt",
      promptPath,
      "--approval-mode",
      "write",
      "--tools",
      "read,grep,glob,lsp,task,todo,web_search",
      "--no-title"
    ];
    if (project.model)
      command.push("--model", project.model);
    if (project.thinking)
      command.push("--thinking", project.thinking);
    if (previous?.sessionFile && existsSync(previous.sessionFile))
      command.push("--resume", previous.sessionFile);
    const runtime = {
      project,
      stopping: false,
      client: undefined
    };
    const client = new OmpRpcClient({
      command,
      cwd: project.cwd,
      onFrame: (frame) => this.handleFrame(project, frame),
      onExit: (code, stderr) => this.handleExit(runtime, code, stderr)
    });
    runtime.client = client;
    try {
      const rpcState = await client.start();
      if (this.shuttingDown || !this.state.project(projectId)?.enabled) {
        runtime.stopping = true;
        await client.stop();
        this.state.saveMaintainer(projectId, { state: "stopped", pid: null, heartbeatAt: Date.now() });
        return;
      }
      this.runtimes.set(projectId, runtime);
      const data = isRecord(rpcState.data) ? rpcState.data : rpcState;
      this.state.saveMaintainer(projectId, {
        state: data.isStreaming === true ? "busy" : "ready",
        pid: client.pid ?? null,
        sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
        sessionFile: typeof data.sessionFile === "string" ? data.sessionFile : previous?.sessionFile ?? null,
        startedAt: Date.now(),
        heartbeatAt: Date.now(),
        lastError: null
      });
      this.emit(this.state.appendEvent(projectId, "maintainer.ready", { pid: client.pid, sessionId: data.sessionId }));
    } catch (error) {
      runtime.stopping = true;
      const message = error instanceof Error ? error.message : String(error);
      this.state.saveMaintainer(projectId, { state: "failed", pid: null, heartbeatAt: Date.now(), lastError: message });
      this.emit(this.state.appendEvent(projectId, "maintainer.failed", { error: message }));
      throw error;
    }
  }
  async handleExit(runtime, code, stderr) {
    if (this.runtimes.get(runtime.project.id)?.client === runtime.client)
      this.runtimes.delete(runtime.project.id);
    if (runtime.stopping || this.shuttingDown)
      return;
    const current = this.state.maintainer(runtime.project.id);
    const restartCount = (current?.restartCount ?? 0) + 1;
    this.state.saveMaintainer(runtime.project.id, { state: "failed", pid: null, heartbeatAt: Date.now(), restartCount, lastError: stderr || `OMP exited with code ${code}` });
    this.emit(this.state.appendEvent(runtime.project.id, "maintainer.exited", { code, restartCount, stderr }));
    if (!this.state.project(runtime.project.id)?.enabled)
      return;
    const delay = Math.min(60000, 1000 * 2 ** Math.min(6, restartCount - 1));
    await Bun.sleep(delay);
    if (!this.shuttingDown && this.state.project(runtime.project.id)?.enabled) {
      await this.startProject(runtime.project.id).catch(() => {
        return;
      });
    }
  }
  async handleFrame(project, frame) {
    const now = Date.now();
    if (frame.type === "agent_start")
      this.state.saveMaintainer(project.id, { state: "busy", heartbeatAt: now });
    if (frame.type === "agent_end")
      this.state.saveMaintainer(project.id, { state: "ready", heartbeatAt: now });
    if (frame.type === "subagent_lifecycle" && isRecord(frame.payload)) {
      const baseSha = frame.payload.status === "started" ? await currentHead(project.cwd) : null;
      const job = this.state.saveJobLifecycle(project.id, frame.payload, baseSha, now);
      if (job && frame.payload.status === "completed" && project.autoPublish)
        this.reconcileAndPublish(project, job.id);
    }
    if (frame.type === "subagent_progress" && isRecord(frame.payload))
      this.state.saveJobProgress(project.id, frame.payload, now);
    if (frame.type === "extension_ui_request")
      this.handleUiRequest(project.id, frame, now);
    if (PERSISTED_FRAME_TYPES.has(String(frame.type)))
      this.emit(this.state.appendEvent(project.id, `omp.${String(frame.type)}`, frame, now));
    if (frame.type === "tool_execution_end" && project.autoPublish) {
      for (const job of this.state.jobs(project.id).filter((candidate) => candidate.status === "completed")) {
        this.reconcileAndPublish(project, job.id);
      }
    }
  }
  handleUiRequest(projectId, frame, now) {
    if (frame.method === "cancel" && typeof frame.targetId === "string") {
      this.state.resolveApproval(projectId, frame.targetId, "cancelled", { cancelled: true }, now);
      return;
    }
    if (typeof frame.method === "string" && BLOCKING_UI_METHODS.has(frame.method))
      this.state.saveApproval(projectId, frame, now);
  }
  async reconcileAndPublish(project, jobId) {
    for (const delay of [300, 1000, 3000]) {
      await Bun.sleep(delay);
      const job = this.state.job(project.id, jobId);
      if (!job || job.status !== "completed")
        return;
      const ref = await runCommand(["git", "show-ref", "--verify", `refs/heads/${job.branchName}`], { cwd: project.cwd });
      if (ref.exitCode !== 0)
        continue;
      try {
        await this.publish(project.id, jobId);
      } catch (error) {
        this.emit(this.state.appendEvent(project.id, "job.publish_failed", { jobId, error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }
  }
  requireProject(projectId) {
    const project = this.state.project(projectId);
    if (!project)
      throw new ServiceError("project not found", "not_found", 404);
    return project;
  }
  async requireRuntime(projectId) {
    this.requireProject(projectId);
    await this.startProject(projectId);
    const runtime = this.runtimes.get(projectId);
    if (!runtime)
      throw new ServiceError("maintainer is unavailable", "unavailable", 503);
    return runtime;
  }
  emit(event) {
    this.eventEmitter.emit("event", event);
  }
}
function maintainerConfig() {
  return `task:
  isolation:
    mode: apfs
    apply: false
    merge: branch
    commits: generic
  eager: true
  batch: true
  maxConcurrency: 4
async:
  enabled: true
  maxJobs: 8
`;
}
async function currentHead(cwd) {
  try {
    return await checkedCommand(["git", "rev-parse", "HEAD"], { cwd });
  } catch {
    return null;
  }
}

// packages/omp-orchestration/src/state.ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
class OrchestrationState {
  database;
  databasePath;
  constructor(path) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 448 });
    this.database = new Database(path, { create: true, strict: true });
    this.databasePath = path === ":memory:" ? undefined : path;
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    const schema = this.database.query("PRAGMA user_version").get()?.user_version ?? 0;
    if (schema !== 0 && schema !== SERVICE_SCHEMA) {
      this.database.close();
      throw new Error(`unsupported OMP orchestration database schema ${schema}; expected ${SERVICE_SCHEMA}`);
    }
    this.initialize();
  }
  close() {
    this.database.close();
  }
  acquireDaemonLease() {
    if (!this.databasePath)
      return () => {
        return;
      };
    const lease = new Database(`${this.databasePath}.daemon-lock.sqlite`, { create: true, strict: true });
    try {
      lease.exec("PRAGMA busy_timeout = 0");
      lease.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      lease.close();
      if (error instanceof Error && error.message.includes("database is locked")) {
        throw new Error(`OMP orchestration database is already owned: ${this.databasePath}`);
      }
      throw error;
    }
    return () => {
      try {
        lease.exec("ROLLBACK");
      } finally {
        lease.close();
      }
    };
  }
  initialize() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL UNIQUE,
        remote TEXT,
        base_branch TEXT NOT NULL,
        model TEXT,
        thinking TEXT,
        auto_publish INTEGER NOT NULL CHECK (auto_publish IN (0, 1)),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS maintainers (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        pid INTEGER,
        session_id TEXT,
        session_file TEXT,
        started_at INTEGER,
        heartbeat_at INTEGER,
        restart_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        source_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        accepted_at INTEGER NOT NULL,
        delivered_at INTEGER,
        UNIQUE(project_id, source, source_key)
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent TEXT NOT NULL,
        description TEXT,
        assignment TEXT,
        status TEXT NOT NULL,
        parent_tool_call_id TEXT,
        session_file TEXT,
        base_sha TEXT,
        branch_name TEXT NOT NULL,
        progress_json TEXT,
        error TEXT,
        pr_url TEXT,
        pr_number INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        PRIMARY KEY(project_id, id)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        method TEXT NOT NULL,
        title TEXT,
        request_json TEXT NOT NULL,
        status TEXT NOT NULL,
        response_json TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        PRIMARY KEY(project_id, id)
      );
      CREATE TABLE IF NOT EXISTS event_journal (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS event_journal_project_sequence ON event_journal(project_id, sequence);
      CREATE INDEX IF NOT EXISTS jobs_project_updated ON jobs(project_id, updated_at DESC);
      PRAGMA user_version = ${SERVICE_SCHEMA};
    `);
  }
  saveProject(input, now = Date.now()) {
    this.database.query(`
      INSERT INTO projects (id, name, cwd, remote, base_branch, model, thinking, auto_publish, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, cwd = excluded.cwd, remote = excluded.remote, base_branch = excluded.base_branch,
        model = excluded.model, thinking = excluded.thinking, auto_publish = excluded.auto_publish,
        enabled = excluded.enabled, updated_at = excluded.updated_at
    `).run(input.id, input.name, input.cwd, input.remote, input.baseBranch, input.model, input.thinking, input.autoPublish ? 1 : 0, input.enabled ? 1 : 0, now, now);
    return this.project(input.id);
  }
  project(id) {
    const row = this.database.query("SELECT * FROM projects WHERE id = ?").get(id);
    return row ? projectFromRow(row) : undefined;
  }
  projects() {
    return this.database.query("SELECT * FROM projects ORDER BY id").all().map(projectFromRow);
  }
  removeProject(id) {
    return this.database.query("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
  }
  setProjectEnabled(id, enabled, now = Date.now()) {
    this.database.query("UPDATE projects SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, now, id);
  }
  saveMaintainer(projectId, patch) {
    const current = this.maintainer(projectId) ?? {
      projectId,
      state: "stopped",
      pid: null,
      sessionId: null,
      sessionFile: null,
      startedAt: null,
      heartbeatAt: null,
      restartCount: 0,
      lastError: null
    };
    const next = { ...current, ...patch };
    this.database.query(`
      INSERT INTO maintainers (project_id, state, pid, session_id, session_file, started_at, heartbeat_at, restart_count, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET state=excluded.state, pid=excluded.pid, session_id=excluded.session_id,
        session_file=excluded.session_file, started_at=excluded.started_at, heartbeat_at=excluded.heartbeat_at,
        restart_count=excluded.restart_count, last_error=excluded.last_error
    `).run(projectId, next.state, next.pid, next.sessionId, next.sessionFile, next.startedAt, next.heartbeatAt, next.restartCount, next.lastError);
    return next;
  }
  maintainer(projectId) {
    const row = this.database.query("SELECT * FROM maintainers WHERE project_id = ?").get(projectId);
    return row ? maintainerFromRow(row) : undefined;
  }
  recoverMaintainers(now = Date.now()) {
    this.database.query(`UPDATE maintainers SET state = 'stopped', pid = NULL, heartbeat_at = ?,
      last_error = CASE WHEN state IN ('starting', 'ready', 'busy') THEN 'daemon restarted' ELSE last_error END`).run(now);
    this.database.query(`UPDATE jobs SET status = 'failed', error = 'daemon restarted while subagent was active', updated_at = ?, completed_at = ?
      WHERE status = 'running'`).run(now, now);
    this.database.query(`UPDATE jobs SET status = 'publish_failed', error = 'daemon restarted while publication was active', updated_at = ?
      WHERE status = 'publishing'`).run(now);
    this.database.query(`UPDATE approvals SET status = 'cancelled', response_json = ?, resolved_at = ? WHERE status = 'pending'`).run(JSON.stringify({ cancelled: true, reason: "daemon restarted" }), now);
  }
  acceptInbox(input, now = Date.now()) {
    const result = this.database.query(`INSERT OR IGNORE INTO inbox
      (project_id, source, source_key, kind, payload_json, accepted_at) VALUES (?, ?, ?, ?, ?, ?)`).run(input.projectId, input.source, input.sourceKey, input.kind, JSON.stringify(input.payload), now);
    const row = this.database.query("SELECT id, delivered_at FROM inbox WHERE project_id = ? AND source = ? AND source_key = ?").get(input.projectId, input.source, input.sourceKey);
    if (!row)
      throw new Error("inbox event was not persisted");
    return { id: row.id, duplicate: result.changes === 0, delivered: row.delivered_at !== null };
  }
  markInboxDelivered(id, now = Date.now()) {
    this.database.query("UPDATE inbox SET delivered_at = ? WHERE id = ?").run(now, id);
  }
  saveJobLifecycle(projectId, payload, baseSha, now = Date.now()) {
    const id = typeof payload.id === "string" ? payload.id : undefined;
    const agent = typeof payload.agent === "string" ? payload.agent : undefined;
    const lifecycle = typeof payload.status === "string" ? payload.status : undefined;
    if (!id || !agent || !lifecycle)
      return;
    const status = lifecycle === "completed" ? "completed" : lifecycle === "failed" ? "failed" : lifecycle === "aborted" ? "aborted" : "running";
    const completedAt = status === "running" ? null : now;
    this.database.query(`
      INSERT INTO jobs (id, project_id, agent, description, assignment, status, parent_tool_call_id, session_file,
        base_sha, branch_name, progress_json, error, pr_url, pr_number, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
      ON CONFLICT(project_id, id) DO UPDATE SET agent=excluded.agent,
        description=COALESCE(excluded.description, jobs.description),
        status=CASE
          WHEN jobs.status IN ('publishing', 'published', 'publish_failed') THEN jobs.status
          WHEN jobs.status IN ('completed', 'failed', 'aborted') AND excluded.status = 'running' THEN jobs.status
          ELSE excluded.status
        END,
        parent_tool_call_id=COALESCE(excluded.parent_tool_call_id, jobs.parent_tool_call_id),
        session_file=COALESCE(excluded.session_file, jobs.session_file), updated_at=excluded.updated_at,
        completed_at=COALESCE(jobs.completed_at, excluded.completed_at)
    `).run(id, projectId, agent, stringOrNull(payload.description), status, stringOrNull(payload.parentToolCallId), stringOrNull(payload.sessionFile), baseSha, `omp/task/${id}`, now, now, completedAt);
    return this.job(projectId, id);
  }
  saveJobProgress(projectId, payload, now = Date.now()) {
    const progress = recordOrNull(payload.progress);
    const id = typeof progress?.id === "string" ? progress.id : undefined;
    if (!id)
      return;
    this.database.query(`UPDATE jobs SET assignment=COALESCE(?, assignment), progress_json=?, session_file=COALESCE(?, session_file), updated_at=?
      WHERE project_id=? AND id=?`).run(stringOrNull(payload.assignment), JSON.stringify(progress), stringOrNull(payload.sessionFile), now, projectId, id);
    return this.job(projectId, id);
  }
  setJobPublishState(projectId, id, input, now = Date.now()) {
    this.database.query(`UPDATE jobs SET status=?, error=?, pr_url=COALESCE(?, pr_url), pr_number=COALESCE(?, pr_number), updated_at=?
      WHERE project_id=? AND id=?`).run(input.status, input.error ?? null, input.prUrl ?? null, input.prNumber ?? null, now, projectId, id);
  }
  job(projectId, id) {
    const row = this.database.query("SELECT * FROM jobs WHERE project_id = ? AND id = ?").get(projectId, id);
    return row ? jobFromRow(row) : undefined;
  }
  jobs(projectId) {
    const rows = projectId ? this.database.query("SELECT * FROM jobs WHERE project_id = ? ORDER BY updated_at DESC").all(projectId) : this.database.query("SELECT * FROM jobs ORDER BY updated_at DESC").all();
    return rows.map(jobFromRow);
  }
  saveApproval(projectId, request, now = Date.now()) {
    const id = typeof request.id === "string" ? request.id : undefined;
    const method = typeof request.method === "string" ? request.method : undefined;
    if (!id || !method)
      return;
    this.database.query(`INSERT INTO approvals
      (id, project_id, method, title, request_json, status, response_json, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)
      ON CONFLICT(project_id, id) DO UPDATE SET request_json=excluded.request_json, title=excluded.title`).run(id, projectId, method, stringOrNull(request.title), JSON.stringify(request), now);
    return this.approval(projectId, id);
  }
  resolveApproval(projectId, id, status, response, now = Date.now()) {
    return this.database.query(`UPDATE approvals SET status=?, response_json=?, resolved_at=?
      WHERE project_id=? AND id=? AND status='pending'`).run(status, JSON.stringify(response), now, projectId, id).changes > 0;
  }
  approval(projectId, id) {
    const row = this.database.query("SELECT * FROM approvals WHERE project_id=? AND id=?").get(projectId, id);
    return row ? approvalFromRow(row) : undefined;
  }
  approvals(projectId, pendingOnly = false) {
    const condition = `${projectId ? "project_id = ?" : "1 = 1"}${pendingOnly ? " AND status = 'pending'" : ""}`;
    const rows = projectId ? this.database.query(`SELECT * FROM approvals WHERE ${condition} ORDER BY created_at DESC`).all(projectId) : this.database.query(`SELECT * FROM approvals WHERE ${condition} ORDER BY created_at DESC`).all();
    return rows.map(approvalFromRow);
  }
  appendEvent(projectId, kind, payload, now = Date.now()) {
    const result = this.database.query("INSERT INTO event_journal (project_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)").run(projectId, kind, JSON.stringify(payload), now);
    return { sequence: Number(result.lastInsertRowid), projectId, kind, payload, createdAt: now };
  }
  events(after = 0, projectId, limit = 200) {
    const boundedLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
    const rows = projectId ? this.database.query(`SELECT * FROM event_journal WHERE sequence > ? AND project_id = ? ORDER BY sequence LIMIT ?`).all(after, projectId, boundedLimit) : this.database.query(`SELECT * FROM event_journal WHERE sequence > ? ORDER BY sequence LIMIT ?`).all(after, boundedLimit);
    return rows.map(eventFromRow);
  }
}
function projectFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    remote: row.remote,
    baseBranch: row.base_branch,
    model: row.model,
    thinking: row.thinking,
    autoPublish: row.auto_publish === 1,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function maintainerFromRow(row) {
  return {
    projectId: row.project_id,
    state: row.state,
    pid: row.pid,
    sessionId: row.session_id,
    sessionFile: row.session_file,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    restartCount: row.restart_count,
    lastError: row.last_error
  };
}
function jobFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    agent: row.agent,
    description: row.description,
    assignment: row.assignment,
    status: row.status,
    parentToolCallId: row.parent_tool_call_id,
    sessionFile: row.session_file,
    baseSha: row.base_sha,
    branchName: row.branch_name,
    progress: parseJson(row.progress_json),
    error: row.error,
    prUrl: row.pr_url,
    prNumber: row.pr_number,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}
function approvalFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    method: row.method,
    title: row.title,
    request: parseJson(row.request_json),
    status: row.status,
    response: parseJson(row.response_json),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  };
}
function eventFromRow(row) {
  return { sequence: row.sequence, projectId: row.project_id, kind: row.kind, payload: parseJson(row.payload_json), createdAt: row.created_at };
}
function parseJson(value) {
  return value === null ? null : JSON.parse(value);
}
function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}
function recordOrNull(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

// packages/omp-orchestration/src/daemon.ts
async function runDaemon() {
  process.umask(63);
  for (const directory of new Set([ORCHESTRATION_HOME, dirname2(DATABASE_PATH), dirname2(SOCKET_PATH)])) {
    await preparePrivateDirectory(directory);
  }
  const state = new OrchestrationState(DATABASE_PATH);
  const releaseLease = state.acquireDaemonLease();
  const manager = new OmpManager(state);
  const local = createLocalServer(manager);
  const http = HTTP_PORT === undefined ? undefined : createHttpServer(manager, {
    token: HTTP_TOKEN ?? (() => {
      throw new Error("OMP_ORCHESTRATION_HTTP_TOKEN is required when HTTP ingress is enabled");
    })(),
    allowedProjects: HTTP_ALLOWED_PROJECTS
  });
  let shuttingDown = false;
  const shutdown = async (exitCode) => {
    if (shuttingDown)
      return;
    shuttingDown = true;
    await Promise.allSettled([manager.stop(), closeServer(http), closeServer(local)]);
    await unlink(SOCKET_PATH).catch(() => {
      return;
    });
    releaseLease();
    state.close();
    process.exit(exitCode);
  };
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => void shutdown(0));
  try {
    await prepareSocket(SOCKET_PATH);
    await listenUnix(local, SOCKET_PATH);
    await chmod(SOCKET_PATH, 384);
    if (http && HTTP_PORT !== undefined)
      await listenTcp(http, HTTP_PORT, HTTP_HOST);
    console.log(`omp-orchestrationd listening on ${SOCKET_PATH}${HTTP_PORT === undefined ? "" : ` and http://${HTTP_HOST}:${HTTP_PORT}`}`);
    await manager.start();
  } catch (error) {
    await Promise.allSettled([manager.stop(), closeServer(http), closeServer(local)]);
    await unlink(SOCKET_PATH).catch(() => {
      return;
    });
    releaseLease();
    state.close();
    throw error;
  }
}
async function prepareSocket(path) {
  await mkdir2(dirname2(path), { recursive: true, mode: 448 });
  try {
    const metadata = await lstat(path);
    if (!metadata.isSocket())
      throw new Error(`refusing to replace non-socket path ${path}`);
    if (await socketIsLive(path))
      throw new Error(`daemon already running on ${path}`);
    await unlink(path);
  } catch (error) {
    if (!(error instanceof Error && ("code" in error) && error.code === "ENOENT"))
      throw error;
  }
}
async function preparePrivateDirectory(path) {
  try {
    await mkdir2(path, { recursive: true, mode: 448 });
  } catch (error) {
    if (!(error instanceof Error && ("code" in error) && error.code === "EEXIST"))
      throw error;
  }
  const metadata = await lstat(path);
  const uid = process.getuid?.();
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error(`private runtime path is not a directory: ${path}`);
  if (uid !== undefined && metadata.uid !== uid)
    throw new Error(`private runtime path is not owned by the current user: ${path}`);
  if ((metadata.mode & 63) !== 0)
    throw new Error(`private runtime path must not grant group or world access: ${path}`);
}
function socketIsLive(path) {
  return new Promise((resolveLive) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolveLive(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolveLive(false);
    });
  });
}
function listenUnix(server, path) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}
function listenTcp(server, port, host) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}
function closeServer(server) {
  if (!server?.listening)
    return Promise.resolve();
  return new Promise((resolveClose) => {
    server.close(() => resolveClose());
    const closable = server;
    closable.closeActiveConnections?.();
    closable.closeAllConnections?.();
  });
}
if (import.meta.main) {
  await runDaemon().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
    process.exit(1);
  });
}
export {
  runDaemon
};
