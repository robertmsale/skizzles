import { chmod, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";

const home = process.env.HOME;
if (!home) throw new Error("HOME is required");
const clientOnly = process.argv.slice(2).includes("--client-only");
const root = resolve(import.meta.dir, "..");
const skizzlesRoot = resolve(root, "../..");
const bin = join(home, ".local/bin");
const skills = join(home, ".codex/skills");
const t3Home = process.env.T3_HOME ?? join(home, ".t3");
const socketPath = process.env.T3_ORCHESTRATION_SOCKET ?? join(t3Home, "t3-orchestration.sock");
const launchAgents = join(home, "Library/LaunchAgents");
const launchAgentLabel = "io.github.t3-orchestration.daemon";
const launchAgent = join(launchAgents, `${launchAgentLabel}.plist`);
if (clientOnly) {
  for (const path of [join(bin, "t3-orchestrationd"), launchAgent]) {
    try {
      await lstat(path);
      throw new Error(`Client-only install refuses existing host artifact ${path}; remove the host installation explicitly first`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("ENOENT")) throw error;
    }
  }
}
await mkdir(bin, { recursive: true, mode: 0o755 });
await mkdir(skills, { recursive: true, mode: 0o755 });
const binaries = [
  ["t3ctl", join(root, "src/cli.ts")],
  ...(!clientOnly ? [["t3-orchestrationd", join(root, "src/daemon.ts")] as const] : []),
] as const;
for (const [name, target] of binaries) {
  const link = join(bin, name);
  try {
    const existing = await lstat(link);
    if (!existing.isSymbolicLink()) throw new Error(`Refusing to replace non-symlink ${link}`);
    await rm(link);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ENOENT")) throw error;
  }
  await symlink(target, link);
}
const skillTarget = join(skizzlesRoot, "skills/t3-orchestration");
const skillLink = join(skills, "t3-orchestration");
try {
  const existing = await lstat(skillLink);
  if (!existing.isSymbolicLink()) throw new Error(`Refusing to replace non-symlink ${skillLink}`);
  await rm(skillLink);
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes("ENOENT")) throw error;
}
await symlink(skillTarget, skillLink);
if (clientOnly) {
  console.log(JSON.stringify({ root, clientOnly: true, binary: join(bin, "t3ctl"), skill: skillLink }));
  process.exit(0);
}

await mkdir(t3Home, { recursive: true, mode: 0o700 });
await chmod(t3Home, 0o700);
await mkdir(launchAgents, { recursive: true, mode: 0o755 });
const escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const daemonPath = join(root, "src/daemon.ts");
const bunPath = (await Bun.$`command -v bun`.quiet()).text().trim();
if (!bunPath || bunPath.includes("\n")) throw new Error("Could not resolve a stable bun executable");
const launchPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const inheritedConfig = [
  "CODEX_HOME",
  "T3_HOME",
  "T3_ORCHESTRATION_SOCKET",
  "T3_ORCHESTRATION_HTTP_SOCKET",
  "T3_ORCHESTRATION_TAILSCALE_USERS",
  "T3_ORCHESTRATION_KEYCHAIN_ACCOUNT",
]
  .flatMap((name) => process.env[name] ? [`<string>${name}=${escapeXml(process.env[name]!)}</string>`] : []);
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${launchAgentLabel}</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/env</string><string>-i</string>
    <string>HOME=${escapeXml(home)}</string><string>PATH=${escapeXml(launchPath)}</string>
    ${inheritedConfig.join("")}
    <string>${escapeXml(bunPath)}</string><string>${escapeXml(daemonPath)}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escapeXml(join(t3Home, "t3-orchestrationd.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(t3Home, "t3-orchestrationd.err.log"))}</string>
</dict></plist>
`;
let previousPlist: string | null = null;
try { previousPlist = await readFile(launchAgent, "utf8"); } catch (error) {
  if (!(error instanceof Error) || !error.message.includes("ENOENT")) throw error;
}
const temporaryLaunchAgent = `${launchAgent}.tmp-${process.pid}`;
await writeFile(temporaryLaunchAgent, plist, { mode: 0o644 });
await rename(temporaryLaunchAgent, launchAgent);
const uid = Number(process.env.UID ?? (await Bun.$`id -u`.quiet()).text().trim());
if (!Number.isInteger(uid) || uid < 0) throw new Error("Could not determine the current macOS user id");
const domain = `gui/${uid}`;
const service = `${domain}/${launchAgentLabel}`;
const serviceIsLoaded = async (label: string) => (await Bun.$`launchctl print ${domain}/${label}`.nothrow().quiet()).exitCode === 0;
const isLoaded = () => serviceIsLoaded(launchAgentLabel);
if (await isLoaded() && previousPlist !== plist) {
  const bootout = await Bun.$`launchctl bootout ${service}`.nothrow().quiet();
  if (bootout.exitCode !== 0) throw new Error(`Could not unload ${launchAgentLabel}: ${bootout.stderr.toString().trim()}`);
  for (let attempt = 0; attempt < 50 && await isLoaded(); attempt++) await Bun.sleep(100);
  if (await isLoaded()) throw new Error(`Timed out waiting for ${launchAgentLabel} to unload`);
}
if (!await isLoaded()) {
  let bootstrapError = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    const bootstrap = await Bun.$`launchctl bootstrap ${domain} ${launchAgent}`.nothrow().quiet();
    if (bootstrap.exitCode === 0) { bootstrapError = ""; break; }
    bootstrapError = bootstrap.stderr.toString().trim();
    await Bun.sleep(250);
  }
  if (bootstrapError) throw new Error(`Could not install ${launchAgentLabel}: ${bootstrapError}`);
}
// Source files are loaded into Bun's process. Restart even when the plist is
// unchanged so reinstalling a source update cannot leave stale daemon code.
const kickstart = await Bun.$`launchctl kickstart -k ${domain}/${launchAgentLabel}`.nothrow().quiet();
if (kickstart.exitCode !== 0) throw new Error(`Could not start ${launchAgentLabel}: ${kickstart.stderr.toString().trim()}`);
const socketReady = () => new Promise<boolean>((resolve) => {
  const socket = connect(socketPath);
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => { socket.destroy(); resolve(false); });
});
let ready = await socketReady();
for (let attempt = 0; attempt < 100 && !ready; attempt++) { await Bun.sleep(100); ready = await socketReady(); }
if (!ready) throw new Error(`${launchAgentLabel} started but its Unix socket did not become ready`);
if (process.env.T3_ORCHESTRATION_TAILSCALE_USERS?.trim()) {
  const httpSocketPath = process.env.T3_ORCHESTRATION_HTTP_SOCKET ?? join(t3Home, "t3-orchestration-http.sock");
  const gatewayReady = () => new Promise<boolean>((resolve) => {
    const socket = connect(httpSocketPath);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
  });
  let httpReady = await gatewayReady();
  for (let attempt = 0; attempt < 100 && !httpReady; attempt++) { await Bun.sleep(100); httpReady = await gatewayReady(); }
  if (!httpReady) throw new Error(`${launchAgentLabel} started but its Tailscale gateway socket did not become ready`);
}
console.log(JSON.stringify({ root, binaries: [join(bin, "t3ctl"), join(bin, "t3-orchestrationd")], skill: skillLink, launchAgent }));
