// All tool-layer interfaces and the frozen default tables (env allowlist, command rules,
// sandbox policy, limits, host config). No runtime logic lives here beyond the frozen
// constant tables the type layer exposes as values, mirroring the ADR-0003/0004/0005
// `types.ts` precedent. `readonly` everywhere; optional props are `| undefined` because
// exactOptionalPropertyTypes is on. Imports end `.js`, double quotes, `type` keyword.

// ─── Sandbox policy (the 5 documented, inspectable dimensions) ───────────────────

// Wave 1 does NOT enforce OS-level network isolation (that needs the container layer,
// deferred to a later wave per ADR-0006). `"inherit"` is the honest current value; a later
// wave flips this to `"none"` when the isolation layer lands, WITHOUT changing consumers.
export type NetworkPolicy = "inherit" | "none";

export interface SandboxPolicy {
  // Names (never values) of parent env vars allowed to reach the child. No credential-bearing
  // var is ever listed here; the child env is built by name-copy, never `...process.env`.
  readonly envAllowlist: readonly string[];
  // See NetworkPolicy: documented, not yet OS-enforced in Wave 1.
  readonly network: NetworkPolicy;
  // Hard cap on combined stdout+stderr bytes buffered before the child is killed (flood guard).
  readonly maxOutputBytes: number;
  // Default per-command wall-time before SIGTERM/SIGKILL.
  readonly defaultTimeoutMs: number;
  // Grace period between SIGTERM and SIGKILL on timeout/abort.
  readonly terminationGraceMs: number;
}

// Cross-platform name allowlist. Only names that are PRESENT in the parent are copied, so an
// absent Windows var on POSIX (or vice versa) is simply skipped.
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "TMPDIR",
  // Windows essentials so spawned tools resolve the shell-less executable correctly.
  "SystemRoot",
  "SystemDrive",
  "PATHEXT",
  "COMSPEC",
  "NUMBER_OF_PROCESSORS",
  "WINDIR",
]);

export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = {
  envAllowlist: DEFAULT_ENV_ALLOWLIST,
  network: "inherit",
  maxOutputBytes: 1_048_576,
  defaultTimeoutMs: 30_000,
  terminationGraceMs: 2_000,
} as const;

// ─── Command allowlist (deny-by-default) ─────────────────────────────────────────

export interface CommandRule {
  readonly executable: string;
  // When set, ONLY these subcommands are allowed (allowlist mode).
  readonly allowedSubcommands?: readonly string[] | undefined;
  // When set (and allowedSubcommands is not), these subcommands are denied (denylist mode).
  readonly deniedSubcommands?: readonly string[] | undefined;
}

// Minimal, justified default rules. Everything not listed is denied (deny-by-default).
export const DEFAULT_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  { executable: "node" },
  { executable: "npx" },
  {
    executable: "npm",
    // Deny account/registry-mutating subcommands; allow run/test/ci/ls/exec/install.
    deniedSubcommands: Object.freeze([
      "publish",
      "unpublish",
      "login",
      "logout",
      "adduser",
      "token",
      "version",
      "deprecate",
      "owner",
      "access",
      "star",
      "profile",
    ]),
  },
  {
    executable: "git",
    // READ-ONLY git only; push/reset/checkout/commit/merge/rebase/clean/config/remote denied.
    allowedSubcommands: Object.freeze([
      "status",
      "diff",
      "log",
      "show",
      "rev-parse",
      "ls-files",
      "describe",
      "blame",
      "cat-file",
    ]),
  },
]);

// ─── Command execution result ────────────────────────────────────────────────────

export interface CommandRunInput {
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal: AbortSignal;
}

export interface CommandResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  // Already redacted + capped at maxOutputBytes; never raw secret content.
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

// ─── Patch workflow ──────────────────────────────────────────────────────────────

export type PatchChangeKind = "create" | "modify" | "delete";

export interface PatchHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  // Body lines including the leading marker (" ", "+", "-").
  readonly lines: readonly string[];
}

export interface PatchFileChange {
  readonly path: string;
  readonly kind: PatchChangeKind;
  readonly hunks: readonly PatchHunk[];
  readonly addedLines: number;
  readonly removedLines: number;
}

export type PatchRejectionCode =
  | "size-limit"
  | "binary"
  | "path-unsafe"
  | "path-denied"
  | "line-limit"
  | "file-limit"
  | "malformed";

export interface PatchRejection {
  readonly code: PatchRejectionCode;
  readonly message: string;
  readonly path?: string | undefined;
}

export interface PatchConflict {
  readonly path: string;
  readonly hunkIndex: number;
  readonly reason: string;
}

export interface PatchValidation {
  readonly ok: boolean;
  readonly files: readonly PatchFileChange[];
  readonly totalChangedLines: number;
  readonly totalBytes: number;
  readonly reasons: readonly PatchRejection[];
  readonly conflicts: readonly PatchConflict[];
}

export interface PatchLimits {
  readonly maxPatchBytes: number;
  readonly maxChangedLines: number;
  readonly maxFilesChanged: number;
}

export const DEFAULT_PATCH_LIMITS: PatchLimits = {
  maxPatchBytes: 65_536,
  maxChangedLines: 2_000,
  maxFilesChanged: 50,
} as const;

export interface PatchApplyResult {
  readonly changedFiles: readonly string[];
  readonly created: readonly string[];
  readonly deleted: readonly string[];
}

// ─── Tool host configuration ─────────────────────────────────────────────────────

export interface ToolHostConfig {
  readonly sandbox: SandboxPolicy;
  readonly commandRules: readonly CommandRule[];
  readonly patchLimits: PatchLimits;
  // Fail-closed: apply_patch only writes when this is explicitly true.
  readonly applyEnabled: boolean;
  // Default read cap for read_file / inspect_package_scripts.
  readonly maxReadBytes: number;
}

export const DEFAULT_TOOL_HOST_CONFIG: ToolHostConfig = {
  sandbox: DEFAULT_SANDBOX_POLICY,
  commandRules: DEFAULT_COMMAND_RULES,
  patchLimits: DEFAULT_PATCH_LIMITS,
  applyEnabled: false,
  maxReadBytes: 262_144,
} as const;
