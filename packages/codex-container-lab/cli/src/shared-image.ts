import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

export const SHARED_IMAGE_SCHEMA = "v1";
export const SHARED_IMAGE_KIND = "environment";
export const SHARED_IMAGE_NAME = "skizzles-shared-image";
export const SHARED_IMAGE_BUILDER_NAME = "skizzles-shared-image";
export const SHARED_IMAGE_BUILDER_DRIVER = "docker-container";
export const SHARED_IMAGE_BUILDER_IDENTITY_ENV = "SKIZZLES_SHARED_IMAGE_BUILDER";
export const SHARED_IMAGE_BUILDER_IDENTITY = "v1";

export const SHARED_IMAGE_LABEL_MANAGED = "io.openai.skizzles.shared-image.managed";
export const SHARED_IMAGE_LABEL_SCHEMA = "io.openai.skizzles.shared-image.schema";
export const SHARED_IMAGE_LABEL_KIND = "io.openai.skizzles.shared-image.kind";
export const SHARED_IMAGE_LABEL_PROFILE = "io.openai.skizzles.shared-image.profile";
export const SHARED_IMAGE_LABEL_DIGEST = "io.openai.skizzles.shared-image.digest";
export const SHARED_IMAGE_LABEL_REPO = "io.openai.skizzles.shared-image.repo";
export const SHARED_IMAGE_LABEL_PLATFORM = "io.openai.skizzles.shared-image.platform";
export const SHARED_IMAGE_LABEL_CREATED_AT = "io.openai.skizzles.shared-image.created-at";

export const SHARED_IMAGE_LABELS_REQUIRED = [
  SHARED_IMAGE_LABEL_MANAGED,
  SHARED_IMAGE_LABEL_SCHEMA,
  SHARED_IMAGE_LABEL_KIND,
  SHARED_IMAGE_LABEL_PROFILE,
  SHARED_IMAGE_LABEL_DIGEST,
  SHARED_IMAGE_LABEL_REPO,
  SHARED_IMAGE_LABEL_PLATFORM,
  SHARED_IMAGE_LABEL_CREATED_AT,
] as const;

const MAX_CONTEXT_WALK_ENTRIES = 20_000;
const MAX_SENT_FILES = 4_096;
const MAX_SENT_BYTES = 256 * 1024 * 1024;
const MAX_DOCKERFILE_BYTES = 1024 * 1024;

export type SharedImageProfile = {
  name: string;
  context: string;
  dockerfile: string;
  target?: string;
  platform: string;
  buildArgs: Record<string, string>;
  services: string[];
};

export type SharedImageDigestInput = {
  profile: SharedImageProfile;
  dockerfileRelative: string;
  dockerfileSha256: string;
  dockerignoreSha256: string | null;
  files: SharedImageContextFile[];
};

export type SharedImageContextFile = {
  path: string;
  kind: "file" | "symlink" | "directory";
  sha256: string;
  mode: number;
  target?: string;
};

export type SharedImageFingerprint = {
  digest: string;
  tag: string;
  dockerfileRelative: string;
  dockerfileSha256: string;
  files: SharedImageContextFile[];
  dockerignoreKind: SharedImageDockerignoreKind;
  dockerignoreBytes: Uint8Array | null;
};

export type SharedImageDockerignoreKind = "none" | "context" | "dockerfile";

const UNSAFE_SENT_PATHS = /(?:^|\/)(?:\.git|\.ssh)(?:\/|$)/;
const UNSAFE_SENT_FILES = /(?:^|\/)(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|\.netrc|\.env|\.env\.[^/]+|credentials)$/;

export function sharedImageTag(digest: string): string {
  return `${SHARED_IMAGE_NAME}:env-${digest}`;
}

export function isPlatform(value: string): boolean {
  return /^[a-z0-9]+\/[a-z0-9_]+(?:\/[a-z0-9_]+)?$/.test(value);
}

export function sharedImageLabels(input: {
  profile: string;
  digest: string;
  repoHash: string;
  platform: string;
  createdAt: string;
}): Record<string, string> {
  return {
    [SHARED_IMAGE_LABEL_MANAGED]: "true",
    [SHARED_IMAGE_LABEL_SCHEMA]: SHARED_IMAGE_SCHEMA,
    [SHARED_IMAGE_LABEL_KIND]: SHARED_IMAGE_KIND,
    [SHARED_IMAGE_LABEL_PROFILE]: input.profile,
    [SHARED_IMAGE_LABEL_DIGEST]: input.digest,
    [SHARED_IMAGE_LABEL_REPO]: input.repoHash,
    [SHARED_IMAGE_LABEL_PLATFORM]: input.platform,
    [SHARED_IMAGE_LABEL_CREATED_AT]: input.createdAt,
  };
}

export function hasExactSharedImageLabels(
  labels: Record<string, unknown> | undefined,
  expected: {
    profile: string;
    digest: string;
    repoHash?: string;
    platform: string;
  },
): boolean {
  if (!labels) return false;
  const extraNamespace = Object.keys(labels).filter((key) =>
    key.startsWith("io.openai.skizzles.shared-image.") &&
    !(SHARED_IMAGE_LABELS_REQUIRED as readonly string[]).includes(key),
  );
  if (extraNamespace.length > 0) return false;
  return labels[SHARED_IMAGE_LABEL_MANAGED] === "true" &&
    labels[SHARED_IMAGE_LABEL_SCHEMA] === SHARED_IMAGE_SCHEMA &&
    labels[SHARED_IMAGE_LABEL_KIND] === SHARED_IMAGE_KIND &&
    labels[SHARED_IMAGE_LABEL_PROFILE] === expected.profile &&
    labels[SHARED_IMAGE_LABEL_DIGEST] === expected.digest &&
    typeof labels[SHARED_IMAGE_LABEL_REPO] === "string" &&
    /^[a-f0-9]{12}$/.test(labels[SHARED_IMAGE_LABEL_REPO]) &&
    (expected.repoHash === undefined || labels[SHARED_IMAGE_LABEL_REPO] === expected.repoHash) &&
    labels[SHARED_IMAGE_LABEL_PLATFORM] === expected.platform &&
    typeof labels[SHARED_IMAGE_LABEL_CREATED_AT] === "string" &&
    isTimestamp(labels[SHARED_IMAGE_LABEL_CREATED_AT]);
}

export function computeSharedImageDigest(input: SharedImageDigestInput): string {
  const canonical = {
    v: 1,
    kind: SHARED_IMAGE_KIND,
    profile: input.profile.name,
    dockerfile: {
      path: input.dockerfileRelative,
      sha256: input.dockerfileSha256,
    },
    context: {
      dockerignore: input.dockerignoreSha256,
      files: [...input.files].sort((left, right) => left.path.localeCompare(right.path)),
    },
    target: input.profile.target ?? null,
    platform: input.profile.platform,
    buildArgs: Object.fromEntries(Object.entries(input.profile.buildArgs).sort(([left], [right]) => left.localeCompare(right))),
  };
  return sha256Hex(JSON.stringify(canonical));
}

export async function fingerprintSharedImage(
  repoRoot: string,
  profile: SharedImageProfile,
): Promise<SharedImageFingerprint> {
  const root = await realpath(resolve(repoRoot));
  const context = await realDirectoryInside(root, profile.context, "shared image context");
  const dockerfile = await realFileInside(root, profile.dockerfile, "shared image Dockerfile");
  const dockerfileRelative = posixRelative(root, dockerfile);
  const dockerfileBytes = await readFile(dockerfile);
  if (dockerfileBytes.byteLength > MAX_DOCKERFILE_BYTES) {
    throw new Error(`shared image ${profile.name}: Dockerfile exceeds ${MAX_DOCKERFILE_BYTES} bytes`);
  }
  const dockerfileText = dockerfileBytes.toString("utf8");
  rejectUnsafeDockerfile(profile.name, dockerfileText, profile.buildArgs);
  rejectUnaccountedBuildArgs(profile.name, dockerfileText, profile.buildArgs);
  const dockerfileSha256 = sha256Hex(dockerfileBytes);

  const dockerignore = await resolveDockerignore(profile.name, context, dockerfile);
  const ignore = parseDockerignore(dockerignore.text);
  const files = await collectContextFiles(profile.name, root, context, dockerfile, ignore);
  const digest = computeSharedImageDigest({
    profile,
    dockerfileRelative,
    dockerfileSha256,
    dockerignoreSha256: dockerignore.sha256,
    files,
  });
  return {
    digest,
    tag: sharedImageTag(digest),
    dockerfileRelative,
    dockerfileSha256,
    files,
    dockerignoreKind: dockerignore.kind,
    dockerignoreBytes: dockerignore.bytes,
  };
}

export async function materializeSharedImageSnapshot(
  profile: SharedImageProfile,
  fingerprint: SharedImageFingerprint,
): Promise<{ root: string; context: string; dockerfile: string }> {
  const root = await mkdtemp(join(tmpdir(), "skizzles-shared-image-ctx-"));
  try {
    const dockerfileInside = isPathInside(profile.context, profile.dockerfile);
    const context = dockerfileInside ? root : join(root, "context");
    await mkdir(context, { recursive: true, mode: 0o700 });
    for (const file of fingerprint.files) {
      const destination = snapshotJoin(context, file.path);
      const live = snapshotJoin(profile.context, file.path);
      if (file.kind === "directory") {
        const info = await lstat(live);
        if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== file.mode) {
          throw new Error(`shared image ${profile.name}: context changed after fingerprint: ${file.path}`);
        }
        await mkdir(destination, { mode: file.mode });
        await chmod(destination, file.mode);
        continue;
      }
      if (file.kind === "symlink") {
        if (!file.target) {
          throw new Error(`shared image ${profile.name}: context symlink is missing a target: ${file.path}`);
        }
        const target = await readlink(live);
        if (target !== file.target || sha256Hex(target) !== file.sha256) {
          throw new Error(`shared image ${profile.name}: context changed after fingerprint: ${file.path}`);
        }
        await symlink(file.target, destination);
        continue;
      }
      const bytes = await readFile(live);
      if (sha256Hex(bytes) !== file.sha256) {
        throw new Error(`shared image ${profile.name}: context changed after fingerprint: ${file.path}`);
      }
      await writeFile(destination, bytes, { mode: 0o600 });
      await chmod(destination, file.mode);
    }
    let dockerfile: string;
    if (dockerfileInside) {
      dockerfile = snapshotJoin(context, posixRelative(profile.context, profile.dockerfile));
      const bytes = await readFile(dockerfile);
      if (sha256Hex(bytes) !== fingerprint.dockerfileSha256) {
        throw new Error(`shared image ${profile.name}: Dockerfile changed after fingerprint`);
      }
    } else {
      dockerfile = join(root, "Dockerfile");
      const bytes = await readFile(profile.dockerfile);
      if (sha256Hex(bytes) !== fingerprint.dockerfileSha256) {
        throw new Error(`shared image ${profile.name}: Dockerfile changed after fingerprint`);
      }
      await writeFile(dockerfile, bytes, { mode: 0o600 });
    }
    await writeSnapshotDockerignore(context, dockerfile, fingerprint);
    return { root, context, dockerfile };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export function rejectUnsafeDockerfile(
  profile: string,
  source: string,
  buildArgs: Record<string, string> = {},
): void {
  const normalized = source.replace(/\r\n/g, "\n");
  const compact = normalized.replace(/\\\n/g, " ");
  const reasons: string[] = [];
  if (/--mount\s*=[^\s]*type\s*=\s*["']?secret["']?/im.test(compact)) reasons.push("secret mount");
  if (/--mount\s*=[^\s]*type\s*=\s*["']?ssh["']?/im.test(compact)) reasons.push("SSH mount");
  if (/--mount\s*=[^\s]*type\s*=\s*["']?bind["']?/im.test(compact)) reasons.push("bind mount");
  if (/(?:^|\s)--secret(?:\s|=)/im.test(compact)) reasons.push("build secret");
  if (/(?:^|\s)--ssh(?:\s|=)/im.test(compact)) reasons.push("build SSH forwarding");
  if (/(?:^|\s)--network\s*=\s*host(?:\s|$)/im.test(compact)) reasons.push("host network");
  if (hasUnaccountedRemoteAdd(normalized, buildArgs)) {
    reasons.push("remote ADD");
  }
  if (/\$\{[A-Za-z_][A-Za-z0-9_]*\}|(?:^|[^A-Za-z0-9_])\$[A-Za-z_][A-Za-z0-9_]*/m.test(compact) &&
      /(?:^|\s)--mount\s*=/im.test(compact) === false) {
    // Environment interpolation in Dockerfiles is accounted as Dockerfile
    // content, but BuildKit secret/SSH ids often appear as env-looking tokens.
    // The explicit mount/secret checks above remain authoritative.
  }
  if (reasons.length > 0) {
    throw new Error(`shared image ${profile}: Dockerfile uses unaccounted inputs (${reasons.join(", ")})`);
  }
}

export function rejectUnaccountedBuildArgs(
  profile: string,
  source: string,
  buildArgs: Record<string, string>,
): void {
  const compact = source.replace(/\r\n/g, "\n").replace(/\\\n/g, " ");
  const missing: string[] = [];
  for (const match of compact.matchAll(/^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)(=(?:[^\s\\]+|"[^"]*"|'[^']*'))?/gm)) {
    const name = match[1]!;
    const hasDefault = match[2] !== undefined;
    if (!hasDefault && buildArgs[name] === undefined) missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(
      `shared image ${profile}: Dockerfile ARG ${missing.join(", ")} is not covered by a literal build argument`,
    );
  }
}

async function resolveDockerignore(
  profile: string,
  context: string,
  dockerfile: string,
): Promise<{
  kind: SharedImageDockerignoreKind;
  sha256: string | null;
  text: string;
  bytes: Uint8Array | null;
}> {
  const specific = await readOptionalRegularFile(
    `${dockerfile}.dockerignore`,
    `shared image ${profile}: Dockerfile-specific dockerignore`,
  );
  if (specific) {
    return { kind: "dockerfile", sha256: sha256Hex(specific), text: specific.toString("utf8"), bytes: specific };
  }
  const rootIgnore = await readOptionalRegularFile(
    join(context, ".dockerignore"),
    `shared image ${profile}: .dockerignore`,
  );
  if (rootIgnore) {
    return { kind: "context", sha256: sha256Hex(rootIgnore), text: rootIgnore.toString("utf8"), bytes: rootIgnore };
  }
  return { kind: "none", sha256: null, text: "", bytes: null };
}

async function readOptionalRegularFile(path: string, label: string): Promise<Buffer | undefined> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular file`);
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeSnapshotDockerignore(
  context: string,
  dockerfile: string,
  fingerprint: SharedImageFingerprint,
): Promise<void> {
  if (fingerprint.dockerignoreKind === "none" || !fingerprint.dockerignoreBytes) return;
  const destination = fingerprint.dockerignoreKind === "dockerfile"
    ? `${dockerfile}.dockerignore`
    : join(context, ".dockerignore");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, fingerprint.dockerignoreBytes, { mode: 0o600 });
}

function snapshotJoin(root: string, relativePath: string): string {
  if (isAbsolute(relativePath) || relativePath.split("/").some((part) => part === ".." || part === "")) {
    throw new Error("shared image context path is invalid");
  }
  return join(root, ...relativePath.split("/"));
}

export function parseDockerignore(source: string): string[] {
  const patterns: string[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.includes("\0")) throw new Error("shared image .dockerignore contains NUL");
    patterns.push(line);
  }
  return patterns;
}

export function isDockerignored(relativePath: string, isDirectory: boolean, patterns: readonly string[]): boolean {
  let ignored = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const body = negated ? pattern.slice(1) : pattern;
    if (body.length === 0) continue;
    if (matchesDockerignore(relativePath, isDirectory, body)) ignored = !negated;
  }
  return ignored;
}

function isExcludedByDockerignore(
  relativePath: string,
  isDirectory: boolean,
  patterns: readonly string[],
): boolean {
  const parts = relativePath.split("/").filter((part) => part.length > 0);
  let prefix = "";
  for (let index = 0; index < parts.length; index++) {
    prefix = prefix ? `${prefix}/${parts[index]}` : parts[index]!;
    const last = index === parts.length - 1;
    if (isDockerignored(prefix, last ? isDirectory : true, patterns)) return true;
  }
  return false;
}

async function collectContextFiles(
  profile: string,
  repoRoot: string,
  context: string,
  dockerfile: string,
  patterns: readonly string[],
): Promise<SharedImageContextFile[]> {
  const files: SharedImageContextFile[] = [];
  let walked = 0;
  let sentBytes = 0;
  const pending = [context];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      walked += 1;
      if (walked > MAX_CONTEXT_WALK_ENTRIES) {
        throw new Error(`shared image ${profile}: context exceeds ${MAX_CONTEXT_WALK_ENTRIES} entries`);
      }
      const absolute = join(directory, entry.name);
      const relativePath = posixRelative(context, absolute);
      if (entry.isSymbolicLink()) {
        const info = await lstat(absolute);
        if (
          !isDockerfilePath(context, dockerfile, absolute) &&
          isExcludedByDockerignore(relativePath, false, patterns)
        ) continue;
        files.push(await describeContextSymlink(profile, context, absolute, relativePath, info.mode));
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === ".git" || relativePath === ".git" || relativePath.startsWith(".git/")) {
          throw new Error(`shared image ${profile}: context includes mutable Git metadata`);
        }
        if (isExcludedByDockerignore(relativePath, true, patterns)) continue;
        await recordContextDirectory(profile, files, absolute, relativePath);
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`shared image ${profile}: context contains unsupported file type at ${relativePath}`);
      }
      const alwaysSend = isDockerfilePath(context, dockerfile, absolute);
      if (!alwaysSend && isExcludedByDockerignore(relativePath, false, patterns)) continue;
      const described = await describeContextFile(profile, absolute, relativePath);
      sentBytes += described.size;
      if (files.length + 1 > MAX_SENT_FILES) {
        throw new Error(`shared image ${profile}: context exceeds ${MAX_SENT_FILES} sent files`);
      }
      if (sentBytes > MAX_SENT_BYTES) {
        throw new Error(`shared image ${profile}: context exceeds ${MAX_SENT_BYTES} sent bytes`);
      }
      files.push({ path: described.path, kind: described.kind, sha256: described.sha256, mode: described.mode });
    }
  }

  if (isPathInside(context, dockerfile)) {
    const dockerfileRelative = posixRelative(context, dockerfile);
    if (!files.some((file) => file.path === dockerfileRelative)) {
      await recordDockerfileAncestors(profile, context, dockerfileRelative, files);
      const described = await describeContextFile(profile, dockerfile, dockerfileRelative);
      files.push({ path: described.path, kind: described.kind, sha256: described.sha256, mode: described.mode });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function describeContextFile(
  profile: string,
  absolute: string,
  relativePath: string,
): Promise<SharedImageContextFile & { size: number }> {
  rejectUnsafeSentPath(profile, relativePath);
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`shared image ${profile}: context path is not a regular file: ${relativePath}`);
  }
  const bytes = await readFile(absolute);
  return {
    path: relativePath,
    kind: "file",
    sha256: sha256Hex(bytes),
    mode: info.mode & 0o777,
    size: info.size,
  };
}

async function describeContextSymlink(
  profile: string,
  context: string,
  absolute: string,
  relativePath: string,
  mode: number,
): Promise<SharedImageContextFile> {
  rejectUnsafeSentPath(profile, relativePath);
  const target = await readlink(absolute);
  if (target.includes("\0") || isAbsolute(target)) {
    throw new Error(`shared image ${profile}: context symlink must be relative: ${relativePath}`);
  }
  const resolved = resolve(absolute, "..", target);
  if (!isPathInside(context, resolved, true)) {
    throw new Error(`shared image ${profile}: context symlink escapes context: ${relativePath}`);
  }
  return {
    path: relativePath,
    kind: "symlink",
    sha256: sha256Hex(target),
    mode: mode & 0o777,
    target,
  };
}

async function recordContextDirectory(
  profile: string,
  files: SharedImageContextFile[],
  absolute: string,
  relativePath: string,
): Promise<void> {
  if (files.some((file) => file.path === relativePath)) return;
  rejectUnsafeSentPath(profile, relativePath);
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`shared image ${profile}: context path is not a directory: ${relativePath}`);
  }
  if (files.length + 1 > MAX_SENT_FILES) {
    throw new Error(`shared image ${profile}: context exceeds ${MAX_SENT_FILES} sent files`);
  }
  files.push({
    path: relativePath,
    kind: "directory",
    sha256: sha256Hex(""),
    mode: info.mode & 0o777,
  });
}

async function recordDockerfileAncestors(
  profile: string,
  context: string,
  dockerfileRelative: string,
  files: SharedImageContextFile[],
): Promise<void> {
  const parts = dockerfileRelative.split("/").filter((part) => part.length > 0);
  let prefix = "";
  for (let index = 0; index < parts.length - 1; index++) {
    prefix = prefix ? `${prefix}/${parts[index]}` : parts[index]!;
    await recordContextDirectory(profile, files, snapshotJoin(context, prefix), prefix);
  }
}

function rejectUnsafeSentPath(profile: string, relativePath: string): void {
  if (UNSAFE_SENT_PATHS.test(relativePath) || UNSAFE_SENT_FILES.test(relativePath)) {
    throw new Error(`shared image ${profile}: context would send secret or mutable input: ${relativePath}`);
  }
}

function matchesDockerignore(relativePath: string, isDirectory: boolean, pattern: string): boolean {
  let body = pattern;
  let directoryOnly = false;
  if (body.endsWith("/")) {
    directoryOnly = true;
    body = body.slice(0, -1);
  }
  if (directoryOnly && !isDirectory) return false;
  const anchored = body.startsWith("/");
  if (anchored) body = body.slice(1);
  const expression = dockerignoreToRegExp(body);
  if (anchored || body.includes("/")) return expression.test(relativePath);
  const base = relativePath.split("/").pop() ?? relativePath;
  return expression.test(base) || expression.test(relativePath);
}

function dockerignoreToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
      if (pattern[index + 1] === "/") index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "[") {
      const characterClass = readDockerignoreCharacterClass(pattern, index);
      if (characterClass === undefined) {
        source += "\\[";
        continue;
      }
      source += characterClass.regex;
      index = characterClass.end;
      continue;
    }
    if (char === "\\" && index + 1 < pattern.length) {
      source += escapeRegex(pattern[index + 1]!);
      index += 1;
      continue;
    }
    if ("\\^$+(){}|.".includes(char)) source += `\\${char}`;
    else source += char;
  }
  source += "$";
  return new RegExp(source);
}

function isDockerfilePath(context: string, dockerfile: string, candidate: string): boolean {
  return isPathInside(context, dockerfile) && resolve(candidate) === resolve(dockerfile);
}

async function realDirectoryInside(root: string, path: string, label: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} is not a real directory`);
  const canonical = await realpath(path);
  assertInside(root, canonical, label, true);
  return canonical;
}

async function realFileInside(root: string, path: string, label: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} is not a real file`);
  const canonical = await realpath(path);
  assertInside(root, canonical, label, false);
  return canonical;
}

function assertInside(root: string, candidate: string, label: string, allowRoot: boolean): void {
  if (!isPathInside(root, candidate, allowRoot)) throw new Error(`${label} resolves outside the repository`);
}

function isPathInside(root: string, candidate: string, allowRoot = false): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return (allowRoot || fromRoot !== "") && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function posixRelative(root: string, candidate: string): string {
  return relative(root, candidate).split(sep).join(posix.sep);
}

function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isTimestamp(value: string): boolean {
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function readDockerignoreCharacterClass(pattern: string, start: number): { regex: string; end: number } | undefined {
  let index = start + 1;
  if (index >= pattern.length) return undefined;
  let content = "";
  if (pattern[index] === "!" || pattern[index] === "^") {
    content += "^";
    index += 1;
  }
  if (pattern[index] === "]") {
    content += "\\]";
    index += 1;
  }
  while (index < pattern.length) {
    const char = pattern[index]!;
    if (char === "]") {
      if (content === "" || content === "^") {
        content += "\\]";
        index += 1;
        continue;
      }
      return { regex: `[${content}]`, end: index };
    }
    if (char === "\\" && index + 1 < pattern.length) {
      content += escapeRegexInClass(pattern[index + 1]!);
      index += 2;
      continue;
    }
    if (char === "-") content += "-";
    else if (char === "^") content += "\\^";
    else content += escapeRegexInClass(char);
    index += 1;
  }
  return undefined;
}

function hasUnaccountedRemoteAdd(source: string, buildArgs: Record<string, string>): boolean {
  const instructions = parseDockerfileInstructions(source);
  if (instructions === undefined) return true;
  const globalArgs: Record<string, string | undefined> = {};
  const env: Record<string, string | undefined> = {};
  let inStage = false;
  for (const instruction of instructions) {
    if (instruction.name === "FROM") {
      inStage = true;
      for (const key of Object.keys(env)) delete env[key];
      continue;
    }
    if (instruction.name === "ARG") {
      if (!inStage) {
        applyArgInstruction(instruction.body, globalArgs, buildArgs);
        applyArgInstruction(instruction.body, env, buildArgs);
      } else {
        applyArgInstruction(instruction.body, env, inheritedBuildArgs(globalArgs, buildArgs));
      }
      continue;
    }
    if (instruction.name === "ENV") {
      applyEnvInstruction(instruction.body, env);
      continue;
    }
    const addBody = addInstructionBody(instruction.name, instruction.body);
    if (addBody === undefined) continue;
    const parsed = parseAddSources(addBody);
    if (parsed === undefined) return true;
    if (parsed.some((addSource) => !isHeredocAddSource(addSource) && !isProvenLocalAddSource(addSource, env))) {
      return true;
    }
  }
  return false;
}

function inheritedBuildArgs(
  globalArgs: Readonly<Record<string, string | undefined>>,
  buildArgs: Record<string, string>,
): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(globalArgs)) {
    if (value !== undefined) inherited[name] = value;
  }
  return { ...inherited, ...buildArgs };
}

function addInstructionBody(name: string, body: string): string | undefined {
  if (name === "ADD") return body;
  if (name === "ONBUILD") {
    const match = /^\s*ADD\s+(.*)$/i.exec(body);
    if (match) return match[1] ?? "";
  }
  return undefined;
}

function parseDockerfileInstructions(source: string): Array<{ name: string; body: string }> | undefined {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const instructions: Array<{ name: string; body: string }> = [];
  let index = 0;
  while (index < lines.length) {
    const raw = lines[index]!;
    index += 1;
    const start = raw.replace(/^[ \t\v\f\r]+/, "");
    if (start.length === 0 || start.startsWith("#")) continue;

    let assembled = "";
    let current = start;
    while (true) {
      const split = splitDockerfileContinuation(current);
      assembled += split.text;
      if (!split.continues) break;
      let found = false;
      while (index < lines.length) {
        const next = lines[index]!;
        index += 1;
        if (isDockerfileComment(next) || isDockerfileEmpty(next)) continue;
        current = next;
        found = true;
        break;
      }
      if (!found) break;
    }

    if (assembled.trim().length === 0) continue;
    const parsed = splitDockerfileInstruction(assembled);
    if (!parsed) return undefined;

    if (instructionCanContainHeredoc(parsed.name, parsed.body) && assembled.includes("<<")) {
      const docs = heredocsFromInstruction(parsed.name, parsed.body);
      if (docs === undefined) return undefined;
      for (const doc of docs) {
        let terminated = false;
        while (index < lines.length) {
          const bodyLine = lines[index]!;
          index += 1;
          let possible = bodyLine.replace(/\r$/, "");
          if (doc.chomp) possible = possible.replace(/^\t+/, "");
          if (possible === doc.name) {
            terminated = true;
            break;
          }
        }
        if (!terminated) return undefined;
      }
    }

    instructions.push(parsed);
  }
  return instructions;
}

function splitDockerfileContinuation(line: string): { text: string; continues: boolean } {
  const match = /^(?:(.*[^\\]))?\\[ \t]*$/.exec(line);
  if (!match) return { text: line, continues: false };
  return { text: match[1] ?? "", continues: true };
}

function splitDockerfileInstruction(assembled: string): { name: string; body: string } | undefined {
  const match = /^([A-Za-z][A-Za-z0-9]*)(?:\s+(.*))?$/.exec(assembled.trim());
  if (!match) return undefined;
  return { name: match[1]!.toUpperCase(), body: match[2] ?? "" };
}

function instructionCanContainHeredoc(name: string, body: string): boolean {
  if (name === "ADD" || name === "COPY" || name === "RUN") return !isJsonInstructionBody(body);
  if (name === "ONBUILD") {
    const match = /^\s*(ADD|COPY|RUN)\s+(.*)$/i.exec(body);
    if (!match) return false;
    return !isJsonInstructionBody(match[2] ?? "");
  }
  return false;
}

function isJsonInstructionBody(body: string): boolean {
  const tokens = tokenizeDockerfileArgs(body);
  if (tokens === undefined) return false;
  let index = 0;
  while (index < tokens.length && tokens[index]!.startsWith("--")) index += 1;
  return tokens[index]?.startsWith("[") === true;
}

function heredocsFromInstruction(name: string, body: string): Array<{ name: string; chomp: boolean }> | undefined {
  const tokens = tokenizeDockerfileArgs(`${name} ${body}`);
  if (tokens === undefined) return undefined;
  const docs: Array<{ name: string; chomp: boolean }> = [];
  for (const token of tokens) {
    const doc = parseHeredocToken(token);
    if (doc) docs.push(doc);
  }
  return docs;
}

function parseHeredocToken(token: string): { name: string; chomp: boolean } | undefined {
  const match = /^(\d*)<<(-?)\s*([^<]*)$/.exec(token);
  if (!match) return undefined;
  const rest = match[3] ?? "";
  if (rest.length === 0) return undefined;
  const name = rest.replace(/['"]/g, "");
  if (name.length === 0) return undefined;
  return { name, chomp: match[2] === "-" };
}

function isHeredocAddSource(source: string): boolean {
  return parseHeredocToken(source) !== undefined;
}

function isDockerfileComment(line: string): boolean {
  return /^\s*#/.test(line);
}

function isDockerfileEmpty(line: string): boolean {
  return /^\s*$/.test(line);
}

function parseAddSources(body: string): string[] | undefined {
  const tokens = tokenizeDockerfileArgs(body);
  if (tokens === undefined) return undefined;
  let index = 0;
  while (index < tokens.length && tokens[index]!.startsWith("--")) index += 1;
  const rest = tokens.slice(index);
  if (rest.length === 0) return [];
  if (rest.length === 1 && rest[0]!.startsWith("[")) {
    let parsed: unknown;
    try { parsed = JSON.parse(rest[0]!); }
    catch { return undefined; }
    if (!Array.isArray(parsed) || parsed.length < 2 || parsed.some((item) => typeof item !== "string")) {
      return undefined;
    }
    return parsed.slice(0, -1);
  }
  if (rest.length < 2) return [];
  return rest.slice(0, -1);
}

function tokenizeDockerfileArgs(body: string): string[] | undefined {
  const tokens: string[] = [];
  let index = 0;
  while (index < body.length) {
    while (index < body.length && /\s/.test(body[index]!)) index += 1;
    if (index >= body.length) break;
    const char = body[index]!;
    if (char === "#") break;
    if (char === "[") {
      const end = jsonArrayEnd(body, index);
      if (end === undefined) return undefined;
      tokens.push(body.slice(index, end + 1));
      index = end + 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const quoted = readQuotedToken(body, index);
      if (quoted === undefined) return undefined;
      tokens.push(quoted.value);
      index = quoted.end;
      continue;
    }
    const start = index;
    while (index < body.length && !/\s/.test(body[index]!) && body[index] !== "#") index += 1;
    tokens.push(body.slice(start, index));
  }
  return tokens;
}

function jsonArrayEnd(source: string, start: number): number | undefined {
  let depth = 0;
  let quote: string | undefined;
  let escape = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index]!;
    if (quote) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' ) {
      quote = char;
      continue;
    }
    if (char === "[") {
      depth += 1;
      continue;
    }
    if (char === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function readQuotedToken(source: string, start: number): { value: string; end: number } | undefined {
  const quote = source[start]!;
  let index = start + 1;
  let value = "";
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\\" && quote === '"' && index + 1 < source.length) {
      value += source[index + 1]!;
      index += 2;
      continue;
    }
    if (char === quote) return { value, end: index + 1 };
    value += char;
    index += 1;
  }
  return undefined;
}

function isRemoteAddSource(source: string): boolean {
  const value = source.trim();
  if (value.length === 0) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) return true;
  if (value.startsWith("git@")) return true;
  return /^[A-Za-z0-9._-]+@[^/:]+?:/.test(value);
}

function isProvenLocalAddSource(source: string, env: Readonly<Record<string, string | undefined>>): boolean {
  const expanded = expandDockerfileValue(source, env);
  if (!expanded.complete) return false;
  const value = expanded.value.trim();
  return value.length > 0 && !isRemoteAddSource(value);
}

function applyArgInstruction(
  body: string,
  env: Record<string, string | undefined>,
  buildArgs: Record<string, string>,
): void {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s*=\s*(.*))?$/.exec(body.trim());
  if (!match) return;
  const name = match[1]!;
  if (Object.hasOwn(buildArgs, name)) {
    env[name] = buildArgs[name];
    return;
  }
  if (match[2] === undefined) {
    env[name] = undefined;
    return;
  }
  env[name] = expandDockerfileValue(unquoteDockerfileValue(match[2]), env).value;
}

function applyEnvInstruction(body: string, env: Record<string, string | undefined>): void {
  const tokens = tokenizeDockerfileArgs(body);
  if (tokens === undefined || tokens.length === 0) return;
  if (tokens.length >= 2 && !tokens[0]!.includes("=")) {
    const name = tokens[0]!;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return;
    env[name] = expandDockerfileValue(tokens.slice(1).join(" "), env).value;
    return;
  }
  for (const token of tokens) {
    const separator = token.indexOf("=");
    if (separator <= 0) continue;
    const name = token.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    env[name] = expandDockerfileValue(token.slice(separator + 1), env).value;
  }
}

function unquoteDockerfileValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const quote = trimmed[0];
    if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function expandDockerfileValue(
  input: string,
  env: Readonly<Record<string, string | undefined>>,
): { value: string; complete: boolean } {
  let value = "";
  let complete = true;
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (char === "$" && input[index + 1] === "$") {
      value += "$";
      index += 1;
      continue;
    }
    if (char === "$" && input[index + 1] === "{") {
      const closing = input.indexOf("}", index + 2);
      if (closing < 0) {
        complete = false;
        value += input.slice(index);
        break;
      }
      const expanded = expandDockerfileBrace(input.slice(index + 2, closing), env);
      if (!expanded.complete) complete = false;
      value += expanded.value;
      index = closing;
      continue;
    }
    if (char === "$" && /[A-Za-z_]/.test(input[index + 1] ?? "")) {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(index + 1))?.[0];
      if (!name) {
        complete = false;
        value += char;
        continue;
      }
      value += env[name] ?? "";
      index += name.length;
      continue;
    }
    value += char;
  }
  return { value, complete };
}

function expandDockerfileBrace(
  inner: string,
  env: Readonly<Record<string, string | undefined>>,
): { value: string; complete: boolean } {
  const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(inner);
  if (!nameMatch) return { value: "", complete: false };
  const name = nameMatch[0];
  const rest = inner.slice(name.length);
  const current = env[name];
  const set = current !== undefined;
  const empty = !set || current.length === 0;
  if (rest === "") return { value: current ?? "", complete: true };
  const operator = rest.startsWith(":-") || rest.startsWith(":+") || rest.startsWith(":?")
    ? rest.slice(0, 2)
    : rest.startsWith("-") || rest.startsWith("+") || rest.startsWith("?")
      ? rest[0]!
      : undefined;
  if (operator === undefined) return { value: "", complete: false };
  const word = expandDockerfileValue(rest.slice(operator.length), env);
  if (operator === ":-") return empty ? word : { value: current ?? "", complete: true };
  if (operator === "-") return set ? { value: current ?? "", complete: true } : word;
  if (operator === ":+") return empty ? { value: "", complete: true } : word;
  if (operator === "+") return set ? word : { value: "", complete: true };
  if (operator === ":?" || operator === "?") {
    if ((operator === ":?" && empty) || (operator === "?" && !set)) return { value: "", complete: false };
    return { value: current ?? "", complete: true };
  }
  return { value: "", complete: false };
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$+*?()[\]{}|.]/g, "\\$&");
}

function escapeRegexInClass(value: string): string {
  if (value === "]" || value === "\\" || value === "^" || value === "-") return `\\${value}`;
  return value;
}
