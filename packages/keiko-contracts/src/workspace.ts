// All workspace-layer interfaces and the frozen default tables. No runtime logic lives
// here beyond the frozen constant tables the type layer must expose as values, mirroring
// the ADR-0003/ADR-0004 `types.ts` precedent. `readonly` everywhere; optional props are
// `| undefined` because exactOptionalPropertyTypes is on.

// ─── Detected workspace ─────────────────────────────────────────────────────────

export type WorkspaceLanguage = "typescript" | "javascript";

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

export const DEFAULT_DISCOVERY_OPTIONS: DiscoveryOptions = {
  maxDepth: 12,
  maxFiles: 5_000,
  applyGitignore: true,
} as const;

export interface DiscoveryStats {
  readonly discovered: number;
  readonly denied: number;
  readonly ignored: number;
}

// ─── File reads ─────────────────────────────────────────────────────────────────

export interface ReadOptions {
  readonly maxBytes: number;
}

export const DEFAULT_READ_OPTIONS: ReadOptions = {
  maxBytes: 262_144,
} as const;

export interface FileContent {
  readonly relativePath: string;
  readonly sizeBytes: number;
  // Already redacted via redact() at the IO boundary; never raw secret content.
  readonly text: string;
  readonly truncated: boolean;
}

// ─── Context pack ───────────────────────────────────────────────────────────────

export type SelectionReason =
  | "entrypoint"
  | "manifest"
  | "documentation"
  | "config"
  | "source"
  | "test";

// Priority order used to rank candidates: lower index wins. Ties break on lexical path.
export const SELECTION_REASON_PRIORITY: readonly SelectionReason[] = [
  "entrypoint",
  "manifest",
  "documentation",
  "config",
  "source",
  "test",
] as const;

export interface ContextRequest {
  readonly task: string | undefined;
  readonly budgetBytes: number;
  readonly maxBytesPerFile: number;
  readonly discovery: DiscoveryOptions;
}

export const DEFAULT_CONTEXT_REQUEST: ContextRequest = {
  task: undefined,
  budgetBytes: 65_536,
  maxBytesPerFile: 8_192,
  discovery: DEFAULT_DISCOVERY_OPTIONS,
} as const;

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
