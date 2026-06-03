// Read-only filesystem browser for the desktop Files widget. The browser receives
// only metadata or redacted preview content; every request is contained inside a
// registered project root after realpath resolution.

import type { Dirent, Stats } from "node:fs";
import {
  lstat,
  opendir,
  open,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse as parsePath,
  posix as pathPosix,
  relative,
  resolve,
} from "node:path";
import { compileIgnore, isIgnored, type IgnoreMatcher } from "@oscharko-dev/keiko-workspace";
import { DENIED_MESSAGE, pathIsDenied } from "./files-deny.js";
import { errorBody, type RouteContext, type RouteResult } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import type { Project, UiStore } from "./store/index.js";

const MAX_DIRECTORY_ENTRIES = 1_000;
const MAX_TEXT_PREVIEW_BYTES = 1_000_000;
const MAX_IMAGE_PREVIEW_BYTES = 3_000_000;
const MAX_IGNORED_SCAN_ENTRIES = 10_000;

export interface FilesDirectoryRoot {
  readonly label: string;
  readonly path: string;
}

export interface FilesDirectoryEntry {
  readonly name: string;
  readonly path: string;
}

export interface FilesDirectoryListing {
  readonly path: string;
  readonly parent: string | null;
  readonly entries: readonly FilesDirectoryEntry[];
  readonly roots: readonly FilesDirectoryRoot[];
}

export type FilesEntryKind = "directory" | "file" | "symlink";

export interface FilesTreeEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: FilesEntryKind;
  readonly sizeBytes: number;
  readonly modifiedAt: number;
  readonly extension: string | null;
  readonly symlink: boolean;
  readonly readable: boolean;
}

export interface FilesTreeResponse {
  readonly root: string;
  readonly path: string;
  readonly entries: readonly FilesTreeEntry[];
  readonly truncated: boolean;
}

interface FilesPreviewBase {
  readonly root: string;
  readonly path: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly modifiedAt: number;
  readonly extension: string | null;
  readonly mime: string;
  readonly symlink: boolean;
}

export type FilesPreviewResponse =
  | (FilesPreviewBase & {
      readonly kind: "text";
      readonly content: string;
      readonly truncated: boolean;
      readonly maxBytes: number;
    })
  | (FilesPreviewBase & {
      readonly kind: "image";
      readonly dataUrl: string;
      readonly maxBytes: number;
    })
  | (FilesPreviewBase & {
      readonly kind: "binary";
      readonly reason: "unsupported" | "too_large";
      readonly maxBytes?: number | undefined;
    });

class FilesError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FilesError";
  }
}

interface ResolvedTarget {
  readonly root: string;
  readonly realRoot: string;
  readonly relativePath: string;
  readonly path: string;
  readonly stats: Stats;
  readonly symlink: boolean;
}

interface ResolvedProjectRoot {
  readonly root: string;
  readonly realRoot: string;
}

function filesErrorResult(error: FilesError): RouteResult {
  return { status: error.status, body: errorBody(error.code, error.message) };
}

async function runFilesHandler(
  work: () => Promise<RouteResult> | RouteResult,
): Promise<RouteResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof FilesError) return filesErrorResult(error);
    throw error;
  }
}

async function resolveDirectory(candidate: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    throw new FilesError(400, "INVALID_DIRECTORY", "The directory does not exist.");
  }
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new FilesError(400, "INVALID_DIRECTORY", "The selected path must be a directory.");
  }
  return resolved;
}

function projectFor(store: UiStore, projectId: string): Project | undefined {
  return store.listProjects().find((project) => project.path === projectId);
}

function rootNameIsDenied(rootPath: string): boolean {
  return pathIsDenied(basename(rootPath));
}

async function resolveRoot(store: UiStore, rootInput: string | null): Promise<ResolvedProjectRoot> {
  if (rootInput === null || rootInput.trim().length === 0) {
    throw new FilesError(400, "BAD_REQUEST", "The root query parameter is required.");
  }
  const project = projectFor(store, rootInput);
  if (project === undefined) {
    throw new FilesError(403, "WORKSPACE_NOT_REGISTERED", "The selected root is not a registered project.");
  }
  if (rootNameIsDenied(project.path)) {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
  const realRoot = await resolveDirectory(project.path);
  if (rootNameIsDenied(realRoot)) {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
  return { root: project.path, realRoot };
}

function directoryRoots(projectRoot: string): readonly FilesDirectoryRoot[] {
  return [{ label: "Project root", path: projectRoot }];
}

function parentPath(pathValue: string, projectRoot: string): string | null {
  if (pathValue === projectRoot) return null;
  const parsed = parsePath(pathValue);
  return pathValue === parsed.root ? null : dirname(pathValue);
}

function normalizeRelativePath(pathInput: string | null): string {
  const raw = pathInput ?? "";
  if (raw.includes("\0") || isAbsolute(raw)) {
    throw new FilesError(400, "BAD_PATH", "The path must be relative to the selected root.");
  }
  const normalized = pathPosix.normalize(raw.replaceAll("\\", "/"));
  if (normalized === ".") return "";
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new FilesError(400, "PATH_ESCAPE", "The requested path is outside the selected root.");
  }
  return normalized;
}

function nativePath(root: string, relativePath: string): string {
  if (relativePath.length === 0) return root;
  return resolve(root, ...relativePath.split("/").filter((part) => part.length > 0));
}

function isContained(root: string, target: string): boolean {
  const rootCmp = process.platform === "win32" ? root.toLowerCase() : root;
  const targetCmp = process.platform === "win32" ? target.toLowerCase() : target;
  const rel = relative(rootCmp, targetCmp);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function rootRelativePosixPath(root: string, target: string): string {
  const rel = relative(root, target);
  return rel.replaceAll("\\", "/");
}

function normalizeDirectoryPath(pathInput: string | undefined, registeredRoot: string, realRoot: string): string {
  const raw = pathInput?.trim();
  if (raw === undefined || raw.length === 0) return realRoot;
  if (raw.includes("\0")) {
    throw new FilesError(400, "BAD_PATH", "The path must stay inside the selected project.");
  }
  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(realRoot, raw);
  if (!isContained(realRoot, candidate) && !isContained(registeredRoot, candidate)) {
    throw new FilesError(403, "PATH_ESCAPE", "The requested path is outside the selected project.");
  }
  return candidate;
}

async function resolveDirectoryInsideRoot(
  store: UiStore,
  rootInput: string | null,
  pathInput: string | undefined,
): Promise<ResolvedProjectRoot & { readonly path: string; readonly relativePath: string }> {
  const root = await resolveRoot(store, rootInput);
  const candidate = normalizeDirectoryPath(pathInput, root.root, root.realRoot);
  const pathValue = await resolveDirectory(candidate);
  if (!isContained(root.realRoot, pathValue)) {
    throw new FilesError(403, "PATH_ESCAPE", "The requested path is outside the selected project.");
  }
  const relativePath = rootRelativePosixPath(root.realRoot, pathValue);
  if (pathIsDenied(relativePath)) {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
  return { ...root, path: pathValue, relativePath };
}

async function resolveInsideRoot(
  store: UiStore,
  rootInput: string | null,
  pathInput: string | null,
): Promise<ResolvedTarget> {
  const root = await resolveRoot(store, rootInput);
  const relativePath = normalizeRelativePath(pathInput);
  // Deny check runs BEFORE realpath so existence of a denied path is not
  // observable via the 403/404 status-code difference. A non-existent denied
  // path returns 403, identical to an existing denied path.
  if (pathIsDenied(relativePath)) {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
  const candidate = nativePath(root.realRoot, relativePath);
  let target: string;
  try {
    target = await realpath(candidate);
  } catch {
    throw new FilesError(404, "NOT_FOUND", "The requested path was not found.");
  }
  if (!isContained(root.realRoot, target)) {
    throw new FilesError(403, "PATH_ESCAPE", "The requested path is outside the selected root.");
  }
  const targetRelativePath = rootRelativePosixPath(root.realRoot, target);
  if (pathIsDenied(targetRelativePath)) {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
  const linkStats = await lstat(candidate);
  const targetStats = await stat(target);
  return {
    root: root.root,
    realRoot: root.realRoot,
    relativePath,
    path: target,
    stats: targetStats,
    symlink: linkStats.isSymbolicLink(),
  };
}

async function directoryEntries(root: string, pathValue: string): Promise<readonly FilesDirectoryEntry[]> {
  const entries: FilesDirectoryEntry[] = [];
  const dir = await opendir(pathValue);
  try {
    for await (const entry of dir) {
      if (!entry.isDirectory()) continue;
      const entryPath = join(pathValue, entry.name);
      const relativePath = rootRelativePosixPath(root, entryPath);
      if (pathIsDenied(relativePath)) continue;
      entries.push({ name: entry.name, path: entryPath });
    }
  } finally {
    await dir.close().catch(() => undefined);
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listFilesDirectories(
  store: UiStore,
  rootInput: string | null,
  pathInput?: string,
): Promise<FilesDirectoryListing> {
  const target = await resolveDirectoryInsideRoot(store, rootInput, pathInput);
  return {
    path: target.path,
    parent: parentPath(target.path, target.realRoot),
    entries: await directoryEntries(target.realRoot, target.path),
    roots: directoryRoots(target.root),
  };
}

function extensionOf(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  if (lower === ".env" || lower.startsWith(".env.")) return "env";
  const ext = extname(lower).replace(/^\./u, "");
  return ext.length > 0 ? ext : null;
}

async function classifyEntry(
  root: string,
  parentRelativePath: string,
  parentNativePath: string,
  entry: Dirent,
): Promise<FilesTreeEntry> {
  const childRelativePath = parentRelativePath.length === 0
    ? entry.name
    : `${parentRelativePath}/${entry.name}`;
  const entryPath = join(parentNativePath, entry.name);
  const linkStats = await lstat(entryPath);
  const symlink = linkStats.isSymbolicLink();
  const base = {
    name: entry.name,
    path: childRelativePath,
    sizeBytes: linkStats.size,
    modifiedAt: linkStats.mtimeMs,
    extension: extensionOf(entry.name),
    symlink,
  };
  if (!symlink) {
    const kind: FilesEntryKind = linkStats.isDirectory() ? "directory" : "file";
    return { ...base, kind, readable: true };
  }
  try {
    const target = await realpath(entryPath);
    const targetStats = await stat(target);
    const contained = isContained(root, target);
    const denied = contained && pathIsDenied(rootRelativePosixPath(root, target));
    const kind: FilesEntryKind = targetStats.isDirectory()
      ? "directory"
      : targetStats.isFile()
        ? "file"
        : "symlink";
    return { ...base, kind, readable: contained && !denied };
  } catch {
    return { ...base, kind: "symlink", readable: false };
  }
}

function entryRank(entry: FilesTreeEntry): number {
  if (entry.kind === "directory") return 0;
  if (entry.kind === "file") return 1;
  return 2;
}

function childRelative(parentRelativePath: string, name: string): string {
  return parentRelativePath.length === 0 ? name : `${parentRelativePath}/${name}`;
}

// Best-effort: read the project root's `.gitignore` if present. Silent failure
// is intentional — `.gitignore` is tier-2 noise reduction, not a safety
// boundary (deny-list is tier 1). A missing/unreadable `.gitignore` is "no
// filter". No long-lived cache: the BFF is stateless across user-selected roots.
async function loadRootGitignore(rootPath: string): Promise<IgnoreMatcher | null> {
  let raw: string;
  try {
    raw = await readFile(join(rootPath, ".gitignore"), "utf8");
  } catch {
    return null;
  }
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return compileIgnore(withoutBom.split("\n"));
}

function skipEntry(
  matcher: IgnoreMatcher | null,
  rel: string,
  isDir: boolean,
): "denied" | "ignored" | null {
  if (pathIsDenied(rel)) return "denied";
  return matcher !== null && isIgnored(matcher, rel, isDir) ? "ignored" : null;
}

async function listTreeEntries(
  root: string,
  relativePath: string,
  pathValue: string,
  matcher: IgnoreMatcher | null,
): Promise<{
  readonly entries: readonly FilesTreeEntry[];
  readonly truncated: boolean;
}> {
  const entries: FilesTreeEntry[] = [];
  const dir = await opendir(pathValue);
  let truncated = false;
  let ignoredScans = 0;
  try {
    for await (const entry of dir) {
      // Deny and .gitignore filtering happen BEFORE the truncation counter so
      // a directory packed with denied entries (e.g. node_modules/**) cannot
      // exhaust the 1000-entry budget and hide real files behind
      // `truncated: true`. Deny is applied by the link name (the user only
      // sees that name) so a symlink whose own name matches a deny pattern is
      // denied even if its target does not — matches the workspace-layer
      // semantics.
      const rel = childRelative(relativePath, entry.name);
      const skipReason = skipEntry(matcher, rel, entry.isDirectory());
      if (skipReason === "denied") continue;
      if (skipReason === "ignored") {
        ignoredScans += 1;
        if (ignoredScans >= MAX_IGNORED_SCAN_ENTRIES) {
          truncated = true;
          break;
        }
        continue;
      }
      if (entries.length >= MAX_DIRECTORY_ENTRIES) {
        truncated = true;
        break;
      }
      entries.push(await classifyEntry(root, relativePath, pathValue, entry));
    }
  } finally {
    await dir.close().catch(() => undefined);
  }
  entries.sort((a, b) => entryRank(a) - entryRank(b) || a.name.localeCompare(b.name));
  return { entries, truncated };
}

export async function readFilesTree(
  store: UiStore,
  rootInput: string | null,
  pathInput: string | null,
): Promise<FilesTreeResponse> {
  const target = await resolveInsideRoot(store, rootInput, pathInput);
  if (!target.stats.isDirectory()) {
    throw new FilesError(400, "NOT_DIRECTORY", "The requested path is not a directory.");
  }
  // Per-request: read the project root's `.gitignore` once. Best-effort noise
  // reduction only; the matcher never relaxes the deny list. No long-lived
  // cache — the BFF must stay stateless across user-selected roots.
  const ignoreMatcher = await loadRootGitignore(target.realRoot);
  const listed = await listTreeEntries(target.realRoot, target.relativePath, target.path, ignoreMatcher);
  return {
    root: target.root,
    path: target.relativePath,
    entries: listed.entries,
    truncated: listed.truncated,
  };
}

const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  "bash",
  "c",
  "cjs",
  "css",
  "csv",
  "dockerfile",
  "env",
  "go",
  "graphql",
  "gql",
  "gradle",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "kts",
  "md",
  "mjs",
  "properties",
  "py",
  "rs",
  "sh",
  "sql",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

function mimeOf(extension: string | null): string {
  if (extension !== null && IMAGE_MIME[extension] !== undefined) return IMAGE_MIME[extension];
  if (extension === "json") return "application/json";
  if (extension === "md") return "text/markdown";
  if (extension === "html") return "text/html";
  if (extension === "css") return "text/css";
  if (isKnownTextExtension(extension)) return "text/plain";
  return "application/octet-stream";
}

function isImageExtension(extension: string | null): boolean {
  return extension !== null && IMAGE_MIME[extension] !== undefined;
}

function isKnownTextExtension(extension: string | null): boolean {
  return extension !== null && TEXT_EXTENSIONS.has(extension);
}

function isLikelyUtf8Text(buffer: Buffer): boolean {
  if (buffer.length === 0) return true;
  if (buffer.includes(0)) return false;
  const decoded = buffer.toString("utf8");
  if (decoded.includes("\uFFFD")) return false;
  let printable = 0;
  for (const char of decoded) {
    const code = char.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || code >= 32) printable += 1;
  }
  return printable / decoded.length > 0.85;
}

async function readPrefix(pathValue: string, maxBytes: number): Promise<{
  readonly buffer: Buffer;
  readonly truncated: boolean;
}> {
  const file = await open(pathValue, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const result = await file.read(buffer, 0, maxBytes + 1, 0);
    return {
      buffer: buffer.subarray(0, Math.min(result.bytesRead, maxBytes)),
      truncated: result.bytesRead > maxBytes,
    };
  } finally {
    await file.close();
  }
}

function basePreview(target: ResolvedTarget): FilesPreviewBase {
  const name = basename(target.relativePath);
  const extension = extensionOf(name);
  return {
    root: target.root,
    path: target.relativePath,
    name,
    sizeBytes: target.stats.size,
    modifiedAt: target.stats.mtimeMs,
    extension,
    mime: mimeOf(extension),
    symlink: target.symlink,
  };
}

async function imagePreview(
  target: ResolvedTarget,
  base: FilesPreviewBase,
): Promise<FilesPreviewResponse> {
  if (target.stats.size > MAX_IMAGE_PREVIEW_BYTES) {
    return { ...base, kind: "binary", reason: "too_large", maxBytes: MAX_IMAGE_PREVIEW_BYTES };
  }
  const buffer = await readFile(target.path);
  return {
    ...base,
    kind: "image",
    dataUrl: `data:${base.mime};base64,${buffer.toString("base64")}`,
    maxBytes: MAX_IMAGE_PREVIEW_BYTES,
  };
}

async function textPreview(
  target: ResolvedTarget,
  base: FilesPreviewBase,
  redactor: UiHandlerDeps["redactor"],
): Promise<FilesPreviewResponse> {
  const prefix = await readPrefix(target.path, MAX_TEXT_PREVIEW_BYTES);
  const content = prefix.buffer.toString("utf8");
  const redacted = redactor(content);
  return {
    ...base,
    kind: "text",
    content: typeof redacted === "string" ? redacted : content,
    truncated: prefix.truncated,
    maxBytes: MAX_TEXT_PREVIEW_BYTES,
  };
}

export async function readFilesPreview(
  store: UiStore,
  rootInput: string | null,
  pathInput: string | null,
  redactor: UiHandlerDeps["redactor"],
): Promise<FilesPreviewResponse> {
  const target = await resolveInsideRoot(store, rootInput, pathInput);
  if (!target.stats.isFile()) {
    throw new FilesError(400, "NOT_FILE", "The requested path is not a file.");
  }
  const base = basePreview(target);
  if (isImageExtension(base.extension)) return imagePreview(target, base);
  const prefix = await readPrefix(target.path, Math.min(target.stats.size, 4096));
  if (isKnownTextExtension(base.extension) || isLikelyUtf8Text(prefix.buffer)) {
    return textPreview(target, base, redactor);
  }
  return { ...base, kind: "binary", reason: "unsupported" };
}

export async function handleFilesDirectories(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runFilesHandler(async () => {
    const requestedRoot = ctx.url.searchParams.get("root");
    const requestedPath = ctx.url.searchParams.get("path") ?? undefined;
    return { status: 200, body: await listFilesDirectories(deps.store, requestedRoot, requestedPath) };
  });
}

export async function handleFilesTree(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runFilesHandler(async () => ({
    status: 200,
    body: await readFilesTree(deps.store, ctx.url.searchParams.get("root"), ctx.url.searchParams.get("path")),
  }));
}

export async function handleFilesPreview(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runFilesHandler(async () => ({
    status: 200,
    body: await readFilesPreview(
      deps.store,
      ctx.url.searchParams.get("root"),
      ctx.url.searchParams.get("path"),
      deps.redactor,
    ),
  }));
}
