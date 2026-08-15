// All workspace-layer interfaces and the frozen default tables. No runtime logic lives
// here beyond the frozen constant tables the type layer must expose as values, mirroring
// the ADR-0003/ADR-0004 `types.ts` precedent. `readonly` everywhere; optional props are
// `| undefined` because exactOptionalPropertyTypes is on.

// ─── Detected workspace ─────────────────────────────────────────────────────────

export const WORKSPACE_LANGUAGES = [
  "typescript",
  "javascript",
  "java",
  "kotlin",
  "scala",
  "groovy",
  "go",
  "rust",
  "python",
  "csharp",
  "fsharp",
  "vb",
  "cpp",
  "swift",
  "ruby",
  "php",
  "terraform",
  "sql",
  "protobuf",
  "openapi",
  "graphql",
] as const;

export type WorkspaceLanguage = (typeof WORKSPACE_LANGUAGES)[number];

export type TestFramework = "vitest" | "jest" | "mocha" | "unknown";

export interface WorkspaceInfo {
  readonly root: string;
  readonly name: string | undefined;
  readonly version: string | undefined;
  readonly testFramework: TestFramework;
  readonly sourceDirs: readonly string[];
  readonly testDirs: readonly string[];
  readonly languages: readonly WorkspaceLanguage[];
  readonly ignoreLines: readonly string[];
}

// ─── Discovery ──────────────────────────────────────────────────────────────────

export interface DiscoveredFile {
  readonly relativePath: string;
  readonly sizeBytes: number;
}

export interface DiscoveryOptions {
  readonly maxDepth: number;
  readonly maxFiles: number;
  readonly applyGitignore: boolean;
}

export const DEFAULT_DISCOVERY_OPTIONS: DiscoveryOptions = Object.freeze({
  maxDepth: 40,
  maxFiles: 50_000,
  applyGitignore: true,
});

export interface DiscoveryStats {
  readonly discovered: number;
  readonly denied: number;
  readonly ignored: number;
  readonly depthPruned: number;
  readonly maxFilesPruned: number;
}

// ─── File reads ─────────────────────────────────────────────────────────────────

export interface ReadOptions {
  readonly maxBytes: number;
}

export const DEFAULT_READ_OPTIONS: ReadOptions = Object.freeze({
  maxBytes: 262_144,
});

export interface FileContent {
  readonly relativePath: string;
  readonly sizeBytes: number;
  // Already redacted via redact() at the IO boundary; never raw secret content. Because redaction
  // rewrites the bytes (it can change a line's width and collapse a multi-line PEM block into one
  // token), the line and column numbers of this text do NOT necessarily address the same positions
  // in the file. A surface that needs coordinates it will WRITE back — the editor's search &
  // replace — must not derive them from here: it reads raw bytes through
  // `@oscharko-dev/keiko-workspace/internal/editor-read` instead. Everything that feeds evidence,
  // manifests, or grounded answers keeps using this redacted read.
  readonly text: string;
  readonly truncated: boolean;
}

// ─── Context pack ───────────────────────────────────────────────────────────────

export type SelectionReason =
  "entrypoint" | "manifest" | "documentation" | "config" | "source" | "test";

// Priority order used to rank candidates: lower index wins. Ties break on lexical path.
export const SELECTION_REASON_PRIORITY: readonly SelectionReason[] = [
  "entrypoint",
  "source",
  "test",
  "manifest",
  "config",
  "documentation",
] as const;

export interface ContextRequest {
  readonly task: string | undefined;
  readonly budgetBytes: number;
  readonly maxBytesPerFile: number;
  readonly discovery: DiscoveryOptions;
}

export const DEFAULT_CONTEXT_REQUEST: ContextRequest = Object.freeze({
  task: undefined,
  budgetBytes: 65_536,
  maxBytesPerFile: 8_192,
  discovery: DEFAULT_DISCOVERY_OPTIONS,
});

export interface ContextEntry {
  readonly path: string;
  readonly sizeBytes: number;
  readonly excerptBytes: number;
  readonly selectionReason: SelectionReason;
  readonly truncated: boolean;
  // Already redacted; safe to render or persist.
  readonly excerpt: string;
}

export interface ContextPack {
  readonly workspaceRoot: string;
  readonly totalCandidates: number;
  readonly selected: readonly ContextEntry[];
  readonly usedBytes: number;
  readonly budgetBytes: number;
  readonly droppedForBudget: number;
}

// ─── Structured summary (the only surface CLI/SDK/UI render) ─────────────────────

export interface ContextEntrySummary {
  readonly path: string;
  readonly sizeBytes: number;
  readonly excerptBytes: number;
  readonly selectionReason: SelectionReason;
  readonly truncated: boolean;
  readonly excerpt: string;
}

export interface ContextPackSummary {
  readonly totalCandidates: number;
  readonly usedBytes: number;
  readonly budgetBytes: number;
  readonly droppedForBudget: number;
  readonly entries: readonly ContextEntrySummary[];
}

export interface WorkspaceSummary {
  readonly root: string;
  readonly name: string | undefined;
  readonly version: string | undefined;
  readonly testFramework: TestFramework;
  readonly sourceDirs: readonly string[];
  readonly testDirs: readonly string[];
  readonly languages: readonly WorkspaceLanguage[];
  readonly counts: DiscoveryStats;
  readonly context: ContextPackSummary | undefined;
}

export interface AuditEntry {
  readonly path: string;
  readonly sizeBytes: number;
  readonly excerptBytes: number;
  readonly selectionReason: SelectionReason;
  readonly truncated: boolean;
}

export interface AuditSummary {
  readonly workspaceRoot: string;
  readonly totalCandidates: number;
  readonly usedBytes: number;
  readonly budgetBytes: number;
  readonly droppedForBudget: number;
  readonly entries: readonly AuditEntry[];
}
