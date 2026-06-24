// Read-only filesystem browser for the desktop Files widget. The browser receives
// preview or editor content; every request is contained inside a selected root after
// realpath resolution.

import type { IncomingMessage } from "node:http";
import type { Dirent, Stats } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, opendir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
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
import { DENIED_MESSAGE, pathIsDenied } from "./files-deny.js";
import { errorBody, type RouteContext, type RouteResult } from "./routes.js";
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
}

export interface FilesSearchResponse {
  readonly root: string;
  readonly query: string;
  readonly results: readonly FilesSearchResult[];
  readonly truncated: boolean;
  readonly scannedFileCount: number;
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

function skipEntry(rel: string): boolean {
  return pathIsDenied(rel);
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
  const entries: FilesTreeEntry[] = [];
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
      if (entries.length >= MAX_DIRECTORY_ENTRIES) {
        truncated = true;
        break;
      }
      entries.push(await classifyEntry(root, relativePath, pathValue, entry, redactor));
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
  scannedFileCount: number;
  scanTruncated: boolean;
}

function entryVisibleToFileSearch(
  relativePath: string,
  entry: Dirent,
  redactor: FilesMetadataRedactor,
): boolean {
  return (
    metadataIsSafe(relativePath, redactor) &&
    !pathIsDenied(relativePath) &&
    !entry.isSymbolicLink()
  );
}

async function addFileSearchCandidate(args: {
  readonly root: ResolvedProjectRoot;
  readonly query: string;
  readonly relativePath: string;
  readonly nativePath: string;
  readonly entryName: string;
  readonly tokens: readonly string[];
  readonly state: FileSearchState;
}): Promise<void> {
  if (!matchesSearch(args.relativePath, args.tokens)) return;
  let info: Stats;
  try {
    info = await lstat(args.nativePath);
  } catch {
    return;
  }
  args.state.candidates.push({
    score: fileSearchScore(args.relativePath, args.query),
    result: {
      root: args.root.root,
      path: args.relativePath,
      name: args.entryName,
      directory: directoryOf(args.relativePath),
      extension: extensionOf(args.entryName),
      sizeBytes: info.size,
      modifiedAt: info.mtimeMs,
    },
  });
}

async function collectFileSearchEntry(args: {
  readonly current: FileSearchStackEntry;
  readonly entry: Dirent;
  readonly root: ResolvedProjectRoot;
  readonly query: string;
  readonly tokens: readonly string[];
  readonly redactor: FilesMetadataRedactor;
  readonly state: FileSearchState;
}): Promise<void> {
  const relativePath = childRelative(args.current.relativePath, args.entry.name);
  if (!entryVisibleToFileSearch(relativePath, args.entry, args.redactor)) return;
  const nativePath = join(args.current.path, args.entry.name);
  if (args.entry.isDirectory()) {
    args.state.stack.push({ path: nativePath, relativePath });
    return;
  }
  if (!args.entry.isFile()) return;
  args.state.scannedFileCount += 1;
  if (args.state.scannedFileCount > MAX_FILE_SEARCH_SCAN) {
    args.state.scanTruncated = true;
    return;
  }
  await addFileSearchCandidate({
    root: args.root,
    query: args.query,
    relativePath,
    nativePath,
    entryName: args.entry.name,
    tokens: args.tokens,
    state: args.state,
  });
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
  try {
    for await (const entry of dir) {
      await collectFileSearchEntry({ ...args, entry });
      if (args.state.scanTruncated) break;
    }
  } finally {
    await dir.close().catch(() => undefined);
  }
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
    const content = await readFile(target.path, "utf8");
    const after = await stat(target.path);
    if (statsMatch(before, after)) return { content, stats: after };
    before = after;
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
    hashMatches =
      !current.truncated && sha256Hex(current.buffer.toString("utf8")) === baseVersion.contentHash;
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
  if (!isKnownTextExtension(base.extension) && !isLikelyUtf8Text(prefix.buffer)) {
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
  if (!isKnownTextExtension(base.extension) && !isLikelyUtf8Text(prefix.buffer)) {
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
  await writeFile(args.target.path, args.content, "utf8");
  const updatedStats = await stat(args.target.path);
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
