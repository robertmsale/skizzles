import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const home = process.env.HOME ?? (() => { throw new Error("HOME is required"); })();
export const REMOTE_CONFIG_PATH = process.env.T3_ORCHESTRATION_REMOTE_CONFIG
  ?? join(home, ".config/t3-orchestration/client.json");

type RemoteConfig = { url: string };

export function normalizeRemoteUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); }
  catch { throw new Error("Remote orchestration URL must be a valid HTTPS URL"); }
  if (url.protocol !== "https:") throw new Error("Remote orchestration URL must use HTTPS");
  if (!url.hostname.toLowerCase().endsWith(".ts.net")) {
    throw new Error("Remote orchestration URL must use a Tailscale ts.net hostname");
  }
  if (url.username || url.password) throw new Error("Remote orchestration URL must not contain credentials");
  if (url.search || url.hash) throw new Error("Remote orchestration URL must not contain a query or fragment");
  if (url.pathname !== "/") throw new Error("Remote orchestration URL must not contain a path");
  return url.origin;
}

export async function configuredRemoteUrl(): Promise<string | undefined> {
  const environmentUrl = process.env.T3_ORCHESTRATION_REMOTE_URL?.trim();
  if (environmentUrl) return normalizeRemoteUrl(environmentUrl);
  try {
    const parsed = JSON.parse(await readFile(REMOTE_CONFIG_PATH, "utf8")) as Partial<RemoteConfig>;
    if (typeof parsed.url !== "string") throw new Error("Remote orchestration config is malformed");
    return normalizeRemoteUrl(parsed.url);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function requireLocalReaperTransport(): Promise<void> {
  const explicit = process.env.T3_ORCHESTRATION_REMOTE_CONFIG?.trim();
  if (explicit) {
    const path = isAbsolute(explicit) ? explicit : resolve(explicit);
    try {
      await readFile(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new Error(`explicit remote orchestration config is unavailable: ${path}`);
      }
      throw error;
    }
  }
  if (await configuredRemoteUrl()) {
    throw new Error("t3-worktree-reaper is host-local and refuses remote t3ctl mode; it only talks to the existing local t3-orchestrationd socket");
  }
}

export async function configureRemoteUrl(input: string): Promise<string> {
  const url = normalizeRemoteUrl(input);
  const parent = dirname(REMOTE_CONFIG_PATH);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const temporary = `${REMOTE_CONFIG_PATH}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify({ url }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, REMOTE_CONFIG_PATH);
  await chmod(REMOTE_CONFIG_PATH, 0o600);
  return url;
}

export async function clearRemoteUrl(): Promise<void> {
  await rm(REMOTE_CONFIG_PATH, { force: true });
}
