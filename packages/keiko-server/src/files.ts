// Read-only filesystem browser for the desktop Files widget. The browser receives
// preview or editor content; every request is contained inside a selected root after
// realpath resolution.

import type { IncomingMessage } from "node:http";
import { createWorkspaceMutexRegistry, fileWriteKey } from "./task-workspace/mutex.js";

// One registry per server process: same-process turn order for the verify→write region below
// (KEIKO-0495). It composes with, never replaces, the persisted advisory WorkspaceLock.
const fileWriteMutex = createWorkspaceMutexRegistry();
import type { Dirent, Stats } from "node:fs";
import { constants, createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
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
  posix as pathPosix,
  relative,
  resolve,
} from "node:path";
import { redact, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  EDITOR_SESSION_SCHEMA_VERSION,
  parseEditorDocumentVersion,
  type EditorDocumentSession,
  type EditorDocumentVersion,
} from "@oscharko-dev/keiko-contracts";
import type { FilesContentResponse as FilesContentWireResponse } from "@oscharko-dev/keiko-contracts/bff-wire";
import { containsPath } from "@oscharko-dev/keiko-git";
import { notifyHostLspWorkspaceFileChanged } from "./editor/lsp/hostLanguageOperation.js";
import { captureEditorLocalHistorySafely } from "./editor/localHistory/localHistoryCapture.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
import { DENIED_MESSAGE, pathIsDenied } from "./files-deny.js";
import {
  STREAMING,
  errorBody,
  type HandlerOutcome,
  type RouteContext,
  type RouteResult,
} from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import { resolveAppSessionReadAuthority } from "./coding-app-session/appSessionReadAuthority.js";
import type { Project, UiStore } from "./store/index.js";
import { resolveManagedTaskWorkspaceRoot } from "./task-workspace/authorization.js";

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

export type FilesContentResponse = FilesContentWireResponse;

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
/**
 * Where a workspace file BELONGS, whether or not it is there (#2616). It deliberately carries no
 * absolute path: the candidate was never realpathed, so it must not be handed out in a shape that
 * a realpathed one would also fit.
 */
export interface ContainedEditorFilePath {
  readonly realRoot: string;
  readonly relativePath: string;
}

export interface ResolvedProjectRoot {
  readonly root: string;
  readonly realRoot: string;
}

export interface ResolveRequestRootOptions {
  /**
   * The caller owns the managed-root response projection after canonical classification. Git uses
   * this to preserve ADR-0141 F5's content-free unavailable response instead of a Files 403.
   */
  readonly managedRootAuthority?: "authorize" | "defer-to-caller";
}

/**
 * Decides whether a candidate root may only be served under managed-workspace authority. Exported
 * so Git classifies identically to Files: two copies of this rule drifted once already (#2473), and
 * the divergence made the operator's own repository look unavailable while Files served it.
 */
export function requiresManagedRootAuthority(managedRoot: string, candidateRoot: string): boolean {
  if (containsPath(managedRoot, candidateRoot)) return true;
  if (!containsPath(candidateRoot, managedRoot)) return false;
  // Production state may live below the selected workspace only inside its already-denied `.keiko`
  // subtree. Keep that ancestor browsable while the Files deny layer excludes the complete managed
  // subtree from tree/search and rejects every direct target or mutation before filesystem access.
  return !pathIsDenied(rootRelativePosixPath(candidateRoot, managedRoot));
}

function requestedManagedRoot(deps: UiHandlerDeps, rootInput: string | null): boolean {
  const managedRoot = deps.managedTaskWorkspaceRoot;
  if (managedRoot === undefined || rootInput === null || !isAbsolute(rootInput)) return false;
  return requiresManagedRootAuthority(resolve(managedRoot), resolve(rootInput));
}

async function resolvesInsideManagedRoot(deps: UiHandlerDeps, realRoot: string): Promise<boolean> {
  const managedRoot = deps.managedTaskWorkspaceRoot;
  if (managedRoot === undefined) return false;
  try {
    const realManagedRoot = await realpath(managedRoot);
    return requiresManagedRootAuthority(realManagedRoot, realRoot);
  } catch {
    // This check separates ordinary roots from Keiko-owned managed worktrees. An unreadable or
    // missing managed root is therefore an unknown authorization state, never proof that the
    // candidate is outside it.
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
}

/**
 * Resolves a request-bound workspace root. Ordinary roots retain the Files surface's established
 * project/arbitrary-folder rules. A path inside Keiko's private managed-task-workspace root is
 * admitted only when a live launcher-paired app session is present and the persisted workspace
 * identity, derived path, ownership containment, and on-disk presence all agree.
 */
export async function resolveRequestRoot(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  rootInput: string | null,
  options: ResolveRequestRootOptions = {},
): Promise<ResolvedProjectRoot> {
  const deferManagedAuthority = options.managedRootAuthority === "defer-to-caller";
  if (!requestedManagedRoot(deps, rootInput)) {
    const root = await resolveRoot(deps.store, rootInput, deps.redactor);
    if (!(await resolvesInsideManagedRoot(deps, root.realRoot))) return root;
    if (deferManagedAuthority) return root;
    // An external symlink or registered-project alias must not turn a managed worktree into an
    // ordinary root. Only the canonical derived path can be re-proven against persisted identity.
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
  if (deferManagedAuthority) {
    const root = await resolveRoot(deps.store, rootInput, deps.redactor);
    if (!(await resolvesInsideManagedRoot(deps, root.realRoot))) {
      throw new FilesError(403, "DENIED", DENIED_MESSAGE);
    }
    return root;
  }
  if (resolveAppSessionReadAuthority(deps, ctx.req) === undefined) {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
  const workspace =
    rootInput === null ? undefined : resolveManagedTaskWorkspaceRoot(deps, rootInput);
  if (workspace === undefined) {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
  assertMetadataSafe(workspace.root, deps.redactor);
  const realRoot = await resolveDirectory(workspace.root);
  assertMetadataSafe(realRoot, deps.redactor);
  return { root: workspace.root, realRoot };
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

// Exported so callers outside this module (e.g. the native-file-dialog route, which mirrors
// `resolveArbitraryRoot`'s chain for FILE targets) reuse the exact same "no-op redaction = safe"
// invariant instead of re-deriving it.
export function metadataIsSafe(value: string, redactor: FilesMetadataRedactor): boolean {
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

export function normalizeRelativePath(pathInput: unknown): string {
  if (pathInput === null) return "";
  if (typeof pathInput !== "string") {
    throw new FilesError(400, "BAD_PATH", "The path must be a string or null.");
  }
  const raw = pathInput;
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

async function resolveInsideRoot(
  store: UiStore,
  rootInput: string | null,
  pathInput: string | null,
  redactor: FilesMetadataRedactor,
  resolvedRoot?: ResolvedProjectRoot,
): Promise<ResolvedTarget> {
  const root = resolvedRoot ?? (await resolveRoot(store, rootInput, redactor));
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
    const leafKind: FilesEntryKind = targetStats.isFile() ? "file" : "symlink";
    const kind: FilesEntryKind = targetStats.isDirectory() ? "directory" : leafKind;
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
  resolvedRoot?: ResolvedProjectRoot,
): Promise<FilesTreeResponse> {
  const target = await resolveInsideRoot(store, rootInput, pathInput, redactor, resolvedRoot);
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

function settleNearestGitRoot(
  visited: readonly string[],
  cache: Map<string, string | null>,
  result: string | null,
): string | null {
  for (const directory of visited) cache.set(directory, result);
  return result;
}

async function nearestGitRoot(
  startDirectory: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  let current = resolve(startDirectory);
  const visited: string[] = [];
  for (;;) {
    const cached = cache.get(current);
    if (cached !== undefined) return settleNearestGitRoot(visited, cache, cached);
    visited.push(current);
    if (await hasGitMarker(current)) return settleNearestGitRoot(visited, cache, current);
    const parent = dirname(current);
    if (parent === current) return settleNearestGitRoot(visited, cache, null);
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
  resolvedRoot?: ResolvedProjectRoot,
): Promise<FilesSearchResponse> {
  const root = resolvedRoot ?? (await resolveRoot(store, rootInput, redactor));
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
    const code = char.codePointAt(0) ?? 0;
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
  resolvedRoot?: ResolvedProjectRoot,
): Promise<FilesContentResponse> {
  const target = await resolveInsideRoot(store, rootInput, pathInput, redactor, resolvedRoot);
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

/**
 * Containment for a workspace-relative path that does NOT require the file to be there (#2616).
 *
 * The route path this replaced realpathed the candidate and 404d when it was gone — correct for a
 * read of live bytes, wrong for a record ABOUT a file. Local history's whole purpose is surviving
 * the file: recovering a deleted or renamed one is the case that matters most, and re-resolving the
 * stored path against the live filesystem is exactly what denied it.
 *
 * The guards that do not depend on existence still run in full: normalization (absolute, NUL, `..`
 * escape), metadata redaction, and the deny list — on the relative path, and again on the deepest
 * part of the path that still resolves, so a path that has since become a symlink out of the root
 * stays denied whether or not its leaf survived.
 *
 * It deliberately returns no absolute path. A caller that wants bytes must resolve them itself
 * through a live read; handing back an unresolved candidate under the same shape a realpathed
 * identity uses is how a symlink out of the root would eventually get written through.
 */
export async function resolveContainedEditorFilePath(
  store: UiStore,
  rootInput: string | null,
  pathInput: string | null,
  redactor: FilesMetadataRedactor = staticFilesMetadataRedactor,
): Promise<ContainedEditorFilePath> {
  const root = await resolveRoot(store, rootInput, redactor);
  const relativePath = normalizeRelativePath(pathInput);
  assertMetadataSafe(relativePath, redactor);
  if (relativePath.length === 0) {
    throw new FilesError(400, "BAD_PATH", "The path must be relative to the selected root.");
  }
  if (pathIsDenied(relativePath)) {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
  const candidate = nativePath(root.realRoot, relativePath);
  if (!isContained(root.realRoot, candidate)) {
    throw new FilesError(403, "PATH_ESCAPE", "The requested path is outside the selected root.");
  }
  await assertResolvedPathContained(root.realRoot, candidate, redactor);
  return { realRoot: root.realRoot, relativePath };
}

/**
 * Holds the deepest existing part of the candidate to the realpath containment a live read gets.
 *
 * Resolving only the leaf is not enough: `realpath` fails on a missing leaf, so a dangling entry
 * under a directory symlinked OUT of the root would skip every check below. Walking up to the first
 * segment that does resolve means an escaping ancestor is caught even when nothing exists at the
 * requested path.
 */
async function assertResolvedPathContained(
  realRoot: string,
  candidate: string,
  redactor: FilesMetadataRedactor,
): Promise<void> {
  let current = candidate;
  while (isContained(realRoot, current)) {
    const resolved = await resolvedIfPresent(current);
    if (resolved === undefined) {
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
      continue;
    }
    if (!isContained(realRoot, resolved)) {
      throw new FilesError(403, "PATH_ESCAPE", "The requested path is outside the selected root.");
    }
    const resolvedRelativePath = rootRelativePosixPath(realRoot, resolved);
    assertMetadataSafe(resolvedRelativePath, redactor);
    if (pathIsDenied(resolvedRelativePath)) {
      throw new FilesError(403, "DENIED", DENIED_MESSAGE);
    }
    return;
  }
  // The walk ran past the root without resolving anything, so containment was never actually
  // verified. Absence of proof is not proof of containment: refuse.
  throw new FilesError(403, "DENIED", DENIED_MESSAGE);
}

// `undefined` means the path is definitively NOT THERE — the only condition under which walking to
// the parent is sound. Every other failure (EACCES, EPERM, ELOOP, EIO) means the answer could not
// be obtained, and a guard that cannot obtain an answer must not supply a permissive one.
async function resolvedIfPresent(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
}

// The serialized verify->write critical section (KEIKO-0495). Extracted so
// writeResolvedFilesContent stays within its function-length bound.
async function verifyThenWrite(args: {
  readonly target: ResolvedTarget;
  readonly content: string;
  readonly expectedModifiedAt?: number | undefined;
  readonly baseVersion?: EditorDocumentVersion | undefined;
  readonly beforeWrite?:
    | ((content: string) => NonNullable<FilesContentWireResponse["localHistoryProtection"]>)
    | undefined;
}): Promise<{
  readonly localHistoryProtection: FilesContentWireResponse["localHistoryProtection"];
  readonly updatedStats: Stats;
}> {
  // Re-stat INSIDE the lock. `args.target.stats` was captured before queuing, so a queued
  // request would otherwise re-run the conflict check against its own pre-lock snapshot and
  // never see the winner's write — surfacing an unrelated STALE_PATH from the rename guard
  // instead of the STALE_SESSION / WRITE_CONFLICT this check exists to report.
  // A delete or rename between resolveInsideRoot() and this in-lock stat rejects with a raw
  // ENOENT. runFilesHandler only translates FilesError, so without this it would surface as an
  // opaque 500 instead of the 409 STALE_PATH that writeExistingResolvedFile already produces
  // for exactly this race.
  let refreshedStats;
  try {
    refreshedStats = await stat(args.target.path);
  } catch {
    throw stalePathError();
  }
  const refreshed: ResolvedTarget = { ...args.target, stats: refreshedStats };
  await assertNoWriteConflict(refreshed, args.baseVersion, args.expectedModifiedAt);
  let protection: FilesContentWireResponse["localHistoryProtection"];
  if (args.beforeWrite !== undefined) {
    const current = await readStableEditableContent(args.target);
    protection = args.beforeWrite(current.content);
  }
  return {
    localHistoryProtection: protection,
    updatedStats: await writeExistingResolvedFile(args.target, args.content),
  };
}

async function writeResolvedFilesContent(args: {
  readonly target: ResolvedTarget;
  readonly content: string;
  readonly expectedModifiedAt?: number | undefined;
  readonly baseVersion?: EditorDocumentVersion | undefined;
  readonly beforeWrite?:
    | ((content: string) => NonNullable<FilesContentWireResponse["localHistoryProtection"]>)
    | undefined;
}): Promise<FilesContentResponse> {
  if (!args.target.stats.isFile()) {
    throw new FilesError(400, "NOT_FILE", "The requested path is not a file.");
  }
  const base = basePreview(args.target);
  const prefix = await readPrefix(args.target.path, Math.min(args.target.stats.size, 4096));
  if (!isEditableUtf8File(base.extension, prefix.buffer)) {
    throw new FilesError(400, "UNSUPPORTED_FILE", "This file cannot be edited in the workspace.");
  }
  if (Buffer.byteLength(args.content, "utf8") > MAX_TEXT_PREVIEW_BYTES) {
    throw new FilesError(
      413,
      "FILE_TOO_LARGE",
      `This file is too large to edit here (limit ${String(MAX_TEXT_PREVIEW_BYTES)} bytes).`,
    );
  }
  // KEIKO-0495: verify-then-write is a check-then-act. Two saves carrying the same baseVersion
  // could both clear assertNoWriteConflict and the second would silently overwrite the first, with
  // no STALE_SESSION for the loser. Serialising the whole verify→write region per file makes the
  // loser re-verify against the winner's result and fail closed as it should. This REUSES the
  // shared WorkspaceMutexRegistry rather than introducing a second locking mechanism; the existing
  // conflict checks are untouched and still do the deciding.
  const { localHistoryProtection, updatedStats } = await fileWriteMutex.runExclusive(
    [fileWriteKey(args.target.path)],
    () => verifyThenWrite(args),
  );
  return {
    ...base,
    sizeBytes: updatedStats.size,
    modifiedAt: updatedStats.mtimeMs,
    content: args.content,
    maxBytes: MAX_TEXT_PREVIEW_BYTES,
    session: editorSession(documentVersion(args.content, updatedStats)),
    ...(localHistoryProtection === undefined ? {} : { localHistoryProtection }),
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
  readonly resolvedRoot?: ResolvedProjectRoot | undefined;
}): Promise<FilesContentResponse> {
  const target = await resolveInsideRoot(
    args.store,
    args.rootInput,
    args.pathInput,
    args.redactor ?? staticFilesMetadataRedactor,
    args.resolvedRoot,
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
  resolvedRoot?: ResolvedProjectRoot,
): Promise<ResolvedCreationTarget> {
  const root = resolvedRoot ?? (await resolveRoot(store, rootInput, redactor));
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
  readonly resolvedRoot?: ResolvedProjectRoot | undefined;
}): Promise<FilesMutationResponse> {
  if (args.kind !== "file" && args.kind !== "directory") {
    throw new FilesError(400, "BAD_REQUEST", "A new entry must be a file or a directory.");
  }
  const target = await resolveCreationTarget(
    args.store,
    args.rootInput,
    args.pathInput,
    args.redactor ?? staticFilesMetadataRedactor,
    args.resolvedRoot,
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
  notifyHostLspWorkspaceFileChanged(target.realRoot, target.path, 1);
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
  readonly resolvedRoot?: ResolvedProjectRoot | undefined;
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
  const source = await resolveInsideRoot(
    args.store,
    args.rootInput,
    args.pathInput,
    redactor,
    args.resolvedRoot,
  );
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
    args.resolvedRoot,
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
  // LSP spec pair for a rename: the old path is Deleted, the new path is Created.
  notifyHostLspWorkspaceFileChanged(source.realRoot, source.path, 3);
  notifyHostLspWorkspaceFileChanged(target.realRoot, target.path, 1);
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
  readonly resolvedRoot?: ResolvedProjectRoot | undefined;
}): Promise<FilesMutationResponse> {
  const target = await resolveInsideRoot(
    args.store,
    args.rootInput,
    args.pathInput,
    args.redactor ?? staticFilesMetadataRedactor,
    args.resolvedRoot,
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
  notifyHostLspWorkspaceFileChanged(target.realRoot, target.path, 3);
  return { root: target.root, path: target.relativePath, kind };
}

// eslint-disable-next-line max-lines-per-function -- copy containment checks are kept adjacent to the filesystem mutation.
export async function copyFilesEntry(args: {
  readonly store: UiStore;
  readonly rootInput: string | null;
  readonly sourcePathInput: string | null;
  readonly destPathInput: string | null;
  readonly redactor?: FilesMetadataRedactor | undefined;
  readonly resolvedRoot?: ResolvedProjectRoot | undefined;
}): Promise<FilesMutationResponse> {
  const redactor = args.redactor ?? staticFilesMetadataRedactor;
  // Source must exist, be contained, and not be denied or a symlink (we never dereference one).
  const source = await resolveInsideRoot(
    args.store,
    args.rootInput,
    args.sourcePathInput,
    redactor,
    args.resolvedRoot,
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
    args.resolvedRoot,
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
  // The copy created a new watched file at the destination; the source is untouched and needs no
  // event (mirrors renameFilesEntry's Deleted+Created pair, minus the Deleted half a copy never has).
  notifyHostLspWorkspaceFileChanged(target.realRoot, target.path, 1);
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
  resolvedRoot?: ResolvedProjectRoot,
): Promise<FilesPreviewResponse> {
  const target = await resolveInsideRoot(store, rootInput, pathInput, redactor, resolvedRoot);
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

export async function handleFilesTree(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runFilesHandler(async () => {
    const rootInput = ctx.url.searchParams.get("root");
    const resolvedRoot = await resolveRequestRoot(ctx, deps, rootInput);
    return {
      status: 200,
      body: await readFilesTree(
        deps.store,
        rootInput,
        ctx.url.searchParams.get("path"),
        deps.redactor,
        resolvedRoot,
      ),
    };
  });
}

export async function handleFilesSearch(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runFilesHandler(async () => {
    const rootInput = ctx.url.searchParams.get("root");
    const resolvedRoot = await resolveRequestRoot(ctx, deps, rootInput);
    return {
      status: 200,
      body: await searchFiles(
        deps.store,
        rootInput,
        ctx.url.searchParams.get("q") ?? ctx.url.searchParams.get("query"),
        parseSearchLimit(ctx.url.searchParams.get("limit")),
        deps.redactor,
        resolvedRoot,
      ),
    };
  });
}

export async function handleFilesPreview(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runFilesHandler(async () => {
    const rootInput = ctx.url.searchParams.get("root");
    const resolvedRoot = await resolveRequestRoot(ctx, deps, rootInput);
    return {
      status: 200,
      body: await readFilesPreview(
        deps.store,
        rootInput,
        ctx.url.searchParams.get("path"),
        deps.redactor,
        resolvedRoot,
      ),
    };
  });
}

export async function handleFilesPreviewImage(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<HandlerOutcome> {
  try {
    const rootInput = ctx.url.searchParams.get("root");
    const resolvedRoot = await resolveRequestRoot(ctx, deps, rootInput);
    const target = await resolveInsideRoot(
      deps.store,
      rootInput,
      ctx.url.searchParams.get("path"),
      deps.redactor,
      resolvedRoot,
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
  readonly historyOrigin?: "pre-restore" | undefined;
}

function readFilesWriteFields(body: Record<string, unknown>): FilesWriteFields | null {
  const rootInput = typeof body.root === "string" ? body.root : null;
  const pathInput = typeof body.path === "string" ? body.path : null;
  const content = body.content;
  if (rootInput === null || pathInput === null || typeof content !== "string") {
    return null;
  }
  if (body.historyOrigin !== undefined && body.historyOrigin !== "pre-restore") return null;
  return {
    rootInput,
    pathInput,
    content,
    ...(body.historyOrigin === "pre-restore" ? { historyOrigin: body.historyOrigin } : {}),
  };
}

async function readFilesContentRoute(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  const rootInput = ctx.url.searchParams.get("root");
  const resolvedRoot = await resolveRequestRoot(ctx, deps, rootInput);
  return {
    status: 200,
    body: await readFilesContent(
      deps.store,
      rootInput,
      ctx.url.searchParams.get("path"),
      deps.redactor,
      resolvedRoot,
    ),
  };
}

function createPreRestoreCapture(
  deps: UiHandlerDeps,
  target: ResolvedTarget,
): (content: string) => NonNullable<FilesContentWireResponse["localHistoryProtection"]> {
  return (content) =>
    captureEditorLocalHistorySafely({
      deps,
      realRoot: target.realRoot,
      relativePath: target.relativePath,
      absolutePath: target.path,
      content,
      origin: "pre-restore",
    });
}

function captureNormalFileSave(
  deps: UiHandlerDeps,
  target: ResolvedTarget,
  fields: FilesWriteFields,
): FilesContentWireResponse["localHistoryProtection"] {
  if (fields.historyOrigin !== undefined) return undefined;
  return captureEditorLocalHistorySafely({
    deps,
    realRoot: target.realRoot,
    relativePath: target.relativePath,
    absolutePath: target.path,
    content: fields.content,
    origin: "user-save",
  });
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
  const resolvedRoot = await resolveRequestRoot(ctx, deps, fields.rootInput);
  const target = await resolveInsideRoot(
    deps.store,
    fields.rootInput,
    fields.pathInput,
    deps.redactor,
    resolvedRoot,
  );
  let baseVersion: EditorDocumentVersion | undefined;
  if (body.baseVersion !== undefined) {
    const parsed = parseEditorDocumentVersion(body.baseVersion);
    if (!parsed.ok) {
      return { status: 400, body: errorBody("BAD_REQUEST", "baseVersion is not a valid version.") };
    }
    baseVersion = parsed.value;
  }
  const response = await writeResolvedFilesContent({
    target,
    content: fields.content,
    expectedModifiedAt:
      typeof body.expectedModifiedAt === "number" ? body.expectedModifiedAt : undefined,
    baseVersion,
    beforeWrite:
      fields.historyOrigin === "pre-restore" ? createPreRestoreCapture(deps, target) : undefined,
  });
  notifyHostLspWorkspaceFileChanged(target.realRoot, target.path);
  const localHistoryProtection = captureNormalFileSave(deps, target, fields);
  return {
    status: 200,
    body: localHistoryProtection === undefined ? response : { ...response, localHistoryProtection },
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
    const kind = body.kind === "file" || body.kind === "directory" ? body.kind : null;
    if (rootInput === null || pathInput === null || kind === null) {
      return {
        status: 400,
        body: errorBody(
          "BAD_REQUEST",
          "root, path, and kind ('file' or 'directory') are required to create an entry.",
        ),
      };
    }
    const resolvedRoot = await resolveRequestRoot(ctx, deps, rootInput);
    return {
      status: 201,
      body: await createFilesEntry({
        store: deps.store,
        rootInput,
        pathInput,
        kind,
        redactor: deps.redactor,
        resolvedRoot,
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

// KEIKO-0179: maps one renamed breakpoint fileId (the exact source path, or a path inside a renamed
// directory) to its post-rename fileId. `undefined` means this fileId is unaffected by the rename.
function renamedBreakpointFileId(
  fileId: string,
  previousPath: string,
  nextPath: string,
): string | undefined {
  if (fileId === previousPath) return nextPath;
  if (fileId.startsWith(`${previousPath}/`))
    return `${nextPath}${fileId.slice(previousPath.length)}`;
  return undefined;
}

type DapDebugService = NonNullable<UiHandlerDeps["dapDebug"]>;

// KEIKO-0179: computes the affected-fileId pairs for a successful rename -- one entry per distinct
// fileId currently filed under the old path (the exact source path, or a path inside a renamed
// directory), never a blind string-prefix rewrite, so each destination fileId is validated on its
// own by whatever consumes the list.
function affectedRenamedFileIds(
  snapshot: Extract<ReturnType<DapDebugService["breakpoints"]["snapshot"]>, { readonly ok: true }>,
  previousPath: string,
  nextPath: string,
): readonly { readonly previousFileId: string; readonly nextFileId: string }[] {
  const seen = new Set<string>();
  const renames: { readonly previousFileId: string; readonly nextFileId: string }[] = [];
  for (const entry of snapshot.snapshot.breakpoints) {
    if (seen.has(entry.fileId)) continue;
    const nextFileId = renamedBreakpointFileId(entry.fileId, previousPath, nextPath);
    if (nextFileId === undefined) continue;
    seen.add(entry.fileId);
    renames.push({ previousFileId: entry.fileId, nextFileId });
  }
  return renames;
}

// KEIKO-0179 follow-up (Codex P1, twice-raised on PR #3141): fans out a successful rename to the DAP
// breakpoint store AND, when a debug session is live, the adapter itself -- both now live in
// dapDebugRoutes.ts's DapDebugRouteService.renameInstrumentation, the layer that already owns the
// reconciliation helpers a normal breakpoint mutation runs through. files.ts only computes which
// fileIds are affected and delegates once; it never re-keys the store or touches the adapter
// directly. Deliberately best-effort end to end: the filesystem rename already succeeded, so a
// store or adapter failure downstream must not turn a completed rename into an error response.
async function reKeyRenamedBreakpoints(
  deps: UiHandlerDeps,
  realRoot: string,
  previousPath: string,
  nextPath: string,
): Promise<void> {
  const service = deps.dapDebug;
  if (service === undefined) return;
  const snapshot = service.breakpoints.snapshot(realRoot);
  if (!snapshot.ok) {
    // Codex review round 6 on PR #3141: an unavailable snapshot (corrupt record, transient
    // identity-inspection failure) used to skip the whole migration silently, bypassing the
    // service-side rejection diagnostic entirely. The rename still must not fail — but the skipped
    // migration has to be observable, mirroring the service's own redacted, body-free convention.
    emitServerDiagnostic(
      service.diagnosticSink,
      serverDiagnosticFromError({
        correlationId: `files-rename-${randomUUID()}`,
        operation: "files.rename.breakpoint-migration-skipped",
        source: "files.rename",
        error: new Error("BREAKPOINT_SNAPSHOT_UNAVAILABLE"),
        redact: () =>
          "Breakpoint migration for a rename was skipped: the instrumentation snapshot is " +
          "unavailable; breakpoints remain under the old path.",
      }),
    );
    return;
  }
  const renames = affectedRenamedFileIds(snapshot, previousPath, nextPath);
  if (renames.length > 0) await service.renameInstrumentation(realRoot, renames);
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
    const resolvedRoot = await resolveRequestRoot(ctx, deps, rootInput);
    const baseVersion = parseOptionalBaseVersion(body);
    if (isRouteResult(baseVersion)) return baseVersion;
    const result = await renameFilesEntry({
      store: deps.store,
      rootInput,
      pathInput,
      newPathInput,
      baseVersion: baseVersion.version,
      redactor: deps.redactor,
      resolvedRoot,
    });
    if (result.previousPath !== undefined) {
      // Deliberately NOT awaited (Codex P1 on PR #3141): the synchronous prefix — computing the
      // affected fileIds, the store re-key commits, rejection diagnostics, and the sessionless
      // browser publish — runs to completion before this expression yields, so the response body
      // and any immediately-following instrumentation read already see the migrated store. Only the
      // per-file adapter round-trips (3s deadline each) continue in the background; awaiting them
      // could hold this response for minutes on a directory rename against an unavailable adapter,
      // turning a long-completed filesystem rename into a UI timeout. renameInstrumentation's
      // contract is that it never rejects (failures degrade to redacted diagnostics), so nothing is
      // silently lost by detaching.
      void reKeyRenamedBreakpoints(deps, resolvedRoot.realRoot, result.previousPath, result.path);
    }
    return { status: 200, body: result };
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
    const resolvedRoot = await resolveRequestRoot(ctx, deps, rootInput);
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
        resolvedRoot,
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
    const resolvedRoot = await resolveRequestRoot(ctx, deps, rootInput);
    return {
      status: 201,
      body: await copyFilesEntry({
        store: deps.store,
        rootInput,
        sourcePathInput,
        destPathInput,
        redactor: deps.redactor,
        resolvedRoot,
      }),
    };
  });
}
