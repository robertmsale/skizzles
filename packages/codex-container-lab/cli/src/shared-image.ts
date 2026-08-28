import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, readlink } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";

export const SHARED_IMAGE_SCHEMA = "v1";
export const SHARED_IMAGE_KIND = "environment";
export const SHARED_IMAGE_NAME = "skizzles-shared-image";
export const SHARED_IMAGE_BUILDER_NAME = "skizzles-shared-image";
export const SHARED_IMAGE_BUILDER_DRIVER = "docker-container";

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
  kind: "file" | "symlink";
  sha256: string;
  mode: number;
  target?: string;
};

export type SharedImageFingerprint = {
  digest: string;
  tag: string;
  dockerfileRelative: string;
  files: SharedImageContextFile[];
};

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
  rejectUnsafeDockerfile(profile.name, dockerfileText);
  rejectUnaccountedBuildArgs(profile.name, dockerfileText, profile.buildArgs);
  const dockerfileSha256 = sha256Hex(dockerfileBytes);

  const dockerignorePath = join(context, ".dockerignore");
  let dockerignoreText: string | undefined;
  let dockerignoreSha256: string | null = null;
  try {
    const ignoreInfo = await lstat(dockerignorePath);
    if (ignoreInfo.isSymbolicLink() || !ignoreInfo.isFile()) {
      throw new Error(`shared image ${profile.name}: .dockerignore must be a regular file`);
    }
    const ignoreBytes = await readFile(dockerignorePath);
    dockerignoreText = ignoreBytes.toString("utf8");
    dockerignoreSha256 = sha256Hex(ignoreBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const ignore = parseDockerignore(dockerignoreText ?? "");
  const files = await collectContextFiles(profile.name, root, context, dockerfile, ignore);
  const digest = computeSharedImageDigest({
    profile,
    dockerfileRelative,
    dockerfileSha256,
    dockerignoreSha256,
    files,
  });
  return { digest, tag: sharedImageTag(digest), dockerfileRelative, files };
}

export function rejectUnsafeDockerfile(profile: string, source: string): void {
  const normalized = source.replace(/\r\n/g, "\n");
  const compact = normalized.replace(/\\\n/g, " ");
  const reasons: string[] = [];
  if (/--mount\s*=[^\s]*type\s*=\s*["']?secret["']?/im.test(compact)) reasons.push("secret mount");
  if (/--mount\s*=[^\s]*type\s*=\s*["']?ssh["']?/im.test(compact)) reasons.push("SSH mount");
  if (/--mount\s*=[^\s]*type\s*=\s*["']?bind["']?/im.test(compact)) reasons.push("bind mount");
  if (/(?:^|\s)--secret(?:\s|=)/im.test(compact)) reasons.push("build secret");
  if (/(?:^|\s)--ssh(?:\s|=)/im.test(compact)) reasons.push("build SSH forwarding");
  if (/(?:^|\s)--network\s*=\s*host(?:\s|$)/im.test(compact)) reasons.push("host network");
  if (/^\s*ADD\s+(?:--[^\s]+\s+)*(?:https?:\/\/|git@|git:\/\/)/im.test(compact)) {
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
  const hasNegation = patterns.some((pattern) => pattern.startsWith("!"));
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
        if (isDockerignored(relativePath, false, patterns) && !isDockerfilePath(context, dockerfile, absolute)) continue;
        files.push(await describeContextSymlink(profile, context, absolute, relativePath, info.mode));
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === ".git" || relativePath === ".git" || relativePath.startsWith(".git/")) {
          throw new Error(`shared image ${profile}: context includes mutable Git metadata`);
        }
        if (isDockerignored(relativePath, true, patterns) && !hasNegation) continue;
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`shared image ${profile}: context contains unsupported file type at ${relativePath}`);
      }
      const alwaysSend = isDockerfilePath(context, dockerfile, absolute);
      if (!alwaysSend && isDockerignored(relativePath, false, patterns)) continue;
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
    if ("\\^$+()[]{}|.".includes(char)) source += `\\${char}`;
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
