// Read-only filesystem browser for the desktop Files widget. The browser receives
// preview or editor content; every request is contained inside a selected root after
// realpath resolution.

import type { IncomingMessage } from "node:http";
import type { Dirent, Stats } from "node:fs";
import { constants, createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import {
  cp,
  lstat,
  mkdir,
  opendir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
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
import { redact } from "@oscharko-dev/keiko-security";
import {
  EDITOR_SESSION_SCHEMA_VERSION,
  parseEditorDocumentVersion,
  type EditorDocumentSession,
  type EditorDocumentVersion,
} from "@oscharko-dev/keiko-contracts";
import { containsPath } from "@oscharko-dev/keiko-git";
import { DENIED_MESSAGE, pathIsDenied } from "./files-deny.js";
import {
  STREAMING,
  errorBody,
  type HandlerOutcome,
  type RouteContext,
  type RouteResult,
} from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import type { Project, UiStore } from "./store/index.js";

const MAX_DIRECTORY_ENTRIES = 1_000;
const DEFAULT_FILE_SEARCH_LIMIT = 24;
const MAX_FILE_SEARCH_LIMIT = 50;
const MAX_FILE_SEARCH_QUERY_CHARS = 120;
const MAX_FILE_SEARCH_SCAN = 20_000;
const MAX_TEXT_PREVIEW_BYTES = 1_000_000;
const MAX_IMAGE_PREVIEW_BYTES = 3_000_000;
const STABLE_CONTENT_READ_ATTEMPTS = 3;
const TREE_CLASSIFY_CONCURRENCY = 32;
const FILE_SEARCH_CANDIDATE_CONCURRENCY = 32;
const STABLE_CONTENT_RETRY_DELAY_MS = 25;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
type FilesMetadataRedactor = UiHandlerDeps["redactor"];

const staticFilesMetadataRedactor: FilesMetadataRedactor = (value: unknown): unknown =>
  typeof value === "string" ? redact(value) : value;

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

export interface FilesSearchResult {
  readonly root: string;
  readonly path: string;
  readonly name: string;
  readonly directory: string;
  readonly extension: string | null;
  readonly sizeBytes: number;
  readonly modifiedAt: number;
  readonly fileRole: FilesSearchFileRole;
  readonly matchQuality: FilesSearchMatchQuality;
  readonly rootKind: FilesSearchRootKind;
}

export interface FilesSearchResponse {
  readonly root: string;
  readonly query: string;
  readonly results: readonly FilesSearchResult[];
  readonly truncated: boolean;
  readonly scannedFileCount: number;
}

export type FilesSearchFileRole =
  "source" | "test" | "config" | "docs" | "generated" | "asset" | "other";

export type FilesSearchMatchQuality = "exact" | "strong" | "path" | "weak";

export type FilesSearchRootKind = "selected-root" | "nested-git-root";

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
      readonly url: string;
      readonly maxBytes: number;
    })
  | (FilesPreviewBase & {
      readonly kind: "binary";
      readonly reason: "unsupported" | "too_large";
      readonly maxBytes?: number | undefined;
    });

export interface FilesContentResponse extends FilesPreviewBase {
  readonly content: string;
  readonly maxBytes: number;
  // Issue #1197: content-free editor-session metadata for the returned document revision.
  readonly session: EditorDocumentSession;
}

class BodyTooLargeError extends Error {
  public constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

// Exported for reuse by the editor language-service route (#1198) so denied/invalid roots map to the
// same status + content-free code envelope as the files routes.
export class FilesError extends Error {
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

// Exported for reuse by the editor language-service route (#1198): the same realpath +
// deny-list-guarded workspace-root resolution backs file reads and deterministic analysis so
// containment is single-sourced.
export interface ResolvedProjectRoot {
  readonly root: string;
  readonly realRoot: string;
}

function filesErrorResult(error: FilesError): RouteResult {
  return { status: error.status, body: errorBody(error.code, error.message) };
}

export async function runFilesHandler(
  work: () => Promise<RouteResult> | RouteResult,
): Promise<RouteResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof FilesError) return filesErrorResult(error);
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRouteResult(value: unknown): value is RouteResult {
  return isRecord(value) && typeof value.status === "number" && "body" in value;
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

function rootPathIsDenied(rootPath: string): boolean {
  return pathIsDenied(rootPath);
}

function assertMetadataSafe(value: string, redactor: FilesMetadataRedactor): void {
  const redacted = redactor(value);
  if (typeof redacted === "string" && redacted !== value) {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
}

function metadataIsSafe(value: string, redactor: FilesMetadataRedactor): boolean {
  const redacted = redactor(value);
  return typeof redacted !== "string" || redacted === value;
}

async function resolveRegisteredRoot(
  project: Project,
  redactor: FilesMetadataRedactor,
): Promise<ResolvedProjectRoot> {
  assertMetadataSafe(project.path, redactor);
  if (rootPathIsDenied(project.path)) {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
  const realRoot = await resolveDirectory(project.path);
  assertMetadataSafe(realRoot, redactor);
  if (rootPathIsDenied(realRoot)) {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
  return { root: project.path, realRoot };
}

// Epic #532 — Keiko is a workspace for EVERYONE, not only devs: a Files window may browse ANY folder
// on the machine, not just a registered project. An arbitrary input becomes its own root, gated by
// the SAME realpath + FULL-PATH deny-list the grounded connect path enforces (deny matches on every
// segment, so a root inside `.ssh`/`.aws`/credential dirs is rejected even when its basename is
// innocuous). Browse and connect therefore accept the identical set of roots. The deny check runs
// once on the raw input and again on the realpath, so a symlink whose target lands in a denied
// location is caught after resolution.
async function resolveArbitraryRoot(
  rootInput: string,
  redactor: FilesMetadataRedactor,
): Promise<ResolvedProjectRoot> {
  if (!isAbsolute(rootInput)) {
    throw new FilesError(400, "BAD_ROOT", "The root must be an absolute directory path.");
  }
  assertMetadataSafe(rootInput, redactor);
  if (pathIsDenied(rootInput)) {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
  const realRoot = await resolveDirectory(rootInput);
  assertMetadataSafe(realRoot, redactor);
  if (pathIsDenied(realRoot)) {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
  return { root: rootInput, realRoot };
}

export async function resolveRoot(
  store: UiStore,
  rootInput: string | null,
  redactor: FilesMetadataRedactor,
): Promise<ResolvedProjectRoot> {
  if (rootInput === null || rootInput.trim().length === 0) {
    throw new FilesError(400, "BAD_REQUEST", "The root query parameter is required.");
  }
  const project = projectFor(store, rootInput);
  return project === undefined
    ? resolveArbitraryRoot(rootInput.trim(), redactor)
    : resolveRegisteredRoot(project, redactor);
}

function directoryRoots(projectRoot: string): readonly FilesDirectoryRoot[] {
  return [{ label: "Project root", path: projectRoot }];
}

function parentPath(pathValue: string, projectRoot: string): string | null {
  if (pathValue === projectRoot) return null;
  const parsed = parsePath(pathValue);
  return pathValue === parsed.root ? null : dirname(pathValue);
}

export function normalizeRelativePath(pathInput: string | null): string {
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

// Platform-correct path identity (case/NFC on darwin+win32) lives in the shared git core.
const isContained = containsPath;

function rootRelativePosixPath(root: string, target: string): string {
  const rel = relative(root, target);
  return rel.replaceAll("\\", "/");
}

function sameNativePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sameFileIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function stalePathError(): FilesError {
  return new FilesError(409, "STALE_PATH", "The file changed before the operation could complete.");
}

function normalizeDirectoryPath(
  pathInput: string | undefined,
  registeredRoot: string,
  realRoot: string,
): string {
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
  redactor: FilesMetadataRedactor,
): Promise<ResolvedProjectRoot & { readonly path: string; readonly relativePath: string }> {
  const root = await resolveRoot(store, rootInput, redactor);
  const candidate = normalizeDirectoryPath(pathInput, root.root, root.realRoot);
  const pathValue = await resolveDirectory(candidate);
  assertMetadataSafe(pathValue, redactor);
  if (!isContained(root.realRoot, pathValue)) {
    throw new FilesError(403, "PATH_ESCAPE", "The requested path is outside the selected project.");
  }
  const relativePath = rootRelativePosixPath(root.realRoot, pathValue);
  assertMetadataSafe(relativePath, redactor);
  if (pathIsDenied(relativePath)) {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
  return { ...root, path: pathValue, relativePath };
}

async function resolveInsideRoot(
  store: UiStore,
  rootInput: string | null,
  pathInput: string | null,
  redactor: FilesMetadataRedactor,
): Promise<ResolvedTarget> {
  const root = await resolveRoot(store, rootInput, redactor);
  const relativePath = normalizeRelativePath(pathInput);
  assertMetadataSafe(relativePath, redactor);
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
  assertMetadataSafe(targetRelativePath, redactor);
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

async function directoryEntries(
  root: string,
  pathValue: string,
  redactor: FilesMetadataRedactor,
): Promise<readonly FilesDirectoryEntry[]> {
  const entries: FilesDirectoryEntry[] = [];
  const dir = await opendir(pathValue);
  try {
    for await (const entry of dir) {
      if (!entry.isDirectory()) continue;
      const entryPath = join(pathValue, entry.name);
      const relativePath = rootRelativePosixPath(root, entryPath);
      if (!metadataIsSafe(relativePath, redactor)) continue;
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
  redactor: FilesMetadataRedactor = staticFilesMetadataRedactor,
): Promise<FilesDirectoryListing> {
  const target = await resolveDirectoryInsideRoot(store, rootInput, pathInput, redactor);
  return {
    path: target.path,
    parent: parentPath(target.path, target.realRoot),
    entries: await directoryEntries(target.realRoot, target.path, redactor),
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

type FilesTreeEntryBase = Omit<FilesTreeEntry, "kind" | "readable">;

async function classifySymlinkEntry(
  root: string,
  entryPath: string,
  base: FilesTreeEntryBase,
): Promise<FilesTreeEntry> {
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

async function classifyEntry(
  root: string,
  parentRelativePath: string,
  parentNativePath: string,
  entry: Dirent,
  redactor: FilesMetadataRedactor,
): Promise<FilesTreeEntry> {
  const childRelativePath =
    parentRelativePath.length === 0 ? entry.name : `${parentRelativePath}/${entry.name}`;
  assertMetadataSafe(childRelativePath, redactor);
  const entryPath = join(parentNativePath, entry.name);
  if (entry.isDirectory() && !entry.isSymbolicLink()) {
    return {
      name: entry.name,
      path: childRelativePath,
      kind: "directory",
      sizeBytes: 0,
      modifiedAt: 0,
      extension: extensionOf(entry.name),
      symlink: false,
      readable: true,
    };
  }
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
  return classifySymlinkEntry(root, entryPath, base);
}

function entryRank(entry: FilesTreeEntry): number {
  if (entry.kind === "directory") return 0;
  if (entry.kind === "file") return 1;
  return 2;
}

function childRelative(parentRelativePath: string, name: string): string {
  return parentRelativePath.length === 0 ? name : `${parentRelativePath}/${name}`;
}

function skipEntry(rel: string): boolean {
  return pathIsDenied(rel);
}

async function mapInBatches<T, R>(
  values: readonly T[],
  batchSize: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < values.length; offset += batchSize) {
    results.push(...(await Promise.all(values.slice(offset, offset + batchSize).map(mapper))));
  }
  return results;
}

async function listTreeEntries(
  root: string,
  relativePath: string,
  pathValue: string,
  redactor: FilesMetadataRedactor,
): Promise<{
  readonly entries: readonly FilesTreeEntry[];
  readonly truncated: boolean;
}> {
  const dirents: Dirent[] = [];
  const dir = await opendir(pathValue);
  let truncated = false;
  try {
    for await (const entry of dir) {
      // Deny filtering happens BEFORE the truncation counter so a directory packed with denied
      // entries (e.g. node_modules/**) cannot exhaust the 1000-entry budget and hide real files
      // behind `truncated: true`. .gitignore is intentionally not a Files visibility filter:
      // safe dotfiles and generated files must remain visible and connectable.
      const rel = childRelative(relativePath, entry.name);
      if (!metadataIsSafe(rel, redactor)) continue;
      if (skipEntry(rel)) continue;
      if (dirents.length >= MAX_DIRECTORY_ENTRIES) {
        truncated = true;
        break;
      }
      dirents.push(entry);
    }
  } finally {
    await dir.close().catch(() => undefined);
  }
  const entries = await mapInBatches(dirents, TREE_CLASSIFY_CONCURRENCY, (entry) =>
    classifyEntry(root, relativePath, pathValue, entry, redactor),
  );
  entries.sort((a, b) => entryRank(a) - entryRank(b) || a.name.localeCompare(b.name));
  return { entries, truncated };
}

export async function readFilesTree(
  store: UiStore,
  rootInput: string | null,
  pathInput: string | null,
  redactor: FilesMetadataRedactor = staticFilesMetadataRedactor,
): Promise<FilesTreeResponse> {
  const target = await resolveInsideRoot(store, rootInput, pathInput, redactor);
  if (!target.stats.isDirectory()) {
    throw new FilesError(400, "NOT_DIRECTORY", "The requested path is not a directory.");
  }
  const listed = await listTreeEntries(target.realRoot, target.relativePath, target.path, redactor);
  return {
    root: target.root,
    path: target.relativePath,
    entries: listed.entries,
    truncated: listed.truncated,
  };
}

function parseSearchLimit(rawLimit: string | null): number {
  if (rawLimit === null || rawLimit.trim().length === 0) return DEFAULT_FILE_SEARCH_LIMIT;
  const parsed = Number(rawLimit);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new FilesError(400, "BAD_LIMIT", "The search limit must be a positive integer.");
  }
  return Math.min(parsed, MAX_FILE_SEARCH_LIMIT);
}

function normalizeSearchQuery(queryInput: string | null): string {
  const query = (queryInput ?? "").trim().replace(/\s+/gu, " ");
  if (query.includes("\0")) {
    throw new FilesError(400, "BAD_QUERY", "The search query contains an invalid character.");
  }
  if (query.length > MAX_FILE_SEARCH_QUERY_CHARS) {
    throw new FilesError(
      400,
      "BAD_QUERY",
      `The search query must be at most ${String(MAX_FILE_SEARCH_QUERY_CHARS)} characters.`,
    );
  }
  return query;
}

function searchTokens(query: string): readonly string[] {
  return query
    .toLocaleLowerCase()
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function matchesSearch(relativePath: string, tokens: readonly string[]): boolean {
  const lowerPath = relativePath.toLocaleLowerCase();
  return tokens.every((token) => lowerPath.includes(token));
}

function fileSearchScore(relativePath: string, query: string): number {
  const lowerPath = relativePath.toLocaleLowerCase();
  const lowerName = basename(relativePath).toLocaleLowerCase();
  const lowerQuery = query.toLocaleLowerCase();
  if (lowerName === lowerQuery) return 0;
  if (lowerName.startsWith(lowerQuery)) return 100 + relativePath.length;
  if (lowerPath === lowerQuery) return 200 + relativePath.length;
  if (lowerPath.startsWith(lowerQuery)) return 300 + relativePath.length;
  const nameIndex = lowerName.indexOf(lowerQuery);
  if (nameIndex >= 0) return 400 + nameIndex + relativePath.length;
  const pathIndex = lowerPath.indexOf(lowerQuery);
  if (pathIndex >= 0) return 600 + pathIndex + relativePath.length;
  return 1_000 + relativePath.length;
}

const GENERATED_FILE_SEARCH_SEGMENTS = new Set([
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "out",
  "storybook-static",
  "storybookstatic",
  "target",
]);

const SOURCE_FILE_SEARCH_SEGMENTS = new Set([
  "__tests__",
  "app",
  "components",
  "lib",
  "packages",
  "scripts",
  "src",
  "test",
  "tests",
]);

const SOURCE_FILE_SEARCH_EXTENSIONS = new Set([
  "astro",
  "c",
  "cc",
  "cjs",
  "cpp",
  "cs",
  "css",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "jsx",
  "kt",
  "kts",
  "mjs",
  "mts",
  "php",
  "py",
  "rb",
  "rs",
  "scala",
  "scss",
  "sh",
  "svelte",
  "swift",
  "ts",
  "tsx",
  "vue",
]);

const TEST_FILE_SEARCH_SEGMENTS = new Set(["__tests__", "__test__", "spec", "test", "tests"]);

const DOCS_FILE_SEARCH_SEGMENTS = new Set(["doc", "docs", "documentation"]);

const DOCS_FILE_SEARCH_EXTENSIONS = new Set(["adoc", "md", "mdx", "rst", "txt"]);

const CONFIG_FILE_SEARCH_NAMES = new Set([
  ".babelrc",
  ".editorconfig",
  ".env.example",
  ".eslintrc",
  ".gitattributes",
  ".gitignore",
  ".npmrc",
  ".prettierrc",
  "dockerfile",
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "vitest.config.ts",
]);

const CONFIG_FILE_SEARCH_EXTENSIONS = new Set([
  "config",
  "conf",
  "ini",
  "json",
  "jsonc",
  "lock",
  "toml",
  "yaml",
  "yml",
]);

const ASSET_FILE_SEARCH_EXTENSIONS = new Set([
  "avif",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "map",
  "png",
  "svg",
  "webp",
  "woff",
  "woff2",
]);

interface FileSearchPathParts {
  readonly lowerSegments: readonly string[];
  readonly lowerName: string;
  readonly extension: string;
}

function fileSearchPathParts(relativePath: string): FileSearchPathParts {
  const normalized = relativePath.replaceAll("\\", "/");
  const lowerSegments = normalized
    .toLocaleLowerCase()
    .split("/")
    .filter((segment) => segment.length > 0);
  const lowerName = basename(normalized).toLocaleLowerCase();
  const extension = extensionOf(lowerName)?.toLocaleLowerCase() ?? "";
  return { lowerSegments, lowerName, extension };
}

function fileSearchQualityScore(relativePath: string): number {
  const normalized = relativePath.replaceAll("\\", "/");
  const lowerSegments = normalized
    .toLocaleLowerCase()
    .split("/")
    .filter((segment) => segment.length > 0);
  const extension = extensionOf(basename(normalized))?.toLocaleLowerCase() ?? "";
  let score = 0;

  if (lowerSegments.some((segment) => GENERATED_FILE_SEARCH_SEGMENTS.has(segment))) {
    score += 20_000;
  }
  if (lowerSegments.includes("assets") && /\b[a-f0-9]{7,}\b/u.test(basename(normalized))) {
    score += 2_000;
  }
  if (lowerSegments.some((segment) => SOURCE_FILE_SEARCH_SEGMENTS.has(segment))) {
    score -= 250;
  }
  if (SOURCE_FILE_SEARCH_EXTENSIONS.has(extension)) {
    score -= 100;
  }
  if (lowerSegments.includes("src")) {
    score -= 200;
  }
  return score;
}

function fileSearchPathHasSegment(
  parts: FileSearchPathParts,
  segments: ReadonlySet<string>,
): boolean {
  return parts.lowerSegments.some((segment) => segments.has(segment));
}

function fileSearchPathIsGenerated(parts: FileSearchPathParts): boolean {
  return fileSearchPathHasSegment(parts, GENERATED_FILE_SEARCH_SEGMENTS);
}

function fileSearchPathIsAsset(parts: FileSearchPathParts): boolean {
  return (
    parts.lowerSegments.includes("assets") || ASSET_FILE_SEARCH_EXTENSIONS.has(parts.extension)
  );
}

function fileSearchPathIsTest(parts: FileSearchPathParts): boolean {
  return (
    fileSearchPathHasSegment(parts, TEST_FILE_SEARCH_SEGMENTS) ||
    /\.(?:spec|test)\.[^.]+$/u.test(parts.lowerName)
  );
}

function fileSearchPathIsDocs(parts: FileSearchPathParts): boolean {
  return (
    fileSearchPathHasSegment(parts, DOCS_FILE_SEARCH_SEGMENTS) ||
    DOCS_FILE_SEARCH_EXTENSIONS.has(parts.extension)
  );
}

function fileSearchPathIsConfig(parts: FileSearchPathParts): boolean {
  return (
    CONFIG_FILE_SEARCH_NAMES.has(parts.lowerName) ||
    CONFIG_FILE_SEARCH_EXTENSIONS.has(parts.extension)
  );
}

function fileSearchPathIsSource(parts: FileSearchPathParts): boolean {
  return (
    fileSearchPathHasSegment(parts, SOURCE_FILE_SEARCH_SEGMENTS) ||
    SOURCE_FILE_SEARCH_EXTENSIONS.has(parts.extension)
  );
}

const FILE_SEARCH_ROLE_MATCHERS: readonly [
  FilesSearchFileRole,
  (parts: FileSearchPathParts) => boolean,
][] = [
  ["generated", fileSearchPathIsGenerated],
  ["asset", fileSearchPathIsAsset],
  ["test", fileSearchPathIsTest],
  ["docs", fileSearchPathIsDocs],
  ["config", fileSearchPathIsConfig],
  ["source", fileSearchPathIsSource],
];

function fileSearchRole(relativePath: string): FilesSearchFileRole {
  const parts = fileSearchPathParts(relativePath);
  return FILE_SEARCH_ROLE_MATCHERS.find(([_role, matches]) => matches(parts))?.[0] ?? "other";
}

function fileSearchMatchQuality(relativePath: string, query: string): FilesSearchMatchQuality {
  const lowerPath = relativePath.toLocaleLowerCase();
  const lowerName = basename(relativePath).toLocaleLowerCase();
  const lowerQuery = query.toLocaleLowerCase();
  const nameStem = lowerName.replace(/\.[^.]+$/u, "");

  if (lowerName === lowerQuery || lowerPath === lowerQuery || nameStem === lowerQuery) {
    return "exact";
  }
  if (lowerName.startsWith(lowerQuery) || lowerName.includes(lowerQuery)) {
    return "strong";
  }
  if (lowerPath.startsWith(lowerQuery) || lowerPath.includes(lowerQuery)) {
    return "path";
  }
  return "weak";
}

function directoryOf(relativePath: string): string {
  const dir = pathPosix.dirname(relativePath);
  return dir === "." ? "" : dir;
}

interface FileSearchCandidate {
  readonly score: number;
  readonly result: FilesSearchResult;
}

interface FileSearchStackEntry {
  readonly path: string;
  readonly relativePath: string;
}

interface FileSearchState {
  candidates: FileSearchCandidate[];
  stack: FileSearchStackEntry[];
  gitRootCache: Map<string, string | null>;
  scannedFileCount: number;
  scanTruncated: boolean;
}

interface FileSearchResolvedPath {
  readonly root: string;
  readonly relativePath: string;
  readonly rootKind: FilesSearchRootKind;
}

function entryVisibleToFileSearch(
  relativePath: string,
  entry: Dirent,
  redactor: FilesMetadataRedactor,
): boolean {
  return (
    metadataIsSafe(relativePath, redactor) && !pathIsDenied(relativePath) && !entry.isSymbolicLink()
  );
}

async function hasGitMarker(directory: string): Promise<boolean> {
  try {
    await lstat(join(directory, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function nearestGitRoot(
  startDirectory: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  let current = resolve(startDirectory);
  const visited: string[] = [];
  for (;;) {
    const cached = cache.get(current);
    if (cached !== undefined) {
      for (const directory of visited) cache.set(directory, cached);
      return cached;
    }
    visited.push(current);
    if (await hasGitMarker(current)) {
      for (const directory of visited) cache.set(directory, current);
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      for (const directory of visited) cache.set(directory, null);
      return null;
    }
    current = parent;
  }
}

function canExposeFileSearchGitRoot(
  selectedRoot: ResolvedProjectRoot,
  gitRoot: string,
  redactor: FilesMetadataRedactor,
): boolean {
  return (
    gitRoot !== selectedRoot.realRoot &&
    isContained(selectedRoot.realRoot, gitRoot) &&
    !pathIsDenied(gitRoot) &&
    metadataIsSafe(gitRoot, redactor)
  );
}

function canExposeFileSearchRelativePath(
  relativePath: string,
  redactor: FilesMetadataRedactor,
): boolean {
  return (
    relativePath.length > 0 &&
    !relativePath.startsWith("../") &&
    !pathPosix.isAbsolute(relativePath) &&
    !pathIsDenied(relativePath) &&
    metadataIsSafe(relativePath, redactor)
  );
}

async function resolveFileSearchResultPath(args: {
  readonly root: ResolvedProjectRoot;
  readonly relativePath: string;
  readonly nativePath: string;
  readonly redactor: FilesMetadataRedactor;
  readonly state: FileSearchState;
}): Promise<FileSearchResolvedPath> {
  const fallback: FileSearchResolvedPath = {
    root: args.root.root,
    relativePath: args.relativePath,
    rootKind: "selected-root",
  };
  const gitRoot = await nearestGitRoot(dirname(args.nativePath), args.state.gitRootCache);
  if (gitRoot === null || !canExposeFileSearchGitRoot(args.root, gitRoot, args.redactor)) {
    return fallback;
  }

  const rebasedPath = rootRelativePosixPath(gitRoot, args.nativePath);
  if (!canExposeFileSearchRelativePath(rebasedPath, args.redactor)) return fallback;

  return { root: gitRoot, relativePath: rebasedPath, rootKind: "nested-git-root" };
}

async function addFileSearchCandidate(args: {
  readonly root: ResolvedProjectRoot;
  readonly query: string;
  readonly relativePath: string;
  readonly nativePath: string;
  readonly entryName: string;
  readonly tokens: readonly string[];
  readonly redactor: FilesMetadataRedactor;
  readonly state: FileSearchState;
}): Promise<void> {
  if (!matchesSearch(args.relativePath, args.tokens)) return;
  let info: Stats;
  try {
    info = await lstat(args.nativePath);
  } catch {
    return;
  }
  const resolvedPath = await resolveFileSearchResultPath({
    root: args.root,
    relativePath: args.relativePath,
    nativePath: args.nativePath,
    redactor: args.redactor,
    state: args.state,
  });
  args.state.candidates.push({
    score:
      fileSearchScore(resolvedPath.relativePath, args.query) +
      fileSearchQualityScore(resolvedPath.relativePath),
    result: {
      root: resolvedPath.root,
      path: resolvedPath.relativePath,
      name: args.entryName,
      directory: directoryOf(resolvedPath.relativePath),
      extension: extensionOf(args.entryName),
      sizeBytes: info.size,
      modifiedAt: info.mtimeMs,
      fileRole: fileSearchRole(resolvedPath.relativePath),
      matchQuality: fileSearchMatchQuality(resolvedPath.relativePath, args.query),
      rootKind: resolvedPath.rootKind,
    },
  });
}

interface PendingFileSearchCandidate {
  readonly root: ResolvedProjectRoot;
  readonly query: string;
  readonly relativePath: string;
  readonly nativePath: string;
  readonly entryName: string;
  readonly tokens: readonly string[];
  readonly redactor: FilesMetadataRedactor;
  readonly state: FileSearchState;
}

function collectFileSearchEntry(args: {
  readonly current: FileSearchStackEntry;
  readonly entry: Dirent;
  readonly root: ResolvedProjectRoot;
  readonly query: string;
  readonly tokens: readonly string[];
  readonly redactor: FilesMetadataRedactor;
  readonly state: FileSearchState;
}): PendingFileSearchCandidate | undefined {
  const relativePath = childRelative(args.current.relativePath, args.entry.name);
  if (!entryVisibleToFileSearch(relativePath, args.entry, args.redactor)) return undefined;
  const nativePath = join(args.current.path, args.entry.name);
  if (args.entry.isDirectory()) {
    args.state.stack.push({ path: nativePath, relativePath });
    return undefined;
  }
  if (!args.entry.isFile()) return undefined;
  args.state.scannedFileCount += 1;
  if (args.state.scannedFileCount > MAX_FILE_SEARCH_SCAN) {
    args.state.scanTruncated = true;
    return undefined;
  }
  if (!matchesSearch(relativePath, args.tokens)) return undefined;
  return {
    root: args.root,
    query: args.query,
    relativePath,
    nativePath,
    entryName: args.entry.name,
    tokens: args.tokens,
    redactor: args.redactor,
    state: args.state,
  };
}

async function collectFileSearchDirectory(args: {
  readonly current: FileSearchStackEntry;
  readonly root: ResolvedProjectRoot;
  readonly query: string;
  readonly tokens: readonly string[];
  readonly redactor: FilesMetadataRedactor;
  readonly state: FileSearchState;
}): Promise<void> {
  let dir;
  try {
    dir = await opendir(args.current.path);
  } catch {
    return;
  }
  const candidates: PendingFileSearchCandidate[] = [];
  try {
    for await (const entry of dir) {
      const candidate = collectFileSearchEntry({ ...args, entry });
      if (candidate !== undefined) candidates.push(candidate);
      if (args.state.scanTruncated) break;
    }
  } finally {
    await dir.close().catch(() => undefined);
  }
  await mapInBatches(candidates, FILE_SEARCH_CANDIDATE_CONCURRENCY, addFileSearchCandidate);
}

async function collectFileSearchResults(args: {
  readonly root: ResolvedProjectRoot;
  readonly query: string;
  readonly limit: number;
  readonly redactor: FilesMetadataRedactor;
}): Promise<Omit<FilesSearchResponse, "root" | "query">> {
  const tokens = searchTokens(args.query);
  if (tokens.length === 0) {
    return { results: [], truncated: false, scannedFileCount: 0 };
  }

  const state: FileSearchState = {
    candidates: [],
    stack: [{ path: args.root.realRoot, relativePath: "" }],
    gitRootCache: new Map(),
    scannedFileCount: 0,
    scanTruncated: false,
  };

  while (state.stack.length > 0) {
    const current = state.stack.pop();
    if (current === undefined) break;
    await collectFileSearchDirectory({ ...args, current, tokens, state });
    if (state.scanTruncated) break;
  }

  state.candidates.sort((a, b) => a.score - b.score || a.result.path.localeCompare(b.result.path));
  return {
    results: state.candidates.slice(0, args.limit).map((candidate) => candidate.result),
    truncated: state.scanTruncated || state.candidates.length > args.limit,
    scannedFileCount: Math.min(state.scannedFileCount, MAX_FILE_SEARCH_SCAN),
  };
}

export async function searchFiles(
  store: UiStore,
  rootInput: string | null,
  queryInput: string | null,
  limitInput?: number,
  redactor: FilesMetadataRedactor = staticFilesMetadataRedactor,
): Promise<FilesSearchResponse> {
  const root = await resolveRoot(store, rootInput, redactor);
  const query = normalizeSearchQuery(queryInput);
  const limit = Math.min(
    Math.max(limitInput ?? DEFAULT_FILE_SEARCH_LIMIT, 1),
    MAX_FILE_SEARCH_LIMIT,
  );
  const collected = await collectFileSearchResults({ root, query, limit, redactor });
  return {
    root: root.root,
    query,
    ...collected,
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

function decodeUtf8(buffer: Buffer): string | null {
  try {
    return UTF8_DECODER.decode(buffer);
  } catch {
    return null;
  }
}

function decodedTextLooksPrintable(decoded: string): boolean {
  if (decoded.length === 0) return true;
  let printable = 0;
  for (const char of decoded) {
    const code = char.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || code >= 32) printable += 1;
  }
  return printable / decoded.length > 0.85;
}

function isLikelyUtf8Text(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  const decoded = decodeUtf8(buffer);
  return decoded !== null && decodedTextLooksPrintable(decoded);
}

function isEditableUtf8File(extension: string | null, buffer: Buffer): boolean {
  const decoded = decodeUtf8(buffer);
  if (decoded === null || buffer.includes(0)) return false;
  return isKnownTextExtension(extension) || isLikelyUtf8Text(buffer);
}

async function readPrefix(
  pathValue: string,
  maxBytes: number,
): Promise<{
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

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise<string>((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        if (!capped) {
          capped = true;
          chunks.length = 0;
          reject(new BodyTooLargeError());
          req.resume();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

export async function readJsonObject(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown> | RouteResult> {
  let raw: string;
  try {
    raw = await readBody(req, maxBytes);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return {
        status: 413,
        body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit."),
      };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    return { status: 400, body: errorBody("BAD_REQUEST", "Request body is not valid JSON.") };
  }
  if (!isRecord(parsed)) {
    return { status: 400, body: errorBody("BAD_REQUEST", "Request body must be a JSON object.") };
  }
  return parsed;
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

function imagePreviewUrl(base: FilesPreviewBase): string {
  const params = new URLSearchParams({
    root: base.root,
    path: base.path,
    v: `${String(base.sizeBytes)}-${String(Math.floor(base.modifiedAt))}`,
  });
  return `/api/files/preview/image?${params.toString()}`;
}

function imagePreview(target: ResolvedTarget, base: FilesPreviewBase): FilesPreviewResponse {
  if (target.stats.size > MAX_IMAGE_PREVIEW_BYTES) {
    return { ...base, kind: "binary", reason: "too_large", maxBytes: MAX_IMAGE_PREVIEW_BYTES };
  }
  return {
    ...base,
    kind: "image",
    url: imagePreviewUrl(base),
    maxBytes: MAX_IMAGE_PREVIEW_BYTES,
  };
}

async function textPreview(
  target: ResolvedTarget,
  base: FilesPreviewBase,
  redactor: UiHandlerDeps["redactor"],
): Promise<FilesPreviewResponse> {
  const prefix = await readPrefix(target.path, MAX_TEXT_PREVIEW_BYTES);
  const content = decodeUtf8(prefix.buffer);
  if (content === null || prefix.buffer.includes(0)) {
    return { ...base, kind: "binary", reason: "unsupported" };
  }
  const redacted = redactor(content);
  return {
    ...base,
    kind: "text",
    content: typeof redacted === "string" ? redacted : content,
    truncated: prefix.truncated,
    maxBytes: MAX_TEXT_PREVIEW_BYTES,
  };
}

// Issue #1197: content-free document version. The hash is a one-way SHA-256 of the editable
// UTF-8 content — it never echoes the content itself.
function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function documentVersion(content: string, stats: Stats): EditorDocumentVersion {
  return { sizeBytes: stats.size, modifiedAt: stats.mtimeMs, contentHash: sha256Hex(content) };
}

function editorSession(version: EditorDocumentVersion): EditorDocumentSession {
  return { schemaVersion: EDITOR_SESSION_SCHEMA_VERSION, version };
}

function statsMatch(left: Stats, right: Stats): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

async function readStableEditableContent(
  target: ResolvedTarget,
): Promise<{ readonly content: string; readonly stats: Stats }> {
  let before = target.stats;
  for (let attempt = 0; attempt < STABLE_CONTENT_READ_ATTEMPTS; attempt += 1) {
    if (before.size > MAX_TEXT_PREVIEW_BYTES) {
      throw new FilesError(
        413,
        "FILE_TOO_LARGE",
        `This file is too large to edit here (limit ${String(MAX_TEXT_PREVIEW_BYTES)} bytes).`,
      );
    }
    const buffer = await readFile(target.path);
    const content = decodeUtf8(buffer);
    if (content === null || buffer.includes(0)) {
      throw new FilesError(400, "UNSUPPORTED_FILE", "This file cannot be edited in the workspace.");
    }
    const after = await stat(target.path);
    if (statsMatch(before, after)) return { content, stats: after };
    before = after;
    if (attempt < STABLE_CONTENT_READ_ATTEMPTS - 1) {
      await sleep(STABLE_CONTENT_RETRY_DELAY_MS);
    }
  }
  throw new FilesError(
    409,
    "STALE_SESSION",
    "This file changed while it was being opened. Reload it before editing.",
  );
}

// Issue #1197: version-aware optimistic concurrency. Rejects a save when the on-disk document no
// longer matches the revision the editor opened. Size/mtime are compared first so the content is
// only re-read (bounded by the editable size limit) when those cheap signals match.
async function assertSessionNotStale(
  target: ResolvedTarget,
  baseVersion: EditorDocumentVersion,
): Promise<void> {
  const sizeMatches = target.stats.size === baseVersion.sizeBytes;
  const mtimeMatches = Math.abs(target.stats.mtimeMs - baseVersion.modifiedAt) <= 1;
  let hashMatches = false;
  if (sizeMatches && mtimeMatches && target.stats.size <= MAX_TEXT_PREVIEW_BYTES) {
    // Bounded re-read (mirrors the content-classification read): if the file grew past the editable
    // limit between the stat and this read, treat the truncated result as a mismatch.
    const current = await readPrefix(target.path, MAX_TEXT_PREVIEW_BYTES);
    const currentContent = decodeUtf8(current.buffer);
    hashMatches =
      !current.truncated &&
      currentContent !== null &&
      !current.buffer.includes(0) &&
      sha256Hex(currentContent) === baseVersion.contentHash;
  }
  if (!sizeMatches || !mtimeMatches || !hashMatches) {
    throw new FilesError(
      409,
      "STALE_SESSION",
      "This file changed since it was opened. Reload it before saving again.",
    );
  }
}

// Optimistic-concurrency gate for a save. The version-aware baseVersion check (Issue #1197)
// supersedes the legacy mtime-only `expectedModifiedAt` check; either may be absent (forced save).
async function assertNoWriteConflict(
  target: ResolvedTarget,
  baseVersion: EditorDocumentVersion | undefined,
  expectedModifiedAt: number | undefined,
): Promise<void> {
  if (baseVersion !== undefined) {
    await assertSessionNotStale(target, baseVersion);
    return;
  }
  if (expectedModifiedAt !== undefined && Math.abs(target.stats.mtimeMs - expectedModifiedAt) > 1) {
    throw new FilesError(
      409,
      "WRITE_CONFLICT",
      "This file changed on disk. Reload it before saving again.",
    );
  }
}

async function editableTextContent(target: ResolvedTarget): Promise<FilesContentResponse> {
  const snapshot = await readStableEditableContent(target);
  const stableTarget = { ...target, stats: snapshot.stats };
  const base = basePreview(stableTarget);
  return {
    ...base,
    content: snapshot.content,
    maxBytes: MAX_TEXT_PREVIEW_BYTES,
    session: editorSession(documentVersion(snapshot.content, snapshot.stats)),
  };
}

export async function readFilesContent(
  store: UiStore,
  rootInput: string | null,
  pathInput: string | null,
  redactor: FilesMetadataRedactor = staticFilesMetadataRedactor,
): Promise<FilesContentResponse> {
  const target = await resolveInsideRoot(store, rootInput, pathInput, redactor);
  if (!target.stats.isFile()) {
    throw new FilesError(400, "NOT_FILE", "The requested path is not a file.");
  }
  const base = basePreview(target);
  const prefix = await readPrefix(target.path, Math.min(target.stats.size, 4096));
  if (!isEditableUtf8File(base.extension, prefix.buffer)) {
    throw new FilesError(400, "UNSUPPORTED_FILE", "This file cannot be edited in the workspace.");
  }
  return editableTextContent(target);
}

async function writeResolvedFilesContent(args: {
  readonly target: ResolvedTarget;
  readonly content: string;
  readonly expectedModifiedAt?: number | undefined;
  readonly baseVersion?: EditorDocumentVersion | undefined;
}): Promise<FilesContentResponse> {
  if (!args.target.stats.isFile()) {
    throw new FilesError(400, "NOT_FILE", "The requested path is not a file.");
  }
  const base = basePreview(args.target);
  const prefix = await readPrefix(args.target.path, Math.min(args.target.stats.size, 4096));
  if (!isEditableUtf8File(base.extension, prefix.buffer)) {
    throw new FilesError(400, "UNSUPPORTED_FILE", "This file cannot be edited in the workspace.");
  }
  await assertNoWriteConflict(args.target, args.baseVersion, args.expectedModifiedAt);
  if (Buffer.byteLength(args.content, "utf8") > MAX_TEXT_PREVIEW_BYTES) {
    throw new FilesError(
      413,
      "FILE_TOO_LARGE",
      `This file is too large to edit here (limit ${String(MAX_TEXT_PREVIEW_BYTES)} bytes).`,
    );
  }
  const updatedStats = await writeExistingResolvedFile(args.target, args.content);
  return {
    ...base,
    sizeBytes: updatedStats.size,
    modifiedAt: updatedStats.mtimeMs,
    content: args.content,
    maxBytes: MAX_TEXT_PREVIEW_BYTES,
    session: editorSession(documentVersion(args.content, updatedStats)),
  };
}

export async function writeFilesContent(args: {
  readonly store: UiStore;
  readonly rootInput: string | null;
  readonly pathInput: string | null;
  readonly content: string;
  readonly expectedModifiedAt?: number | undefined;
  readonly baseVersion?: EditorDocumentVersion | undefined;
  readonly redactor?: FilesMetadataRedactor | undefined;
}): Promise<FilesContentResponse> {
  const target = await resolveInsideRoot(
    args.store,
    args.rootInput,
    args.pathInput,
    args.redactor ?? staticFilesMetadataRedactor,
  );
  return writeResolvedFilesContent({
    target,
    content: args.content,
    expectedModifiedAt: args.expectedModifiedAt,
    baseVersion: args.baseVersion,
  });
}

// ---------------------------------------------------------------------------
// Filesystem mutations (create / rename / delete) for the Files widget.
//
// Every mutation reuses the SAME containment model as the read surface: the root is realpath-resolved,
// the target (or, for a create, its parent) is resolved through symlinks and re-checked for
// containment and against the deny-list, and metadata is redaction-checked. Mutations are
// non-destructive by default — a create never overwrites (atomic O_EXCL), a rename refuses an
// existing destination, and symlinks are rejected rather than silently dereferenced. The deny-list
// (.git, node_modules, secrets, build output) is enforced on both source and destination, so a
// mutation can never reach an excluded path even though it is otherwise inside the root.
// ---------------------------------------------------------------------------

export interface FilesMutationResponse {
  // Echo of the root identity the request used (registered project path or arbitrary absolute root).
  readonly root: string;
  // Canonical root-relative POSIX path of the affected entry (the NEW path for create and rename).
  readonly path: string;
  // For a rename, the prior root-relative path, so the client can re-home open editor tabs.
  readonly previousPath?: string;
  readonly kind: FilesEntryKind;
}

// errno → client-safe (status, code, message), one row per outcome. fs.cp reports collisions and
// shape mismatches with bespoke ERR_FS_CP_* codes, so each row groups every code that should map to
// the same response. A flat table keeps mapNodeFsError a single lookup (no branch-per-code) and well
// under the complexity budget. None of these messages echoes a path or the raw OS string.
const FS_ERRNO_TABLE: readonly (readonly [readonly string[], number, string, string])[] = [
  // `fs.cp` reports a no-overwrite collision with its own code, not the bare EEXIST.
  [
    ["EEXIST", "ENOTEMPTY", "ERR_FS_CP_EEXIST"],
    409,
    "ALREADY_EXISTS",
    "An entry with that name already exists.",
  ],
  [["ENOENT"], 404, "NOT_FOUND", "The requested path was not found."],
  // `fs.cp` shape-mismatch / invalid-argument codes (e.g. copying a dir over a file) → bad request.
  [
    [
      "ERR_FS_CP_DIR_TO_NON_DIR",
      "ERR_FS_CP_NON_DIR_TO_DIR",
      "ERR_FS_CP_EINVAL",
      "ERR_FS_CP_FIFO_PIPE_OR_SOCKET",
    ],
    400,
    "BAD_PATH",
    "This entry cannot be copied here.",
  ],
  [["EACCES", "EPERM"], 403, "DENIED", DENIED_MESSAGE],
  [["EXDEV"], 400, "CROSS_DEVICE", "This move crosses filesystems and is not supported here."],
  [["ENOTDIR"], 400, "NOT_DIRECTORY", "Part of the path is not a folder."],
  [["EISDIR"], 400, "IS_DIRECTORY", "The target is a folder."],
];

const FS_ERRNO_LOOKUP: ReadonlyMap<string, readonly [number, string, string]> = new Map(
  FS_ERRNO_TABLE.flatMap(([codes, status, code, message]) =>
    codes.map((errno) => [errno, [status, code, message] as const] as const),
  ),
);

// Translate a Node fs errno into a FilesError without ever echoing the absolute path or the raw OS
// message back to the client — mirroring the non-probeable DENIED_MESSAGE discipline. A FilesError is
// passed through unchanged; an unrecognised error becomes a generic 500 so an internal detail (e.g.
// a path embedded in the OS message) cannot leak through the response body.
function mapNodeFsError(error: unknown): FilesError {
  if (error instanceof FilesError) return error;
  const code =
    typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
  const mapped = code !== undefined ? FS_ERRNO_LOOKUP.get(code) : undefined;
  if (mapped !== undefined) {
    return new FilesError(mapped[0], mapped[1], mapped[2]);
  }
  return new FilesError(500, "IO_ERROR", "The file operation could not be completed.");
}

interface ResolvedCreationTarget {
  readonly root: string;
  readonly realRoot: string;
  readonly relativePath: string;
  readonly path: string;
}

// Resolve a path that should NOT exist yet (a create destination, or a rename target). The PARENT
// directory must already exist; it is resolved through symlinks and re-checked for containment and
// deny so a link in the parent chain cannot redirect the new entry outside the root. The final name
// is validated as a single, safe path segment.
// The final segment of a new entry must be a single, safe name (the parent path was already split
// off and validated). normalizeRelativePath has already rejected NUL/absolute/`..`-escape inputs.
function assertSafeLeafName(name: string): void {
  if (name.length === 0 || name === "." || name === "..") {
    throw new FilesError(400, "BAD_PATH", "The new entry name is not valid.");
  }
}

// Resolve the directory a new entry will be created in: it must already exist, be a directory,
// resolve (through symlinks) to a path inside the root, and not be deny-listed.
async function resolveContainedParentDir(
  realRoot: string,
  parentRelative: string,
): Promise<string> {
  const parentNative = nativePath(realRoot, parentRelative === "." ? "" : parentRelative);
  let realParent: string;
  try {
    realParent = await realpath(parentNative);
  } catch {
    throw new FilesError(404, "PARENT_NOT_FOUND", "The destination folder does not exist.");
  }
  if (!(await stat(realParent)).isDirectory()) {
    throw new FilesError(400, "NOT_DIRECTORY", "The destination is not a folder.");
  }
  if (!isContained(realRoot, realParent)) {
    throw new FilesError(403, "PATH_ESCAPE", "The destination is outside the selected root.");
  }
  const parentRelReal = rootRelativePosixPath(realRoot, realParent);
  if (parentRelReal.length > 0 && pathIsDenied(parentRelReal)) {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
  return realParent;
}

async function resolveCreationTarget(
  store: UiStore,
  rootInput: string | null,
  pathInput: string | null,
  redactor: FilesMetadataRedactor,
): Promise<ResolvedCreationTarget> {
  const root = await resolveRoot(store, rootInput, redactor);
  const relativePath = normalizeRelativePath(pathInput);
  if (relativePath.length === 0) {
    throw new FilesError(400, "BAD_PATH", "A new entry needs a name inside the selected root.");
  }
  assertMetadataSafe(relativePath, redactor);
  // Deny check runs before any existence probe so a denied path is never distinguishable by status.
  if (pathIsDenied(relativePath)) {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
  const name = pathPosix.basename(relativePath);
  assertSafeLeafName(name);
  const realParent = await resolveContainedParentDir(
    root.realRoot,
    pathPosix.dirname(relativePath),
  );
  const targetNative = join(realParent, name);
  if (!isContained(root.realRoot, targetNative)) {
    throw new FilesError(403, "PATH_ESCAPE", "The destination is outside the selected root.");
  }
  const targetRel = rootRelativePosixPath(root.realRoot, targetNative);
  assertMetadataSafe(targetRel, redactor);
  if (pathIsDenied(targetRel)) {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
  return { root: root.root, realRoot: root.realRoot, relativePath: targetRel, path: targetNative };
}

async function assertCreationParentStillContained(target: ResolvedCreationTarget): Promise<void> {
  const parent = dirname(target.path);
  let realParent: string;
  try {
    realParent = await realpath(parent);
  } catch {
    throw stalePathError();
  }
  if (!sameNativePath(realParent, parent) || !isContained(target.realRoot, realParent)) {
    throw new FilesError(403, "PATH_ESCAPE", "The destination is outside the selected root.");
  }
  const relativeParent = rootRelativePosixPath(target.realRoot, realParent);
  if (relativeParent.length > 0 && pathIsDenied(relativeParent)) {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
}

async function assertResolvedTargetStillCurrent(target: ResolvedTarget): Promise<Stats> {
  let current: Stats;
  try {
    current = await lstat(target.path);
  } catch {
    throw stalePathError();
  }
  if (current.isSymbolicLink() || !sameFileIdentity(target.stats, current)) {
    throw stalePathError();
  }
  if (!isContained(target.realRoot, target.path)) {
    throw new FilesError(403, "PATH_ESCAPE", "The requested path is outside the selected root.");
  }
  return current;
}

function assertCreatedEntryKind(current: Stats, kind: FilesEntryKind): void {
  if (current.isSymbolicLink()) {
    throw new FilesError(400, "UNSUPPORTED", "Symbolic links cannot be created here.");
  }
  if (kind === "file" && !current.isFile()) {
    throw new FilesError(400, "BAD_REQUEST", "The mutation did not create a file.");
  }
  if (kind === "directory" && !current.isDirectory()) {
    throw new FilesError(400, "BAD_REQUEST", "The mutation did not create a directory.");
  }
}

async function realpathOrStale(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw stalePathError();
  }
}

function assertMutationRealPathContained(target: ResolvedCreationTarget, realTarget: string): void {
  if (!isContained(target.realRoot, realTarget)) {
    throw new FilesError(403, "PATH_ESCAPE", "The mutation escaped the selected root.");
  }
  const relativeReal = rootRelativePosixPath(target.realRoot, realTarget);
  if (relativeReal.length > 0 && pathIsDenied(relativeReal)) {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
}

async function assertMutationEffectContained(
  target: ResolvedCreationTarget,
  kind: FilesEntryKind,
): Promise<void> {
  let current: Stats;
  try {
    current = await lstat(target.path);
  } catch {
    throw stalePathError();
  }
  assertCreatedEntryKind(current, kind);
  assertMutationRealPathContained(target, await realpathOrStale(target.path));
}

async function assertCopiedTreeContainsNoSymlinks(
  realRoot: string,
  absolutePath: string,
): Promise<void> {
  const current = await lstat(absolutePath);
  if (current.isSymbolicLink()) {
    throw new FilesError(400, "UNSUPPORTED", "Symbolic links cannot be copied here.");
  }
  const realCurrent = await realpath(absolutePath);
  if (!isContained(realRoot, realCurrent)) {
    throw new FilesError(403, "PATH_ESCAPE", "The copied entry escaped the selected root.");
  }
  const relativeReal = rootRelativePosixPath(realRoot, realCurrent);
  if (relativeReal.length > 0 && pathIsDenied(relativeReal)) {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
  if (!current.isDirectory()) return;
  const dir = await opendir(absolutePath);
  for await (const entry of dir) {
    await assertCopiedTreeContainsNoSymlinks(realRoot, join(absolutePath, entry.name));
  }
}

const NOFOLLOW_WRITE_FLAG = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

async function writeExistingResolvedFile(target: ResolvedTarget, content: string): Promise<Stats> {
  const tempPath = join(
    dirname(target.path),
    `.${basename(target.path)}.keiko-save.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await assertResolvedTargetStillCurrent(target);
    const mode = target.stats.mode & 0o777 || 0o666;
    handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW_WRITE_FLAG,
      mode,
    );
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertResolvedTargetStillCurrent(target);
    await rename(tempPath, target.path);
    await fsyncDirectory(dirname(target.path));
    const updated = await stat(target.path);
    if (!updated.isFile()) throw stalePathError();
    return updated;
  } catch (error) {
    if (error instanceof FilesError) throw error;
    throw mapNodeFsError(error);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function fsyncDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dir, constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Directory fsync is not supported by every filesystem. The temp file is still fsynced.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function createFilesEntry(args: {
  readonly store: UiStore;
  readonly rootInput: string | null;
  readonly pathInput: string | null;
  readonly kind: FilesEntryKind;
  readonly redactor?: FilesMetadataRedactor | undefined;
}): Promise<FilesMutationResponse> {
  if (args.kind !== "file" && args.kind !== "directory") {
    throw new FilesError(400, "BAD_REQUEST", "A new entry must be a file or a directory.");
  }
  const target = await resolveCreationTarget(
    args.store,
    args.rootInput,
    args.pathInput,
    args.redactor ?? staticFilesMetadataRedactor,
  );
  await assertCreationParentStillContained(target);
  try {
    if (args.kind === "directory") {
      // Non-recursive: the parent was already verified, and EEXIST surfaces as a clean 409.
      await mkdir(target.path);
    } else {
      // `wx` = O_CREAT | O_EXCL: atomically refuse to overwrite an existing entry AND refuse to
      // follow a final symlink, closing the create-time TOCTOU/symlink window.
      await writeFile(target.path, "", { flag: "wx" });
    }
  } catch (error) {
    throw mapNodeFsError(error);
  }
  return { root: target.root, path: target.relativePath, kind: args.kind };
}

// No-clobber guard for a rename. Refuses any pre-existing destination (lstat so a symlink there is
// detected too), with ONE exception: a pure case-only rename on a case-insensitive filesystem
// (macOS/Windows), where `lstat(newPath)` resolves to the SAME inode as the source — legitimate
// because it only changes the on-disk case. The exception is gated by realpath identity, never a raw
// string compare. rename() has no atomic no-overwrite flag in Node; containment + deny bound the
// residual TOCTOU window.
async function assertRenameDestinationFree(targetPath: string, sourcePath: string): Promise<void> {
  try {
    await lstat(targetPath);
  } catch {
    return; // destination does not exist — free to use
  }
  let resolved: string | null;
  try {
    resolved = await realpath(targetPath);
  } catch {
    resolved = null;
  }
  if (resolved !== sourcePath) {
    throw new FilesError(409, "ALREADY_EXISTS", "An entry with that name already exists.");
  }
}

interface RenameFilesEntryArgs {
  readonly store: UiStore;
  readonly rootInput: string | null;
  readonly pathInput: string | null;
  readonly newPathInput: string | null;
  // Issue 2.6: optional version-aware precondition. When supplied (only the editor/agent that read the
  // file holds it; the metadata-only tree does not), the rename is rejected with STALE_SESSION (409) if
  // the on-disk file changed since that revision — so a move never races a concurrent edit.
  readonly baseVersion?: EditorDocumentVersion | undefined;
  readonly redactor?: FilesMetadataRedactor | undefined;
}

interface RenameFilesPlan {
  readonly source: ResolvedTarget;
  readonly target: ResolvedCreationTarget;
  readonly kind: FilesEntryKind;
}

function assertRenameRelativePathAllowed(sourcePath: string, targetPath: string): void {
  if (targetPath === sourcePath) {
    throw new FilesError(409, "ALREADY_EXISTS", "The new name matches the current name.");
  }
  if (targetPath.startsWith(`${sourcePath}/`)) {
    throw new FilesError(400, "BAD_PATH", "A folder cannot be moved into itself.");
  }
}

async function resolveRenameFilesPlan(args: RenameFilesEntryArgs): Promise<RenameFilesPlan> {
  const redactor = args.redactor ?? staticFilesMetadataRedactor;
  const source = await resolveInsideRoot(args.store, args.rootInput, args.pathInput, redactor);
  if (source.relativePath.length === 0) {
    throw new FilesError(400, "BAD_PATH", "The root folder cannot be renamed.");
  }
  if (source.symlink) {
    throw new FilesError(400, "UNSUPPORTED", "Symbolic links cannot be renamed here.");
  }
  if (args.baseVersion !== undefined && source.stats.isFile()) {
    await assertSessionNotStale(source, args.baseVersion);
  }
  const kind: FilesEntryKind = source.stats.isDirectory() ? "directory" : "file";
  const target = await resolveCreationTarget(
    args.store,
    args.rootInput,
    args.newPathInput,
    redactor,
  );
  assertRenameRelativePathAllowed(source.relativePath, target.relativePath);
  await assertRenameDestinationFree(target.path, source.path);
  await assertResolvedTargetStillCurrent(source);
  await assertCreationParentStillContained(target);
  return { source, target, kind };
}

async function executeContainedRename(
  source: ResolvedTarget,
  target: ResolvedCreationTarget,
  kind: FilesEntryKind,
): Promise<void> {
  try {
    await rename(source.path, target.path);
    try {
      await assertMutationEffectContained(target, kind);
    } catch (error) {
      await rename(target.path, source.path).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (error instanceof FilesError) throw error;
    throw mapNodeFsError(error);
  }
}

export async function renameFilesEntry(args: RenameFilesEntryArgs): Promise<FilesMutationResponse> {
  const { source, target, kind } = await resolveRenameFilesPlan(args);
  await executeContainedRename(source, target, kind);
  return {
    root: target.root,
    path: target.relativePath,
    previousPath: source.relativePath,
    kind,
  };
}

export async function deleteFilesEntry(args: {
  readonly store: UiStore;
  readonly rootInput: string | null;
  readonly pathInput: string | null;
  // Issue 2.6: optional version-aware precondition (see renameFilesEntry) — rejects the delete with
  // STALE_SESSION (409) if the on-disk file changed since this revision.
  readonly baseVersion?: EditorDocumentVersion | undefined;
  readonly redactor?: FilesMetadataRedactor | undefined;
}): Promise<FilesMutationResponse> {
  const target = await resolveInsideRoot(
    args.store,
    args.rootInput,
    args.pathInput,
    args.redactor ?? staticFilesMetadataRedactor,
  );
  if (target.relativePath.length === 0) {
    throw new FilesError(400, "BAD_PATH", "The root folder cannot be deleted.");
  }
  if (target.symlink) {
    throw new FilesError(400, "UNSUPPORTED", "Symbolic links cannot be deleted here.");
  }
  if (args.baseVersion !== undefined && target.stats.isFile()) {
    await assertSessionNotStale(target, args.baseVersion);
  }
  const kind: FilesEntryKind = target.stats.isDirectory() ? "directory" : "file";
  await assertResolvedTargetStillCurrent(target);
  // `recursive` removes a non-empty folder, matching editor expectations. Containment + the deny-list
  // bound the blast radius to inside the selected root and away from .git/node_modules/secrets, and
  // symlinks are rejected above so `rm` never recurses THROUGH a link out of the root.
  try {
    await rm(target.path, { recursive: kind === "directory", force: false });
  } catch (error) {
    throw mapNodeFsError(error);
  }
  return { root: target.root, path: target.relativePath, kind };
}

// eslint-disable-next-line max-lines-per-function -- copy containment checks are kept adjacent to the filesystem mutation.
export async function copyFilesEntry(args: {
  readonly store: UiStore;
  readonly rootInput: string | null;
  readonly sourcePathInput: string | null;
  readonly destPathInput: string | null;
  readonly redactor?: FilesMetadataRedactor | undefined;
}): Promise<FilesMutationResponse> {
  const redactor = args.redactor ?? staticFilesMetadataRedactor;
  // Source must exist, be contained, and not be denied or a symlink (we never dereference one).
  const source = await resolveInsideRoot(
    args.store,
    args.rootInput,
    args.sourcePathInput,
    redactor,
  );
  if (source.relativePath.length === 0) {
    throw new FilesError(400, "BAD_PATH", "The root folder cannot be copied.");
  }
  if (source.symlink) {
    throw new FilesError(400, "UNSUPPORTED", "Symbolic links cannot be copied here.");
  }
  const kind: FilesEntryKind = source.stats.isDirectory() ? "directory" : "file";
  // Destination resolves like a create target: parent must exist + be contained + non-denied.
  const target = await resolveCreationTarget(
    args.store,
    args.rootInput,
    args.destPathInput,
    redactor,
  );
  if (
    target.relativePath === source.relativePath ||
    target.relativePath.startsWith(`${source.relativePath}/`)
  ) {
    throw new FilesError(400, "BAD_PATH", "A folder cannot be copied into itself.");
  }
  await assertResolvedTargetStillCurrent(source);
  await assertCreationParentStillContained(target);
  try {
    // `force:false` + `errorOnExist` refuse to overwrite; `dereference:false` copies symlinks as
    // links (never follows one out of the root). Contents stay inside the root throughout.
    await cp(source.path, target.path, {
      recursive: kind === "directory",
      force: false,
      errorOnExist: true,
      dereference: false,
    });
    try {
      await assertMutationEffectContained(target, kind);
      await assertCopiedTreeContainsNoSymlinks(target.realRoot, target.path);
    } catch (error) {
      await rm(target.path, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (error instanceof FilesError) throw error;
    throw mapNodeFsError(error);
  }
  return {
    root: target.root,
    path: target.relativePath,
    previousPath: source.relativePath,
    kind,
  };
}

export async function readFilesPreview(
  store: UiStore,
  rootInput: string | null,
  pathInput: string | null,
  redactor: FilesMetadataRedactor = staticFilesMetadataRedactor,
): Promise<FilesPreviewResponse> {
  const target = await resolveInsideRoot(store, rootInput, pathInput, redactor);
  if (!target.stats.isFile()) {
    throw new FilesError(400, "NOT_FILE", "The requested path is not a file.");
  }
  const base = basePreview(target);
  if (isImageExtension(base.extension)) return imagePreview(target, base);
  const prefix = await readPrefix(target.path, Math.min(target.stats.size, 4096));
  if (isEditableUtf8File(base.extension, prefix.buffer)) {
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
    return {
      status: 200,
      body: await listFilesDirectories(deps.store, requestedRoot, requestedPath, deps.redactor),
    };
  });
}

export async function handleFilesTree(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runFilesHandler(async () => ({
    status: 200,
    body: await readFilesTree(
      deps.store,
      ctx.url.searchParams.get("root"),
      ctx.url.searchParams.get("path"),
      deps.redactor,
    ),
  }));
}

export async function handleFilesSearch(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runFilesHandler(async () => ({
    status: 200,
    body: await searchFiles(
      deps.store,
      ctx.url.searchParams.get("root"),
      ctx.url.searchParams.get("q") ?? ctx.url.searchParams.get("query"),
      parseSearchLimit(ctx.url.searchParams.get("limit")),
      deps.redactor,
    ),
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

export async function handleFilesPreviewImage(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<HandlerOutcome> {
  try {
    const target = await resolveInsideRoot(
      deps.store,
      ctx.url.searchParams.get("root"),
      ctx.url.searchParams.get("path"),
      deps.redactor,
    );
    if (!target.stats.isFile()) {
      throw new FilesError(400, "NOT_FILE", "The requested path is not a file.");
    }
    const base = basePreview(target);
    if (!isImageExtension(base.extension)) {
      throw new FilesError(400, "UNSUPPORTED", "The requested file is not an image preview.");
    }
    if (target.stats.size > MAX_IMAGE_PREVIEW_BYTES) {
      throw new FilesError(413, "PAYLOAD_TOO_LARGE", "The image exceeds the preview size limit.");
    }
    ctx.res.writeHead(200, {
      "Content-Type": base.mime,
      "Content-Length": String(target.stats.size),
      "Cache-Control": "private, max-age=60",
    });
    const stream = createReadStream(target.path);
    stream.on("error", () => {
      ctx.res.destroy();
    });
    stream.pipe(ctx.res);
    return STREAMING;
  } catch (error) {
    if (error instanceof FilesError) return filesErrorResult(error);
    throw error;
  }
}

interface FilesWriteFields {
  readonly rootInput: string;
  readonly pathInput: string;
  readonly content: string;
}

function readFilesWriteFields(body: Record<string, unknown>): FilesWriteFields | null {
  const rootInput = typeof body.root === "string" ? body.root : null;
  const pathInput = typeof body.path === "string" ? body.path : null;
  const content = body.content;
  if (rootInput === null || pathInput === null || typeof content !== "string") {
    return null;
  }
  return { rootInput, pathInput, content };
}

async function readFilesContentRoute(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  return {
    status: 200,
    body: await readFilesContent(
      deps.store,
      ctx.url.searchParams.get("root"),
      ctx.url.searchParams.get("path"),
      deps.redactor,
    ),
  };
}

async function writeFilesContentRoute(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_TEXT_PREVIEW_BYTES * 2 + 16_384);
  if (isRouteResult(body)) return body;
  const fields = readFilesWriteFields(body);
  if (fields === null) {
    const message = "root, path, and content are required for a file save request.";
    return { status: 400, body: errorBody("BAD_REQUEST", message) };
  }
  const target = await resolveInsideRoot(
    deps.store,
    fields.rootInput,
    fields.pathInput,
    deps.redactor,
  );
  let baseVersion: EditorDocumentVersion | undefined;
  if (body.baseVersion !== undefined) {
    const parsed = parseEditorDocumentVersion(body.baseVersion);
    if (!parsed.ok) {
      return { status: 400, body: errorBody("BAD_REQUEST", "baseVersion is not a valid version.") };
    }
    baseVersion = parsed.value;
  }
  return {
    status: 200,
    body: await writeResolvedFilesContent({
      target,
      content: fields.content,
      expectedModifiedAt:
        typeof body.expectedModifiedAt === "number" ? body.expectedModifiedAt : undefined,
      baseVersion,
    }),
  };
}

export async function handleFilesContent(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runFilesHandler(async () =>
    (ctx.req.method ?? "GET").toUpperCase() === "GET"
      ? readFilesContentRoute(ctx, deps)
      : writeFilesContentRoute(ctx, deps),
  );
}

// Bounded body for a mutation request: a path plus a few short fields, never file content.
const MAX_FILES_MUTATION_BODY_BYTES = 16_384;

export async function handleFilesCreate(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runFilesHandler(async () => {
    const body = await readJsonObject(ctx.req, MAX_FILES_MUTATION_BODY_BYTES);
    if (isRouteResult(body)) return body;
    const rootInput = typeof body.root === "string" ? body.root : null;
    const pathInput = typeof body.path === "string" ? body.path : null;
    const kind = body.kind === "directory" ? "directory" : body.kind === "file" ? "file" : null;
    if (rootInput === null || pathInput === null || kind === null) {
      return {
        status: 400,
        body: errorBody(
          "BAD_REQUEST",
          "root, path, and kind ('file' or 'directory') are required to create an entry.",
        ),
      };
    }
    return {
      status: 201,
      body: await createFilesEntry({
        store: deps.store,
        rootInput,
        pathInput,
        kind,
        redactor: deps.redactor,
      }),
    };
  });
}

// Parse an optional `baseVersion` from a mutation body: undefined when absent, the parsed version when
// valid, or a 400 RouteResult when present-but-malformed (Issue 2.6).
function parseOptionalBaseVersion(
  body: Record<string, unknown>,
): { readonly version: EditorDocumentVersion | undefined } | RouteResult {
  if (body.baseVersion === undefined) return { version: undefined };
  const parsed = parseEditorDocumentVersion(body.baseVersion);
  if (!parsed.ok) {
    return { status: 400, body: errorBody("BAD_REQUEST", "baseVersion is not a valid version.") };
  }
  return { version: parsed.value };
}

export async function handleFilesRename(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runFilesHandler(async () => {
    const body = await readJsonObject(ctx.req, MAX_FILES_MUTATION_BODY_BYTES);
    if (isRouteResult(body)) return body;
    const rootInput = typeof body.root === "string" ? body.root : null;
    const pathInput = typeof body.path === "string" ? body.path : null;
    const newPathInput = typeof body.newPath === "string" ? body.newPath : null;
    if (rootInput === null || pathInput === null || newPathInput === null) {
      return {
        status: 400,
        body: errorBody("BAD_REQUEST", "root, path, and newPath are required to rename an entry."),
      };
    }
    const baseVersion = parseOptionalBaseVersion(body);
    if (isRouteResult(baseVersion)) return baseVersion;
    return {
      status: 200,
      body: await renameFilesEntry({
        store: deps.store,
        rootInput,
        pathInput,
        newPathInput,
        baseVersion: baseVersion.version,
        redactor: deps.redactor,
      }),
    };
  });
}

export async function handleFilesDelete(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runFilesHandler(async () => {
    const body = await readJsonObject(ctx.req, MAX_FILES_MUTATION_BODY_BYTES);
    if (isRouteResult(body)) return body;
    const rootInput = typeof body.root === "string" ? body.root : null;
    const pathInput = typeof body.path === "string" ? body.path : null;
    if (rootInput === null || pathInput === null) {
      return {
        status: 400,
        body: errorBody("BAD_REQUEST", "root and path are required to delete an entry."),
      };
    }
    const baseVersion = parseOptionalBaseVersion(body);
    if (isRouteResult(baseVersion)) return baseVersion;
    return {
      status: 200,
      body: await deleteFilesEntry({
        store: deps.store,
        rootInput,
        pathInput,
        baseVersion: baseVersion.version,
        redactor: deps.redactor,
      }),
    };
  });
}

export async function handleFilesCopy(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runFilesHandler(async () => {
    const body = await readJsonObject(ctx.req, MAX_FILES_MUTATION_BODY_BYTES);
    if (isRouteResult(body)) return body;
    const rootInput = typeof body.root === "string" ? body.root : null;
    const sourcePathInput = typeof body.sourcePath === "string" ? body.sourcePath : null;
    const destPathInput = typeof body.destPath === "string" ? body.destPath : null;
    if (rootInput === null || sourcePathInput === null || destPathInput === null) {
      return {
        status: 400,
        body: errorBody(
          "BAD_REQUEST",
          "root, sourcePath, and destPath are required to copy an entry.",
        ),
      };
    }
    return {
      status: 201,
      body: await copyFilesEntry({
        store: deps.store,
        rootInput,
        sourcePathInput,
        destPathInput,
        redactor: deps.redactor,
      }),
    };
  });
}
