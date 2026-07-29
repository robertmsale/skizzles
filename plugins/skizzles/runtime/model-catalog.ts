#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const DEFAULT_MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MODEL_CACHE_TTL_MS = 300_000;
const LUNA_MODEL = "gpt-5.6-luna";
const REQUIRED_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", LUNA_MODEL];

type JsonObject = Record<string, unknown>;
type CatalogSource = "cache" | "bundled";

export interface CatalogRefreshOptions {
  codexHome: string;
  codexBinary: string;
  output?: string;
  status?: string;
  cache?: string;
  now?: Date;
  commandTimeoutMs?: number;
  maxCatalogBytes?: number;
  maxStderrBytes?: number;
}

export interface CatalogRefreshResult {
  ok: true;
  source: CatalogSource;
  updated: boolean;
  lunaOverlay: "applied" | "upstream-v2";
  catalogChanged: boolean;
  generation: string;
  output: string;
}

interface CommandLimits {
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

interface CommandResult {
  stdout: Uint8Array;
  stderr: string;
  exitCode: number;
}

function commandEnvironment(codexHome?: string): Record<string, string> {
  const environment: Record<string, string> = { NO_COLOR: "1" };
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"] as const) {
    const value = globalThis.process.env[name];
    if (value) environment[name] = value;
  }
  if (codexHome) environment.CODEX_HOME = codexHome;
  return environment;
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function catalog(value: unknown): JsonObject {
  const root = object(value, "model catalog");
  if (!Array.isArray(root.models) || root.models.length === 0) throw new Error("model catalog must contain models");
  root.models.forEach((model, index) => object(model, `model ${index}`));
  return root;
}

function assertCompleteCatalog(value: unknown): JsonObject {
  const root = catalog(value);
  const slugs = new Set((root.models as JsonObject[]).map((model) => model.slug));
  const missing = REQUIRED_MODELS.filter((slug) => !slugs.has(slug));
  if (missing.length > 0) throw new Error(`model catalog is incomplete; missing ${missing.join(", ")}`);
  return root;
}

export function applyLunaV2Overlay(value: unknown): { catalog: JsonObject; overlay: "applied" | "upstream-v2" } {
  const cloned = assertCompleteCatalog(structuredClone(value));
  const matches = (cloned.models as JsonObject[]).filter((model) => model.slug === LUNA_MODEL);
  if (matches.length !== 1) throw new Error(`expected exactly one ${LUNA_MODEL} model, found ${matches.length}`);
  const luna = matches[0]!;
  if (luna.multi_agent_version === "v2") return { catalog: cloned, overlay: "upstream-v2" };
  if (luna.multi_agent_version !== "v1") throw new Error(`${LUNA_MODEL} has unexpected multi_agent_version`);
  luna.multi_agent_version = "v2";
  return { catalog: cloned, overlay: "applied" };
}

async function parseJsonFile(path: string, maxBytes: number): Promise<unknown> {
  const file = Bun.file(path);
  if (file.size > maxBytes) throw new Error("catalog input exceeds size limit");
  return JSON.parse(await file.text());
}

async function collectBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  label: string,
  terminate: () => void,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        terminate();
        throw new Error(`${label} exceeds ${limit} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function runCodex(codexBinary: string, args: string[], limits: CommandLimits, codexHome?: string): Promise<CommandResult> {
  const child = Bun.spawn([codexBinary, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: commandEnvironment(codexHome),
  });
  let timedOut = false;
  const terminate = (): void => { child.kill("SIGKILL"); };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, limits.timeoutMs);
  try {
    const [stdout, stderrBytes, exitCode] = await Promise.all([
      collectBounded(child.stdout, limits.maxStdoutBytes, "codex stdout", terminate),
      collectBounded(child.stderr, limits.maxStderrBytes, "codex stderr", terminate),
      child.exited,
    ]);
    if (timedOut) throw new Error(`codex command timed out after ${limits.timeoutMs}ms`);
    return { stdout, stderr: new TextDecoder().decode(stderrBytes), exitCode };
  } catch (error) {
    terminate();
    await child.exited.catch(() => undefined);
    if (timedOut) throw new Error(`codex command timed out after ${limits.timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function clientVersion(codexBinary: string, limits: CommandLimits): Promise<string> {
  const result = await runCodex(codexBinary, ["--version"], { ...limits, maxStdoutBytes: 1024 });
  if (result.exitCode !== 0) throw new Error(`codex version failed (${result.exitCode}): ${result.stderr.trim().slice(0, 240)}`);
  const match = new TextDecoder().decode(result.stdout).match(/\b(\d+\.\d+\.\d+)(?:[-+\s]|$)/);
  if (!match) throw new Error("codex version did not contain a whole semantic version");
  return match[1]!;
}

async function cachedCatalog(path: string, expectedVersion: string, now: Date, maxBytes: number): Promise<JsonObject | undefined> {
  try {
    const root = object(await parseJsonFile(path, maxBytes), "models cache");
    if (root.client_version !== expectedVersion) return undefined;
    if (typeof root.fetched_at !== "string") return undefined;
    const fetchedAt = Date.parse(root.fetched_at);
    if (!Number.isFinite(fetchedAt) || now.getTime() - fetchedAt > MODEL_CACHE_TTL_MS) return undefined;
    return assertCompleteCatalog({ models: root.models });
  } catch {
    return undefined;
  }
}

async function bundledCatalog(codexBinary: string, limits: CommandLimits): Promise<JsonObject> {
  const result = await runCodex(codexBinary, ["debug", "models", "--bundled"], limits);
  if (result.exitCode !== 0) throw new Error(`codex bundled catalog failed (${result.exitCode}): ${result.stderr.trim().slice(0, 240)}`);
  return assertCompleteCatalog(JSON.parse(new TextDecoder().decode(result.stdout)));
}

async function ensurePrivateRegularFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${path} must be a regular file`);
  await chmod(path, 0o600);
}

async function writeAtomic(path: string, contents: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await ensurePrivateRegularFile(path);
    if (await readFile(path, "utf8") === contents) {
      return false;
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const temporary = join(dirname(path), `.${globalThis.crypto.randomUUID()}.tmp`);
  await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  return true;
}

async function preflightCatalog(codexBinary: string, contents: string, limits: CommandLimits): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "skizzles-model-catalog-preflight-"));
  const candidate = join(home, "candidate.json");
  try {
    await writeFile(candidate, contents, { mode: 0o600, flag: "wx" });
    const override = `model_catalog_json=${JSON.stringify(candidate)}`;
    const result = await runCodex(codexBinary, ["debug", "models", "-c", override], limits, home);
    if (result.exitCode !== 0) throw new Error(`catalog preflight failed (${result.exitCode}): ${result.stderr.trim().slice(0, 240)}`);
    const loaded = assertCompleteCatalog(JSON.parse(new TextDecoder().decode(result.stdout)));
    const loadedLuna = (loaded.models as JsonObject[]).filter((entry) => entry.slug === LUNA_MODEL);
    if (loadedLuna.length !== 1 || loadedLuna[0]!.multi_agent_version !== "v2") throw new Error("catalog preflight did not load Luna V2");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function digest(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function refreshCatalog(options: CatalogRefreshOptions): Promise<CatalogRefreshResult> {
  const codexHome = resolve(options.codexHome);
  const codexBinary = resolve(options.codexBinary);
  const output = resolve(options.output ?? join(codexHome, "skizzles", "model-catalog.json"));
  const status = resolve(options.status ?? join(codexHome, "skizzles", "model-catalog-status.json"));
  const cache = resolve(options.cache ?? join(codexHome, "models_cache.json"));
  const limits: CommandLimits = {
    timeoutMs: options.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxStdoutBytes: options.maxCatalogBytes ?? DEFAULT_MAX_CATALOG_BYTES,
    maxStderrBytes: options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
  };
  const version = await clientVersion(codexBinary, limits);
  const cached = await cachedCatalog(cache, version, options.now ?? new Date(), limits.maxStdoutBytes);
  let source: CatalogSource = cached ? "cache" : "bundled";
  let sourceCatalog = cached ?? await bundledCatalog(codexBinary, limits);
  let overlaid = applyLunaV2Overlay(sourceCatalog);
  let contents = `${JSON.stringify(overlaid.catalog, null, 2)}\n`;
  try {
    await preflightCatalog(codexBinary, contents, limits);
  } catch (error) {
    if (source !== "cache") throw error;
    source = "bundled";
    sourceCatalog = await bundledCatalog(codexBinary, limits);
    overlaid = applyLunaV2Overlay(sourceCatalog);
    contents = `${JSON.stringify(overlaid.catalog, null, 2)}\n`;
    await preflightCatalog(codexBinary, contents, limits);
  }
  const updated = await writeAtomic(output, contents);
  const result: CatalogRefreshResult = {
    ok: true,
    source,
    updated,
    lunaOverlay: overlaid.overlay,
    catalogChanged: updated,
    generation: digest(contents),
    output,
  };
  await writeAtomic(status, `${JSON.stringify({ ...result, checkedAt: new Date().toISOString() }, null, 2)}\n`);
  return result;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export interface LaunchAgentValues {
  bun: string;
  script: string;
  codexHome: string;
  codexBinary: string;
}

export function renderLaunchAgent(template: string, values: LaunchAgentValues): string {
  const replacements: Record<string, string> = {
    __BUN_ABSOLUTE_PATH__: values.bun,
    __SCRIPT_ABSOLUTE_PATH__: values.script,
    __CODEX_HOME_ABSOLUTE_PATH__: values.codexHome,
    __CODEX_BINARY_ABSOLUTE_PATH__: values.codexBinary,
    __MODELS_CACHE_ABSOLUTE_PATH__: join(values.codexHome, "models_cache.json"),
  };
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    if (!isAbsolute(value)) throw new Error(`${placeholder} must be absolute`);
    rendered = rendered.replaceAll(placeholder, xml(resolve(value)));
  }
  if (/__[A-Z0-9_]+__/.test(rendered)) throw new Error("launch agent template contains unresolved placeholders");
  return rendered;
}

function value(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(args: string[], flag: string): string {
  const found = value(args, flag);
  if (!found) throw new Error(`${flag} is required`);
  return found;
}

async function main(args: string[]): Promise<void> {
  const command = args.shift();
  if (command === "refresh" || command === "service") {
    const codexHome = required(args, "--codex-home");
    const status = value(args, "--status") ?? join(resolve(codexHome), "skizzles", "model-catalog-status.json");
    const output = value(args, "--output");
    const cache = value(args, "--cache");
    let result: CatalogRefreshResult;
    try {
      result = await refreshCatalog({
        codexHome,
        codexBinary: required(args, "--codex-binary"),
        status,
        ...(output === undefined ? {} : { output }),
        ...(cache === undefined ? {} : { cache }),
      });
    } catch (error) {
      if (command === "service") {
        const message = error instanceof Error ? error.message.slice(0, 240) : "model catalog refresh failed";
        await writeAtomic(resolve(status), `${JSON.stringify({ ok: false, error: message, checkedAt: new Date().toISOString() }, null, 2)}\n`);
      }
      throw error;
    }
    if (command === "refresh" && (result.updated || !args.includes("--quiet-unchanged"))) console.log(JSON.stringify(result));
    return;
  }
  if (command === "render-launch-agent") {
    const template = required(args, "--template");
    const output = required(args, "--output");
    const rendered = renderLaunchAgent(await readFile(template, "utf8"), {
      bun: required(args, "--bun"),
      script: required(args, "--script"),
      codexHome: required(args, "--codex-home"),
      codexBinary: required(args, "--codex-binary"),
    });
    await writeAtomic(output, rendered);
    console.log(JSON.stringify({ ok: true, output: resolve(output) }));
    return;
  }
  throw new Error("usage: model-catalog.ts <refresh|service|render-launch-agent> [options]");
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "model catalog operation failed");
    process.exit(1);
  }
}
