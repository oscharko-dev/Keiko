// Tool-layer contract types and frozen default tables (env allowlist, command rules,
// sandbox policy, limits, host config). No runtime logic lives here — the
// `resolveToolHostConfig` helper stays in src/tools/types.ts because it is layer logic, not a
// contract. `readonly` everywhere; optional props are `| undefined` because
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
//
// HOME and USERPROFILE are deliberately ABSENT (C5). Forwarding the developer's real home would let
// a subprocess read ~/.npmrc (npm tokens), ~/.git-credentials, and ~/.aws/… by standard home-dir
// lookup. runCommand instead injects an ephemeral, EMPTY per-run dir as HOME/USERPROFILE so those
// lookups resolve to nothing (ADR-0006 D2 Dimension 1).
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  "PATH",
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
  maxOutputBytes: 262_144,
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
  // Leading flags that consume the NEXT token as their value (e.g. npm `--prefix DIR`, git `-C DIR`).
  // The subcommand resolver skips both the flag and its value so a value cannot masquerade as the
  // subcommand (S-H2): `npm --prefix /x publish` resolves to `publish`, not `/x`.
  readonly valueFlags?: readonly string[] | undefined;
  // Flags that are themselves denied because they execute a transitive shell or arbitrary command
  // (e.g. npm/npx `-c`/`--call`). Presence of any of these anywhere in args denies the invocation.
  readonly denyFlags?: readonly string[] | undefined;
  // In denylist mode, the resolved first non-flag token MUST be one of these known subcommands;
  // an unrecognized token (e.g. a stray path left by a value-flag bypass) is denied by default.
  readonly knownSubcommands?: readonly string[] | undefined;
}

// Minimal, justified default rules. Everything not listed is denied (deny-by-default).
export const DEFAULT_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  {
    executable: "npm",
    // Read-only npm only. Mutating/package-installing subcommands are excluded by omission.
    allowedSubcommands: Object.freeze([
      "audit",
      "ls",
      "list",
      "outdated",
      "view",
      "info",
      "help",
      "ping",
    ]),
    // `-c`/`--call` execute a command string in a shell; deny outright (S-H2).
    denyFlags: Object.freeze(["-c", "--call"]),
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
    // Global value flags that precede the subcommand (`git -C DIR <sub>`). Skipping them prevents
    // the value (DIR) from being read as the subcommand (S-H2).
    valueFlags: Object.freeze([
      "-C",
      "-c",
      "--git-dir",
      "--work-tree",
      "--namespace",
      "--exec-path",
    ]),
    // Deny git's code-execution / external-driver flags. `git -c diff.external=<cmd> diff` (and
    // --config-env/--ext-diff/--textconv) make git spawn an arbitrary command via its OWN shell,
    // defeating the Node spawn's shell:false; --exec-path redirects git to attacker-supplied sub-binaries.
    // hasDeniedFlag runs BEFORE subcommand resolution and matches both `--flag value` and
    // `--flag=value`. `-C`/--git-dir/--work-tree stay value-flags (location only, not execution).
    denyFlags: Object.freeze([
      "-c",
      "--config-env",
      "--exec-path",
      "--ext-diff",
      "--textconv",
      "--no-index",
      "--output",
      "--contents",
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
  // Present when validation had to repair common LLM unified-diff shorthand before parsing.
  readonly normalizedDiff?: string | undefined;
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

// Caller-facing override shape. The nested `sandbox` and `patchLimits` objects are accepted as
// PARTIALS so an integrator can override one field (e.g. maxOutputBytes) without re-stating the
// whole object — the host deep-merges them over DEFAULT_TOOL_HOST_CONFIG (S-M2). A plain
// `Partial<ToolHostConfig>` would force a shallow spread that drops the unspecified sub-fields
// (notably envAllowlist), so this distinct input type is the contract.
export interface ToolHostConfigInput {
  readonly sandbox?: Partial<SandboxPolicy> | undefined;
  readonly commandRules?: readonly CommandRule[] | undefined;
  readonly patchLimits?: Partial<PatchLimits> | undefined;
  readonly applyEnabled?: boolean | undefined;
  readonly maxReadBytes?: number | undefined;
}
