// Tool-layer contract types and frozen default tables (env allowlist, command rules,
// sandbox policy, limits, host config). No runtime logic lives here — the
// `resolveToolHostConfig` helper stays in src/tools/types.ts because it is layer logic, not a
// contract. `readonly` everywhere; optional props are `| undefined` because
// exactOptionalPropertyTypes is on. Imports end `.js`, double quotes, `type` keyword.

import type { ToolDefinition } from "./gateway.js";
import type { ContextToolObservation } from "./context-observations.js";

// ─── Sandbox policy (the 5 documented, inspectable dimensions) ───────────────────

// `"none"` is now OS/container-enforced: keiko-sandbox wraps a `network: "none"` run in a deny-by-
// default egress boundary at the keiko-tools spawn boundary (ADR-0043), and a host that cannot enforce
// it fails the command closed. `"inherit"` stays the default for the read-only command tools; a caller
// that executes untrusted code opts into `"none"` explicitly, WITHOUT any consumer change.
export type NetworkPolicy = "inherit" | "none";
export type FilesystemPolicy = "inherit" | "execution-root";

// How the spawn boundary supplies HOME/USERPROFILE to the child.
//   "ephemeral" — the default (ADR-0006 D2 Dimension 1 / C5): an empty per-run directory, so a
//                 home-dir credential lookup (~/.npmrc, ~/.aws, ~/.git-credentials) resolves to
//                 nothing.
//   "inherit"   — the parent's own HOME, and ONLY for the two governed git lanes that cannot
//                 function without it (commit identity + signing configuration; remote
//                 authentication). Both lanes must also list HOME on `envAllowlist`; a lane that
//                 asks to inherit an absent/empty HOME falls back to "ephemeral" so the child is
//                 never left without a home directory.
export type HomeIsolation = "ephemeral" | "inherit";

export interface SandboxPolicy {
  // Names (never values) of parent env vars allowed to reach the child. No credential-bearing
  // var is ever listed here; the child env is built by name-copy, never `...process.env`.
  readonly envAllowlist: readonly string[];
  // See NetworkPolicy: documented, not yet OS-enforced in Wave 1.
  readonly network: NetworkPolicy;
  // Optional stronger filesystem boundary for untrusted-code execution. The default/inherited tool
  // path leaves filesystem behaviour unchanged; assured execution sets this to "execution-root" and
  // requires an attested backend before surfacing apply-ready generated tests.
  readonly filesystem?: FilesystemPolicy | undefined;
  // Names (never values) of CREDENTIAL-bearing parent env vars the child may inherit. Deliberately a
  // SECOND list rather than more entries on `envAllowlist`: the spawn boundary derives its output
  // scrub set from "everything not on envAllowlist", so a credential listed here is forwarded to the
  // child AND still scrubbed from the captured stdout/stderr. Absent means "no credential reaches
  // the child" — the default for every lane except governed remote delivery.
  readonly credentialEnvAllowlist?: readonly string[] | undefined;
  // Fixed name→value pairs the boundary sets on the child AFTER the name-copy, so a lane can pin
  // fail-closed, deterministic behaviour (no interactive credential prompt, no pager, C locale)
  // instead of inheriting whatever the parent happened to carry. Never a way to reach HOME: the
  // home-isolation decision below is applied last and always wins.
  readonly pinnedEnv?: Readonly<Record<string, string>> | undefined;
  // Defaults to "ephemeral" when absent.
  readonly homeIsolation?: HomeIsolation | undefined;
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
  // `"inherit"` stays the default for the read-only command tools. A caller that executes UNTRUSTED
  // code (e.g. the #1202 assured pre-filter) passes `network: "none"` explicitly; keiko-sandbox then
  // wraps the spawn in an OS/container egress boundary, so `"none"` is now HONOURED, not merely
  // documented (ADR-0043). Leaving the default at `"inherit"` keeps the blast radius minimal.
  network: "inherit",
  maxOutputBytes: 262_144,
  defaultTimeoutMs: 30_000,
  terminationGraceMs: 2_000,
} as const;

// ─── Governed git lanes: the two credential-capable env profiles ─────────────────
//
// The fully isolated default above is correct for every tool that runs ON the workspace. It is NOT
// correct for the two governed git lanes that must act AS the local human against their own
// machine and their own remote: with an empty HOME, `git commit` cannot see the user's identity or
// signing configuration, and `git push` / `gh api` have no SSH agent, no ~/.ssh, no credential
// helper and no gh configuration — so governed delivery cannot authenticate at all.
//
// These profiles are the SANCTIONED lane for that, and they deliberately mirror the credential
// grant the product already ships for clone/fetch/pull (keiko-git `networkGitEnv`): the account and
// agent state normal git credentials need, and nothing else. They do NOT spread the parent
// environment, they never widen the command allowlists, and they leave every hard denial (no direct
// push to a protected branch, no force push, no admin bypass, no finding dismissal) untouched —
// those are enforced by policy packs and argv builders, not by the child's environment.

// Account/agent state shared by both governed git lanes. `EMAIL` and the GIT_AUTHOR_/GIT_COMMITTER_
// name+email pairs are how a user configures identity through the environment instead of a config
// file. The matching *_DATE names are deliberately ABSENT: a commit timestamp is evidence, and an
// ambient env var must not be able to backdate it.
const GOVERNED_GIT_ACCOUNT_ENV: readonly string[] = Object.freeze([
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "GNUPGHOME",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "USER",
  "USERNAME",
  "LOGNAME",
  "EMAIL",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
]);

// Lane 1 — governed LOCAL mutations (branch/stage/unstage/commit/recovery). Needs the user's git
// identity and signing configuration (~/.gitconfig, ~/.gnupg, an SSH signing agent) so that a
// repository configured for signed commits actually produces one, and a commit that cannot be
// signed FAILS instead of silently landing unsigned. No credential token: this lane never egresses.
const GOVERNED_GIT_IDENTITY_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  ...DEFAULT_ENV_ALLOWLIST,
  ...GOVERNED_GIT_ACCOUNT_ENV,
]);

// Lane 2 — governed REMOTE delivery (`git push`, `gh api` for pull request + merge). Adds gh's own
// non-secret host/config selectors on top of the account state.
export const GOVERNED_GIT_REMOTE_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  ...GOVERNED_GIT_IDENTITY_ENV_ALLOWLIST,
  "GH_HOST",
  "GH_CONFIG_DIR",
]);

// Credential-bearing names for lane 2 ONLY. Kept off `envAllowlist` on purpose so the spawn
// boundary keeps their values in its output scrub set: `gh` may print a token back in an error, and
// that string must never reach a classifier, an error, an evidence record or a diagnostic. Keiko
// forwards the NAME and never reads, stores, or logs the value.
export const GOVERNED_GIT_REMOTE_CREDENTIAL_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
]);

// Pins shared by both governed git lanes: never page (a pager blocks the bounded spawn), never open
// an interactive terminal prompt (a missing credential must FAIL CLOSED, not hang), and pin the C
// locale so the outcome classifiers keep matching git's/gh's English status phrases on a localized
// host.
const GOVERNED_GIT_PINNED_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  PAGER: "cat",
  LC_ALL: "C",
});

// Additional lane-2 pins, mirroring keiko-git `networkGitEnv`: every askpass/GUI credential prompt
// is disabled (`/dev/null` is a non-executable path on POSIX and a non-existent one on Windows, so
// the helper fails; GIT_ASKPASS also outranks a `core.askPass` from any config scope, and git then
// falls back to the already-disabled terminal prompt), and SSH runs in batch mode with no
// first-use host-key trust, so an unknown or changed host key fails closed.
//
// `networkGitEnv` additionally sets GIT_CONFIG_NOSYSTEM; this lane deliberately does NOT. On several
// platforms the SYSTEM git config is where the platform credential helper is declared (macOS ships
// `credential.helper = osxkeychain` there), so suppressing that scope would disable exactly the
// credentials this lane exists to use. Nothing fail-closed depends on it: the prompt pins above
// outrank every config scope.
const GOVERNED_GIT_REMOTE_PINNED_ENV: Readonly<Record<string, string>> = Object.freeze({
  ...GOVERNED_GIT_PINNED_ENV,
  GIT_ASKPASS: "/dev/null",
  SSH_ASKPASS: "/dev/null",
  SSH_ASKPASS_REQUIRE: "never",
  GCM_INTERACTIVE: "never",
  GIT_SSH_COMMAND:
    "ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -oNumberOfPasswordPrompts=0 -oKbdInteractiveAuthentication=no -oPasswordAuthentication=no",
});

export const GOVERNED_GIT_IDENTITY_SANDBOX_POLICY: SandboxPolicy = {
  ...DEFAULT_SANDBOX_POLICY,
  envAllowlist: GOVERNED_GIT_IDENTITY_ENV_ALLOWLIST,
  pinnedEnv: GOVERNED_GIT_PINNED_ENV,
  homeIsolation: "inherit",
} as const;

export const GOVERNED_GIT_REMOTE_SANDBOX_POLICY: SandboxPolicy = {
  ...DEFAULT_SANDBOX_POLICY,
  envAllowlist: GOVERNED_GIT_REMOTE_ENV_ALLOWLIST,
  credentialEnvAllowlist: GOVERNED_GIT_REMOTE_CREDENTIAL_ENV_ALLOWLIST,
  pinnedEnv: GOVERNED_GIT_REMOTE_PINNED_ENV,
  homeIsolation: "inherit",
} as const;

// ─── Sandbox enforcement attestation (ADR-0043, keiko-sandbox) ───────────────────
// Which OS/container primitive actually wrapped a `network: "none"` command and whether egress was
// enforced for that run. keiko-sandbox produces this; keiko-tools records it on the CommandResult and
// the redacted audit metadata so keiko-verification's HONEST `enforced` network flag derives from a
// real run rather than a hardcoded constant. Content-free: an enum, a boolean, and the platform name.
export type SandboxBackend =
  "bubblewrap" | "unshare" | "seatbelt" | "container-docker" | "container-podman" | "none";

export const SANDBOX_BACKENDS: readonly SandboxBackend[] = Object.freeze([
  "bubblewrap",
  "unshare",
  "seatbelt",
  "container-docker",
  "container-podman",
  "none",
]);

export interface SandboxAttestation {
  // The backend that wrapped the run; `"none"` means no isolation was applied (network: "inherit").
  readonly backend: SandboxBackend;
  // True only when network egress was OS/container-enforced for this run (an outbound connection
  // from the child fails). False for an inherited-network run.
  readonly networkEnforced: boolean;
  // True only when the run was contained to its disposable execution root for writes and host
  // user/runtime sockets were not mounted into the sandbox. False for inherited-network and
  // network-only compatibility runs.
  readonly filesystemEnforced: boolean;
  // node:os platform the decision was made on (e.g. "linux", "darwin", "win32").
  readonly platform: string;
}

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
  // Flags that must appear at the start of the argument vector, before the resolved subcommand. This
  // lets callers require invariants such as `npx --no-install <tool>` as policy, not convention.
  readonly requiredLeadingFlags?: readonly string[] | undefined;
  // When true, the argument vector must begin with the resolved subcommand. Useful for CLIs such as
  // npm where arbitrary config flags may consume the following token and make a value masquerade as
  // an allowed subcommand.
  readonly forbidLeadingFlags?: boolean | undefined;
  // Flags that are themselves denied because they execute a transitive shell or arbitrary command
  // (e.g. npm/npx `-c`/`--call`). Presence of any of these anywhere in args denies the invocation.
  readonly denyFlags?: readonly string[] | undefined;
  // Positional arguments that turn an otherwise allowed subcommand into a mutation. Entries are
  // scoped by subcommand so, for example, npm `audit fix` is denied without forbidding a package
  // named "fix" from the read-only `view` command.
  readonly deniedArgumentsBySubcommand?: Readonly<Record<string, readonly string[]>> | undefined;
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
    forbidLeadingFlags: true,
    // Shell-spawning and scope-shifting flags are denied outright. In particular, leaving
    // `--prefix` parseable lets its value masquerade as an allowed subcommand.
    denyFlags: Object.freeze([
      "-c",
      "--call",
      "--prefix",
      "-g",
      "--global",
      "--location",
      "-w",
      "--workspace",
      "--workspaces",
    ]),
    deniedArgumentsBySubcommand: Object.freeze({ audit: Object.freeze(["fix", "--fix"]) }),
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
  // Present when the command requested `network: "none"`: how (and whether) egress was enforced for
  // this run (ADR-0043). Absent for inherited-network runs, so existing callers are unaffected.
  readonly attestation?: SandboxAttestation | undefined;
  // Bytes the child attempted to write above policy.maxOutputBytes; absent when not truncated
  // (ADR-0054 PR3-W1, additive). Captured in exec.ts buildResult() from
  // buffers.attempted - policy.maxOutputBytes. Advisory: undercounts if the child was killed before
  // all over-cap bytes arrived. summarizeCommand does NOT serialize this, so the model-facing JSON
  // is byte-identical; existing callers that do not read it are unaffected.
  readonly omittedByteCount?: number | undefined;
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

// ─── Hexagonal tool ports (shared between harness consumer and tools implementer) ──────

export interface ToolCallRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  // MUST be honoured: abort terminates any spawned subprocess (no zombie processes).
  readonly signal: AbortSignal;
}

// S-M1: a small, REDACTED audit struct a command/patch tool fills so the executor can emit a
// command:executed / patch:applied event for the issue #10 ledger. Counts/flags ONLY — never
// stdout, argument values, or file paths/contents.
export type ToolCallMetadata =
  | {
      readonly kind: "command";
      readonly executable: string;
      readonly argCount: number;
      readonly exitCode: number | null;
      readonly timedOut: boolean;
      // Content-free truncation diagnostic for internal shaped observations. This is never
      // serialized into the model-facing run_command output.
      readonly omittedByteCount?: number | undefined;
      readonly sandbox: {
        readonly envAllowlist: readonly string[];
        readonly network: "inherit" | "none";
        readonly maxOutputBytes: number;
        readonly timeoutMs: number;
        readonly terminationGraceMs: number;
        readonly cwdRequested: boolean;
        readonly filesystem?: FilesystemPolicy | undefined;
        // Present for a `network: "none"` run (ADR-0043): the enforcing backend and whether egress
        // was actually blocked. Optional so inherited-network audit records are unchanged.
        readonly networkEnforced?: boolean | undefined;
        readonly filesystemEnforced?: boolean | undefined;
        readonly backend?: SandboxBackend | undefined;
      };
    }
  | {
      readonly kind: "patch-apply";
      readonly changedFiles: number;
      readonly created: number;
      readonly deleted: number;
    };

export interface ToolCallResult {
  readonly toolCallId: string;
  readonly output: string;
  readonly durationMs: number;
  // True only for tools that spawn a subprocess (run_command). The executor counts these
  // against maxCommandExecutions; absence/false leaves the command budget untouched (issue #6).
  readonly commandExecuted?: boolean | undefined;
  // S-M1: when present, the executor emits the matching redacted audit event in addition to
  // tool:call:completed. Absent for read-only tools.
  readonly metadata?: ToolCallMetadata | undefined;
  // Shaped observation produced by keiko-workflows shapers (ADR-0054 PR3-W1, additive). Absent on
  // legacy callers and on non-shapeable tool types (read_file, list_files,
  // inspect_package_scripts, propose_patch). An additive parallel projection alongside `output`;
  // the model-facing `output` string is unchanged in PR3.
  readonly shapedObservation?: ContextToolObservation | undefined;
}

export interface ToolPort {
  readonly execute: (request: ToolCallRequest) => Promise<ToolCallResult>;
  readonly listTools: () => readonly ToolDefinition[];
}
