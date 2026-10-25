import { createHash, randomBytes } from "node:crypto";
import { lstatSync, realpathSync, statSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  CodingWorkbenchActionClass,
  CodingWorkbenchApprovalRisk,
  CodingWorkbenchPermissionRequestKind,
  CodingWorkbenchPolicyResourceScope,
  McpToolRisk,
  VerificationKind,
} from "@oscharko-dev/keiko-contracts";
import {
  codingWorkbenchPolicyEffectFor,
  isCodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS } from "@oscharko-dev/keiko-contracts/runtime/tools";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { isDenied } from "@oscharko-dev/keiko-workspace";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";

import type { SidecarPermissionEvent } from "./codingSidecarEventParser.js";
import type { CodingToolNativeCharge } from "./codingToolFacadePorts.js";
import { OPENCODE_NATIVE_DELIVERY_REFUSAL_MESSAGE } from "./opencodeNativeDeliveryTools.js";
import {
  OPENCODE_CODE_MODE_SESSION_MOVE,
  OPENCODE_CODE_MODE_WORKTREE_CREATE,
  OPENCODE_NATIVE_POLICY_ACTION,
  OPENCODE_NATIVE_POLICY_MAX_RESOURCES,
  OPENCODE_NATIVE_POLICY_MAX_RESOURCE_CHARS,
} from "./opencodeNativePolicyPlugin.js";
import { OPENCODE_NATIVE_PERMISSION_ACTIONS } from "./opencodeNativeTools.js";
import type { NativeWorktreeDisposition } from "./opencodeNativeWorktree.js";
import { projectOpenCodePermissionRequestId } from "./opencodeProtocol.js";

/**
 * The server-owned policy behind the native permission hook (#3897). OpenCode runs its own tools;
 * before each evaluated action it asks this policy for the final effect. The policy maps the
 * action onto the existing ADR-0138 matrix (resource scope x risk x mode), applies the
 * mode-independent hard denials (workspace escape, denied sensitive paths, Keiko-owned delivery)
 * and, where the matrix says approval-required, puts the action to the human through the existing
 * approval lane. It grants nothing a mapped tool could not: a native action gets exactly the
 * disposition the same action class already had.
 */
export interface OpenCodeNativePolicyRequest {
  readonly runId: string;
  readonly sessionID: string;
  readonly agent?: string | undefined;
  readonly permission: string;
  readonly resources: readonly string[];
  readonly source?: { readonly messageID: string; readonly id: string } | undefined;
  /** The directory a `glob`/`grep` searches (its permission metadata); resources are patterns. */
  readonly searchPath?: string | undefined;
  /**
   * The UTF-8 size of the unified diff the producer computed for a proposed `edit` (its permission
   * metadata), measured by the plugin so no content leaves the runtime. The run's patch budget is
   * charged with it before the effect (#3897 review). Absent when the producer attached no diff,
   * which it does exactly when the edit cannot apply (no match, or an ambiguous one).
   */
  readonly patchBytes?: number | undefined;
  /**
   * The session a Code Mode `session_move` names (#3903 AC4); absent when it moves the calling
   * session. Only the calling session may be moved.
   */
  readonly targetSessionID?: string | undefined;
}

export type OpenCodeNativePolicyDenyReason =
  | "unsupported-action"
  | "workspace-escape"
  | "sensitive-path"
  | "linked-file"
  | "delivery-reserved"
  | "mode-denied";

export type OpenCodeNativePolicyDecision =
  | { readonly effect: "allow"; readonly classification: OpenCodeNativeActionClassification }
  | {
      readonly effect: "deny";
      readonly reason: OpenCodeNativePolicyDenyReason;
      readonly message: string;
      readonly classification?: OpenCodeNativeActionClassification | undefined;
    }
  | {
      readonly effect: "ask";
      readonly classification: OpenCodeNativeActionClassification;
      readonly event: SidecarPermissionEvent;
      readonly actionId: string | undefined;
    };

export interface OpenCodeNativeActionClassification {
  readonly actionClass: CodingWorkbenchActionClass;
  readonly kind: CodingWorkbenchPermissionRequestKind;
  readonly scope: CodingWorkbenchPolicyResourceScope;
  readonly risk: CodingWorkbenchApprovalRisk;
  /** Closed evidence label for the approval card and the log; never the resource text. */
  readonly label: NativeActionLabel;
}

type NativeActionLabel =
  | "native-read"
  | "native-edit"
  | "native-shell"
  | "native-egress"
  | "native-execute"
  | "native-mcp";

const SEARCH_ACTIONS = new Set(["glob", "grep"]);
/** A new managed task workspace's name: the task id the managed owner derives its branch from. */
const WORKTREE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const READ_ACTIONS = new Set([
  "read",
  "list",
  "skill",
  "subagent",
  "question",
  "todowrite",
  "doom_loop",
]);
const EDIT_ACTIONS = new Set(["edit", "write", "patch"]);
const EGRESS_ACTIONS = new Set(["webfetch", "websearch"]);
const KNOWN_ACTIONS: ReadonlySet<string> = new Set(OPENCODE_NATIVE_PERMISSION_ACTIONS);
/** The closed log vocabulary of evaluated actions; anything unpinned is logged as `other`. */
const PERMISSION_LOG_VALUES = [
  "read",
  "glob",
  "grep",
  "list",
  "edit",
  "shell",
  "webfetch",
  "websearch",
  "skill",
  "subagent",
  "question",
  "todowrite",
  "execute",
  "external_directory",
  "doom_loop",
  "opencode_session_move",
  "opencode_worktree_create",
] as const;
type PermissionLogValue = (typeof PERMISSION_LOG_VALUES)[number] | "other";
// An MCP tool is logged by its class alone: its server and tool names are the operator's words.
function loggedPermission(
  request: OpenCodeNativePolicyRequest,
  decision: OpenCodeNativePolicyDecision,
): PermissionLogValue | "mcp" {
  return decision.classification?.label === "native-mcp"
    ? "mcp"
    : permissionLogValue(request.permission);
}

function permissionLogValue(permission: string): PermissionLogValue {
  const known = PERMISSION_LOG_VALUES.find((value) => value === permission);
  return known ?? "other";
}
const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,251}$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/**
 * Git operations Keiko owns as product actions (signed commits, bounded refs, human-controlled
 * merge, ADR-0135): a native shell may read the repository but never deliver through it.
 */
const RESERVED_GIT_SUBCOMMANDS = new Set([
  "commit",
  "push",
  "pull",
  "fetch",
  "merge",
  "rebase",
  "reset",
  "checkout",
  "switch",
  "branch",
  "tag",
  "remote",
  "stash",
  "cherry-pick",
  "revert",
  "am",
  "apply",
  "clean",
  "worktree",
  "submodule",
  "gc",
  "filter-branch",
]);
/**
 * Commands a Supervised workspace runs without a decision (ADR-0138: "vetted commands and
 * verification"): the project's own package scripts, test runners, type checkers, linters,
 * formatters and build tools, and read-only Git and file inspection. Anything else is a
 * high-risk command that asks. Token based, so classification stays linear in the command.
 */
const VETTED_PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const VETTED_PACKAGE_SUBCOMMANDS = new Set([
  "run",
  "test",
  "t",
  "run-script",
  "ci",
  "install",
  "i",
  "exec",
  "x",
]);
const VETTED_NPX_TOOLS = new Set([
  "vitest",
  "jest",
  "mocha",
  "tsc",
  "eslint",
  "prettier",
  "playwright",
  "tsx",
  "ts-node",
  "next",
  "vite",
  "turbo",
  "nx",
]);
const VETTED_BUILD_TOOLS: Readonly<Record<string, ReadonlySet<string>>> = {
  mvn: new Set(["test", "verify", "compile", "package", "install", "clean"]),
  mvnw: new Set(["test", "verify", "compile", "package", "install", "clean"]),
  "./mvnw": new Set(["test", "verify", "compile", "package", "install", "clean"]),
  gradle: new Set(["test", "check", "build", "compileJava", "assemble", "clean"]),
  gradlew: new Set(["test", "check", "build", "compileJava", "assemble", "clean"]),
  "./gradlew": new Set(["test", "check", "build", "compileJava", "assemble", "clean"]),
  cargo: new Set(["test", "build", "check", "clippy", "fmt"]),
  go: new Set(["test", "build", "vet", "fmt"]),
  make: new Set(["test", "check", "build", "lint"]),
  git: new Set([
    "status",
    "diff",
    "log",
    "show",
    "blame",
    "ls-files",
    "rev-parse",
    "describe",
    "grep",
    "shortlog",
  ]),
};
const VETTED_INSPECTION_TOOLS = new Set([
  "pytest",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "find",
  "grep",
  "rg",
  "pwd",
  "echo",
  "tree",
  "which",
  "env",
  "printenv",
  "date",
  "sort",
  "uniq",
  "diff",
  "stat",
  "du",
  "file",
]);
const RESERVED_GH_SUBCOMMANDS = new Set(["pr", "repo", "release", "api"]);

/** Splits a command line at its shell list operators; no regex backtracking is involved. */
function commandSegments(command: string): readonly string[] {
  return command
    .split(/&&|\|\||[;|]/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * Whitespace tokens of one segment, reduced to the effective invocation: leading `NAME=value`
 * assignments and transparent wrappers (`env`, `command`, `exec`, `nice`, `nohup`, `time`) are
 * dropped with their own options, and a program given by path is read by its basename, so
 * `env git push`, `/usr/bin/git push` and `exec git push` all read as `git push`. Quoting is not
 * interpreted, so a token is at most a hint (#3897 review).
 */
function commandTokens(segment: string): readonly string[] {
  let tokens: readonly string[] = segment.split(/\s+/u).filter((token) => token.length > 0);
  for (let guard = 0; guard < 8; guard += 1) {
    const stripped = stripInvocationPrefix(tokens);
    if (stripped === tokens) break;
    tokens = stripped;
  }
  const [program, ...rest] = tokens;
  return program === undefined ? [] : [program.slice(program.lastIndexOf("/") + 1), ...rest];
}

const WRAPPER_PROGRAMS = new Set(["env", "command", "exec", "nice", "nohup", "time"]);
/** Wrapper options that take a separate argument (`env -u NAME`, `nice -n 10`). */
const WRAPPER_OPTIONS_WITH_VALUE = new Set([
  "-u",
  "--unset",
  "-n",
  "--adjustment",
  "-C",
  "--chdir",
]);

function stripInvocationPrefix(tokens: readonly string[]): readonly string[] {
  const [first] = tokens;
  if (first === undefined) return tokens;
  if (/^[A-Za-z_]\w*=/u.test(first)) return tokens.slice(1);
  const program = first.slice(first.lastIndexOf("/") + 1);
  if (!WRAPPER_PROGRAMS.has(program)) return tokens;
  let index = 1;
  while (index < tokens.length && tokens[index]?.startsWith("-") === true) {
    const option = tokens[index] ?? "";
    index += WRAPPER_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
    if (option === "--") break;
  }
  return tokens.slice(index);
}

/** Git global options that consume the next token (`git -C <path> push`, `git -c k=v push`). */
const GIT_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--config-env",
]);

/** The first non-option token after `program`, as `git <subcommand>` would read it. */
function subcommandOf(tokens: readonly string[]): string | undefined {
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (!token.startsWith("-")) return token;
    index += tokens[0] === "git" && GIT_OPTIONS_WITH_VALUE.has(token) ? 2 : 1;
  }
  return undefined;
}

function isVettedSegment(segment: string): boolean {
  const tokens = commandTokens(segment);
  const [program] = tokens;
  if (program === undefined) return false;
  const subcommand = subcommandOf(tokens);
  const vettedSubcommands = vettedSubcommandsOf(program);
  if (vettedSubcommands !== undefined)
    return subcommand !== undefined && vettedSubcommands.has(subcommand);
  if (program === "node") return isVettedNodeInvocation(subcommand);
  if (program === "python" || program === "python3")
    return tokens[1] === "-m" && (tokens[2] === "pytest" || tokens[2] === "unittest");
  return VETTED_INSPECTION_TOOLS.has(program);
}

function vettedSubcommandsOf(program: string): ReadonlySet<string> | undefined {
  if (VETTED_PACKAGE_MANAGERS.has(program)) return VETTED_PACKAGE_SUBCOMMANDS;
  if (program === "npx") return VETTED_NPX_TOOLS;
  // Own entries only: `constructor` or `__proto__` as a program must not reach the prototype.
  return Object.hasOwn(VETTED_BUILD_TOOLS, program) ? VETTED_BUILD_TOOLS[program] : undefined;
}

function isVettedNodeInvocation(subcommand: string | undefined): boolean {
  return subcommand === "--test" || /\.(?:m?js|c?js|ts)$/u.test(subcommand ?? "");
}

/**
 * The project check a native shell line runs (#3897 review, #3901). The runtime reports one exit
 * status for the whole line, so the line counts as verification only when that status is the
 * check's own: simple commands joined by `&&` alone, each a check or a `cd`, at least one a check.
 * An `&&` list exits zero only when every command in it did. `;`, `||`, a pipe, a background `&`
 * or a second line lets a later command decide the status (`npm test; cd .` exits zero after a
 * failed test), so such a line is no verification at all; it still runs under the shell policy.
 */
export function openCodeNativeVerificationKind(
  resources: readonly string[],
): VerificationKind | undefined {
  let kind: VerificationKind | undefined;
  for (const resource of resources) {
    const segments = statusPreservingSegments(resource);
    if (segments === undefined) return undefined;
    for (const segment of segments) {
      const tokens = commandTokens(segment);
      if (tokens[0] === "cd") continue;
      const next = segmentVerificationKind(tokens);
      if (next === undefined) return undefined;
      kind ??= next;
    }
  }
  return kind;
}

/**
 * The `&&`-joined simple commands of a line, or undefined when another operator could hand the
 * line's exit status to a command after the check. A descriptor duplication (`2>&1`) is not one.
 */
function statusPreservingSegments(command: string): readonly string[] | undefined {
  const segments = command.split("&&").map((segment) => segment.trim());
  const decided = segments.some(
    (segment) =>
      segment.length === 0 || STATUS_HANDOVER.test(segment.replaceAll(DESCRIPTOR_DUPLICATION, "")),
  );
  return decided ? undefined : segments;
}

const DESCRIPTOR_DUPLICATION = /\d?>&\d/gu;
const STATUS_HANDOVER = /[;|&\n\r]/u;

const NPX_VERIFICATION_KINDS: ReadonlyMap<string, VerificationKind> = new Map([
  ["vitest", "test"],
  ["jest", "test"],
  ["mocha", "test"],
  ["playwright", "test"],
  ["tsc", "typecheck"],
  ["eslint", "lint"],
]);
type BuildToolChecks = readonly (readonly [string, VerificationKind])[];
const MAVEN_CHECKS: BuildToolChecks = [
  ["test", "test"],
  ["verify", "test"],
  ["compile", "build"],
  ["package", "build"],
];
const GRADLE_CHECKS: BuildToolChecks = [
  ["test", "test"],
  ["check", "test"],
  ["build", "build"],
  ["compileJava", "build"],
];
const BUILD_TOOL_VERIFICATION: ReadonlyMap<string, BuildToolChecks> = new Map<
  string,
  BuildToolChecks
>([
  ["mvn", MAVEN_CHECKS],
  ["mvnw", MAVEN_CHECKS],
  ["gradle", GRADLE_CHECKS],
  ["gradlew", GRADLE_CHECKS],
  [
    "cargo",
    [
      ["test", "test"],
      ["build", "build"],
      ["check", "build"],
      ["clippy", "lint"],
    ],
  ],
  [
    "go",
    [
      ["test", "test"],
      ["build", "build"],
      ["vet", "lint"],
    ],
  ],
  [
    "make",
    [
      ["test", "test"],
      ["check", "test"],
      ["build", "build"],
      ["lint", "lint"],
    ],
  ],
]);
/** A package script's check by its name: `test`, `test:unit`, `typecheck`, `lint:fix`, ... */
const SCRIPT_VERIFICATION: readonly (readonly [RegExp, VerificationKind])[] = [
  [/^(?:test|tests|spec|check|verify)(?::|$)/u, "test"],
  [/^(?:typecheck|type-check|types|tsc)(?::|$)/u, "typecheck"],
  [/^(?:lint|eslint)(?::|$)/u, "lint"],
  [/^(?:build|compile)(?::|$)/u, "build"],
];

/**
 * Options and subcommands that make a check print, list or plan instead of running (#3901): such a
 * line exits zero without testing, type-checking, linting or building anything, so its status
 * cannot be verification evidence.
 */
const NON_EXECUTING_FLAGS: ReadonlySet<string> = new Set([
  "--help",
  "-h",
  "--version",
  "--listTests",
  "--list-tests",
  "--list",
  "-list",
  "--showConfig",
  "--print-config",
  "--init",
  "--dry-run",
  "--collect-only",
  "--co",
  "--no-run",
  "--just-print",
  "--recon",
  "--question",
]);
const PROGRAM_NON_EXECUTING: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["make", new Set(["-n", "-q", "-t", "-v", "--touch"])],
  ["gradle", new Set(["-m", "-v", "--task-graph"])],
  ["gradlew", new Set(["-m", "-v", "--task-graph"])],
  ["./gradlew", new Set(["-m", "-v", "--task-graph"])],
  ["npx", new Set(["list"])],
]);
/** Stop at an operand: in `-fnotes` the `n` names a file, not make's dry-run switch. */
const PROGRAM_SHORT_OPTION_OPERANDS: ReadonlyMap<string, string> = new Map([
  ["make", "CEfIjloONW"],
  ["gradle", "bcgIpDPx"],
  ["gradlew", "bcgIpDPx"],
  ["./gradlew", "bcgIpDPx"],
]);

function nonExecutingShortOptions(token: string, program: string): boolean {
  const operands = PROGRAM_SHORT_OPTION_OPERANDS.get(program);
  if (operands === undefined || !/^-[^-]/u.test(token)) return false;
  const own = PROGRAM_NON_EXECUTING.get(program);
  for (const letter of token.slice(1)) {
    const option = `-${letter}`;
    if (NON_EXECUTING_FLAGS.has(option) || own?.has(option)) return true;
    if (operands.includes(letter)) return false;
  }
  return false;
}

function nonExecutingCheck(tokens: readonly string[]): boolean {
  const program = tokens[0] ?? "";
  const own = PROGRAM_NON_EXECUTING.get(program);
  return tokens.slice(1).some((token) => {
    const option = token.startsWith("-") ? (token.split("=", 1)[0] ?? token) : token;
    return (
      NON_EXECUTING_FLAGS.has(option) ||
      own?.has(option) === true ||
      nonExecutingShortOptions(token, program)
    );
  });
}

function segmentVerificationKind(tokens: readonly string[]): VerificationKind | undefined {
  const [program] = tokens;
  if (program === undefined || nonExecutingCheck(tokens)) return undefined;
  const subcommand = subcommandOf(tokens);
  if (VETTED_PACKAGE_MANAGERS.has(program)) return packageCheckKind(tokens, subcommand);
  const check = PROGRAM_CHECKS.get(program);
  if (check !== undefined) return check(tokens, subcommand);
  return BUILD_TOOL_VERIFICATION.get(program)?.find(([name]) => name === subcommand)?.[1];
}

type ProgramCheck = (
  tokens: readonly string[],
  subcommand: string | undefined,
) => VerificationKind | undefined;

function pythonCheck(tokens: readonly string[]): VerificationKind | undefined {
  return tokens[1] === "-m" && (tokens[2] === "pytest" || tokens[2] === "unittest")
    ? "test"
    : undefined;
}

function npxCheck(
  _tokens: readonly string[],
  subcommand: string | undefined,
): VerificationKind | undefined {
  return NPX_VERIFICATION_KINDS.get(subcommand ?? "");
}

function nodeCheck(tokens: readonly string[]): VerificationKind | undefined {
  return tokens[1] === "--test" ? "test" : undefined;
}

function pytestCheck(): VerificationKind {
  return "test";
}

const PROGRAM_CHECKS: ReadonlyMap<string, ProgramCheck> = new Map<string, ProgramCheck>([
  ["npx", npxCheck],
  ["node", nodeCheck],
  ["pytest", pytestCheck],
  ["python", pythonCheck],
  ["python3", pythonCheck],
]);

function packageCheckKind(
  tokens: readonly string[],
  subcommand: string | undefined,
): VerificationKind | undefined {
  if (subcommand === "test" || subcommand === "t") return "test";
  if (subcommand !== "run" && subcommand !== "run-script") return undefined;
  const script = tokens
    .slice(tokens.indexOf(subcommand) + 1)
    .find((token) => !token.startsWith("-"));
  return SCRIPT_VERIFICATION.find(([pattern]) => pattern.test(script ?? ""))?.[1];
}

export function parseOpenCodeNativePolicyRequest(
  value: unknown,
): OpenCodeNativePolicyRequest | undefined {
  const record = asRecord(value);
  if (record?.action !== OPENCODE_NATIVE_POLICY_ACTION) return undefined;
  const identity = parseIdentity(record);
  const bounded = boundedResources(record.resources);
  const optional = parseOptionalFields(record);
  const target = parseTargetSession(record.targetSessionID);
  if (identity === undefined || bounded === undefined || optional === undefined || target === null)
    return undefined;
  return {
    ...identity,
    resources: bounded,
    ...optional,
    ...(target === undefined ? {} : { targetSessionID: target }),
  };
}

/** `undefined` when absent, `null` when malformed (not a session id). */
function parseTargetSession(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" && SESSION_ID.test(value) ? value : null;
}

/** The optional request fields; `undefined` when any present one is malformed. */
function parseOptionalFields(
  record: Readonly<Record<string, unknown>>,
): Pick<OpenCodeNativePolicyRequest, "agent" | "source" | "searchPath" | "patchBytes"> | undefined {
  const agent = parseAgent(record.agent);
  const source = parseSource(record.source);
  const searchPath = parseSearchPath(record.searchPath);
  const patchBytes = parsePatchBytes(record.patchBytes);
  if (agent === null || source === null || searchPath === null || patchBytes === null)
    return undefined;
  return {
    ...(agent === undefined ? {} : { agent }),
    ...(source === undefined ? {} : { source }),
    ...(searchPath === undefined ? {} : { searchPath }),
    ...(patchBytes === undefined ? {} : { patchBytes }),
  };
}

/**
 * `undefined` when absent, `null` when malformed. The plugin reports an edit whose diff it could
 * not measure as `-1`, so a producer that changes its diff metadata is refused, never uncharged.
 */
function parsePatchBytes(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** `undefined` when absent, `null` when malformed (not a bounded string). */
function parseSearchPath(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= OPENCODE_NATIVE_POLICY_MAX_RESOURCE_CHARS
    ? value
    : null;
}

function parseIdentity(
  record: Readonly<Record<string, unknown>>,
): Pick<OpenCodeNativePolicyRequest, "runId" | "sessionID" | "permission"> | undefined {
  const { runId, sessionID, permission } = record;
  if (typeof runId !== "string" || !RUN_ID.test(runId)) return undefined;
  if (typeof sessionID !== "string" || !SESSION_ID.test(sessionID)) return undefined;
  if (typeof permission !== "string" || permission.length === 0 || permission.length > 64)
    return undefined;
  return { runId, sessionID, permission };
}

/** `undefined` for an absent agent, `null` for a malformed one. */
function parseAgent(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" && AGENT_ID.test(value) ? value : null;
}

function boundedResources(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > OPENCODE_NATIVE_POLICY_MAX_RESOURCES)
    return undefined;
  const resources: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length > OPENCODE_NATIVE_POLICY_MAX_RESOURCE_CHARS)
      return undefined;
    resources.push(entry);
  }
  return resources;
}

function parseSource(
  value: unknown,
): { readonly messageID: string; readonly id: string } | undefined | null {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value);
  if (record?.type !== "tool") return null;
  const { messageID, id } = record;
  return typeof messageID === "string" &&
    messageID.length > 0 &&
    messageID.length <= 128 &&
    typeof id === "string" &&
    CALL_ID.test(id)
    ? { messageID, id }
    : null;
}

export interface OpenCodeNativePolicyInput {
  readonly mode: unknown;
  readonly workspaceRoot: string;
  /**
   * The run-private directory where OpenCode's plan agent keeps its plan (`~/.opencode/plan` under
   * the run's private home), derived by the server, never by the runtime. Reads and edits there are
   * admitted like workspace paths; absent, only the workspace is admitted.
   */
  readonly planRoot?: string | undefined;
  /**
   * The operator's accepted external references for this run (#3900 AC5,
   * `opencodeNativeExternalRoots.ts`), the same roots the kernel allowlist reads. Absent, nothing
   * outside the workspace and the plan directory is admitted.
   */
  readonly externalRoots?: readonly string[] | undefined;
  readonly request: OpenCodeNativePolicyRequest;
  readonly nowMs: number;
  /**
   * The MCP tools the operator's registry admits for this run (#3903, parity row C04), derived by
   * the server: the action each tool reaches the policy under, with its declared risk and transport.
   * A tool, or a resource of a server, that it does not name stays an unsupported action.
   */
  readonly mcp?: OpenCodeNativeMcpGrants | undefined;
}

export interface OpenCodeNativeMcpGrants {
  readonly actions: ReadonlyMap<string, { readonly risk: McpToolRisk; readonly remote: boolean }>;
  readonly servers: ReadonlyMap<string, { readonly remote: boolean }>;
}

export function decideOpenCodeNativePolicy(
  input: OpenCodeNativePolicyInput,
): OpenCodeNativePolicyDecision {
  const { request } = input;
  if (!isCodingWorkbenchMode(input.mode))
    return deny("mode-denied", "Keiko refused this action: the run's autonomy mode is unknown.");
  const classification =
    classifyMcpAction(request, input.mcp) ?? classifyNativeAction(request, admittedRootsOf(input));
  if ("reason" in classification) return deny(classification.reason, classification.message);
  // Reads and planning are allowed in every mode (ADR-0124 D1); only effects consult the matrix.
  if (alwaysAllowedRead(classification)) return { effect: "allow", classification };
  // Below Full access the sandbox has no route beyond this machine, and customer networks are often
  // firewalled anyway: refuse at once with a clear reason instead of an approval the kernel would
  // then block (#3897), so the agent continues with local files and tools.
  if (classification.scope === "internet" && input.mode !== "autonomous-delivery")
    return deny(
      "mode-denied",
      "Keiko refused this action: internet access is only available in Full access, and this run has no route outside the machine. Continue with the local files and tools.",
    );
  const effect = codingWorkbenchPolicyEffectFor(
    input.mode,
    classification.scope,
    classification.risk,
  );
  if (effect === "allowed") return { effect: "allow", classification };
  if (effect === "denied")
    return {
      effect: "deny",
      reason: "mode-denied",
      message: `Keiko refused this action: ${classification.label} is not permitted in the current autonomy mode.`,
      classification,
    };
  return {
    effect: "ask",
    classification,
    event: askEvent(request, classification, input.nowMs),
    actionId:
      request.source === undefined ? undefined : `${request.sessionID}:${request.source.id}`,
  };
}

function admittedRootsOf(input: OpenCodeNativePolicyInput): AdmittedRoots {
  return {
    workspaceRoot: input.workspaceRoot,
    planRoot: input.planRoot,
    externalRoots: input.externalRoots ?? [],
  };
}

// Reads and planning in the workspace are allowed in every mode (ADR-0124 D1); a read of an
// accepted external reference is an `external-file` action the mode decides (#3900 AC5).
function alwaysAllowedRead(classification: OpenCodeNativeActionClassification): boolean {
  return (
    classification.actionClass === "workspace-read" && classification.scope !== "external-file"
  );
}

type Classified =
  | OpenCodeNativeActionClassification
  | { readonly reason: OpenCodeNativePolicyDenyReason; readonly message: string };

interface AdmittedRoots {
  readonly workspaceRoot: string;
  readonly planRoot?: string | undefined;
  readonly externalRoots?: readonly string[] | undefined;
}

function classifyNativeAction(
  request: OpenCodeNativePolicyRequest,
  roots: AdmittedRoots,
): Classified {
  const { permission, resources } = request;
  if (permission === OPENCODE_CODE_MODE_SESSION_MOVE)
    return classifySessionMove(request, roots.workspaceRoot);
  if (permission === OPENCODE_CODE_MODE_WORKTREE_CREATE) return classifyWorktreeCreate(request);
  if (!KNOWN_ACTIONS.has(permission))
    return {
      reason: "unsupported-action",
      message: "Keiko refused this action: it is not a classified OpenCode action.",
    };
  const pathAction = classifyPathAction(request, roots);
  if (pathAction !== undefined) return pathAction;
  if (EGRESS_ACTIONS.has(permission)) return EGRESS;
  if (permission === "shell") return classifyShell(resources);
  return EXECUTE;
}

/**
 * Code Mode's `session_move` (#3903 AC4): the run's own session may change its working directory to
 * an existing directory inside the task workspace, named by its absolute, normalized path with no
 * symbolic link on the way. That is navigation inside the workspace, so it is a read in every mode;
 * the run's session tree then follows the session (`admitNativeSessionLocation`). Moving another
 * session, or to any other place, stays refused.
 */
function classifySessionMove(
  request: OpenCodeNativePolicyRequest,
  workspaceRoot: string,
): Classified {
  const target = request.targetSessionID ?? request.sessionID;
  if (target !== request.sessionID)
    return {
      reason: "unsupported-action",
      message: "Keiko refused this action: a session may move only its own working directory.",
    };
  const [directory, ...rest] = request.resources;
  if (directory === undefined || rest.length > 0 || resolve(directory) !== directory)
    return {
      reason: "unsupported-action",
      message:
        "Keiko refused this action: name one directory inside the task workspace by its absolute path.",
    };
  const guarded = guardedPaths([directory], { workspaceRoot }, READ);
  if ("reason" in guarded) return guarded;
  return openCodeNativeSessionMoveDirectory(directory, workspaceRoot) === undefined
    ? {
        reason: "workspace-escape",
        message:
          "Keiko refused this action: the target is not an existing directory inside the task workspace.",
      }
    : guarded;
}

/**
 * Code Mode's `worktree_create` (#3903 AC4): a new branch and worktree of the repository, so a
 * delivery-scoped action the human decides in every mode. An approved one is provisioned by the
 * managed task-workspace owner (`opencodeNativeWorktree.ts`), never by the producer's own git call.
 */
const NATIVE_WORKTREE: OpenCodeNativeActionClassification = Object.freeze({
  actionClass: "workspace-write",
  kind: "workspace-write",
  scope: "delivery",
  risk: "high",
  label: "native-edit",
});

function classifyWorktreeCreate(request: OpenCodeNativePolicyRequest): Classified {
  const [name, ...rest] = request.resources;
  return name !== undefined && rest.length === 0 && WORKTREE_NAME.test(name)
    ? NATIVE_WORKTREE
    : {
        reason: "unsupported-action",
        message:
          "Keiko refused this action: name the new task workspace with letters, digits, dots, dashes or underscores (at most 64 characters).",
      };
}

/**
 * `directory` when it is an existing directory inside the workspace that no symbolic link reaches:
 * its physical path is the workspace's physical path plus the same relative path.
 */
function openCodeNativeSessionMoveDirectory(
  directory: string,
  workspaceRoot: string,
): string | undefined {
  const contained = workspaceRelative(directory, workspaceRoot);
  if (contained === undefined || !isAbsolute(directory)) return undefined;
  const physical = physicalPathIfPresent(directory);
  if (physical === undefined || !statSync(physical).isDirectory()) return undefined;
  return physical === join(realpathSync(workspaceRoot), contained) ? directory : undefined;
}

function physicalPathIfPresent(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

const MCP_RESOURCE_ACTIONS = new Set(["opencode_list_mcp_resources", "opencode_read_mcp_resource"]);
// A local MCP server is a process Keiko starts in the run's sandbox: its read tools are a vetted
// command, its write tools a risky one. A remote server is internet use, whatever the tool says.
const MCP_LOCAL_READ: OpenCodeNativeActionClassification = Object.freeze({
  actionClass: "command-execution",
  kind: "command-execution",
  scope: "workspace-contained",
  risk: "low",
  label: "native-mcp",
});
const MCP_LOCAL_WRITE: OpenCodeNativeActionClassification = Object.freeze({
  ...MCP_LOCAL_READ,
  risk: "high",
});
const MCP_REMOTE: OpenCodeNativeActionClassification = Object.freeze({
  actionClass: "network-egress",
  kind: "network-egress",
  scope: "internet",
  risk: "medium",
  label: "native-mcp",
});

/**
 * An MCP tool or resource action the registry admits, or undefined to fall through to the native
 * classification (which refuses what it does not know). A resource action names its servers in its
 * resources (`probe`, or `probe:<uri>` for a read); every one must be admitted.
 */
function classifyMcpAction(
  request: OpenCodeNativePolicyRequest,
  mcp: OpenCodeNativeMcpGrants | undefined,
): OpenCodeNativeActionClassification | undefined {
  if (mcp === undefined) return undefined;
  const grant = mcp.actions.get(request.permission);
  if (grant !== undefined) {
    if (grant.remote) return MCP_REMOTE;
    return grant.risk === "write" ? MCP_LOCAL_WRITE : MCP_LOCAL_READ;
  }
  if (!MCP_RESOURCE_ACTIONS.has(request.permission) || request.resources.length === 0)
    return undefined;
  const servers = request.resources.map((resource) =>
    mcp.servers.get(resource.split(":")[0] ?? ""),
  );
  if (servers.includes(undefined)) return undefined;
  return servers.some((server) => server?.remote === true) ? MCP_REMOTE : MCP_LOCAL_READ;
}

const READ: OpenCodeNativeActionClassification = Object.freeze({
  actionClass: "workspace-read",
  kind: "workspace-write",
  scope: "workspace-contained",
  risk: "low",
  label: "native-read",
});
/** A read in an accepted external reference: decided by the mode's `external-file` row. */
const EXTERNAL_READ: OpenCodeNativeActionClassification = Object.freeze({
  ...READ,
  scope: "external-file",
});
const EDIT: OpenCodeNativeActionClassification = Object.freeze({
  actionClass: "workspace-write",
  kind: "workspace-write",
  scope: "workspace-contained",
  risk: "medium",
  label: "native-edit",
});
const EGRESS: OpenCodeNativeActionClassification = Object.freeze({
  actionClass: "network-egress",
  kind: "network-egress",
  scope: "internet",
  risk: "medium",
  label: "native-egress",
});
const EXECUTE: OpenCodeNativeActionClassification = Object.freeze({
  actionClass: "command-execution",
  kind: "command-execution",
  scope: "workspace-contained",
  risk: "high",
  label: "native-execute",
});
const SHELL_VETTED: OpenCodeNativeActionClassification = Object.freeze({
  actionClass: "command-execution",
  kind: "command-execution",
  scope: "workspace-contained",
  risk: "low",
  label: "native-shell",
});
const SHELL_UNVETTED: OpenCodeNativeActionClassification = Object.freeze({
  ...SHELL_VETTED,
  risk: "high",
});

/**
 * Path resources of read and edit actions: OpenCode reports workspace-relative or absolute paths.
 * A path that leaves the workspace is a hard denial in every mode, and so is a path the shared
 * sensitive-path policy denies (`.env`, keys, credential stores, ADR-0129 D3).
 */
function guardedPaths(
  resources: readonly string[],
  roots: AdmittedRoots,
  classification: OpenCodeNativeActionClassification,
  loadsInstructions = false,
): Classified {
  for (const resource of resources) {
    const contained = admittedRelative(resource, roots);
    if (contained === undefined)
      return {
        reason: "workspace-escape",
        message: "Keiko refused this action: the path is outside the task workspace.",
      };
    if (contained.length > 0 && isDenied(contained))
      return {
        reason: "sensitive-path",
        message: "Keiko refused this action: the path is a protected sensitive file.",
      };
    if (linkedInWorkspace(resource, roots.workspaceRoot, loadsInstructions))
      return {
        reason: "linked-file",
        message:
          "Keiko refused this action: the file, or an AGENTS.md instruction file the read would load, is a hard link that can name a file outside the task workspace.",
      };
  }
  return classification;
}

/** The instruction file the producer's read tool loads from every directory it passes. */
const READ_INSTRUCTION_FILE = "AGENTS.md";

/**
 * A pathname names exactly one file only while that file has one link (PR #4064 review): a hard
 * link inside the workspace can alias a protected file or one outside it, and no pathname or
 * realpath check resolves it. An existing regular file a read or edit touches must therefore have
 * one link, and so must every `AGENTS.md` between a read target and the workspace root, which the
 * producer's read tool loads as instructions without asking. The kernel refuses a sandboxed link to
 * a file the run may not read, so such an alias can only predate the run.
 */
function linkedInWorkspace(
  resource: string,
  workspaceRoot: string,
  instructions: boolean,
): boolean {
  const contained = workspaceRelative(resource, workspaceRoot);
  if (contained === undefined) return false;
  const root = resolve(workspaceRoot);
  const target = resolve(root, contained);
  const stat = lstatIfPresent(target);
  if (multiplyLinked(stat)) return true;
  if (!instructions) return false;
  let directory = stat?.isDirectory() === true ? target : dirname(target);
  while (!relative(root, directory).startsWith("..")) {
    if (multiplyLinked(lstatIfPresent(join(directory, READ_INSTRUCTION_FILE)))) return true;
    if (directory === root) return false;
    directory = dirname(directory);
  }
  return false;
}

function multiplyLinked(stat: Stats | undefined): boolean {
  return stat?.isFile() === true && stat.nlink > 1;
}

/** The path-bearing actions; `undefined` for every other action. */
function classifyPathAction(
  request: OpenCodeNativePolicyRequest,
  roots: AdmittedRoots,
): Classified | undefined {
  const { permission, resources } = request;
  if (permission === "external_directory") return externalDirectory(resources, roots);
  // A glob/grep resource is a search pattern (`/api/users`, `*.pem`), not a path: only the searched
  // directory is a path, and the kernel boundary keeps credential files unreadable regardless.
  if (SEARCH_ACTIONS.has(permission)) {
    const searched = request.searchPath === undefined ? [] : [request.searchPath];
    return externalRead(searched, roots) ?? guardedPaths(searched, roots, READ);
  }
  if (READ_ACTIONS.has(permission))
    return (
      externalRead(resources, roots) ??
      guardedPaths(resources, roots, READ, permission === "read" || permission === "list")
    );
  // The plan agent's notes live in the run's private plan directory, not in the workspace: writing
  // them is planning, allowed in every mode like a read (standalone OpenCode does not ask either).
  if (EDIT_ACTIONS.has(permission))
    return guardedPaths(resources, roots, onlyInPlanRoot(resources, roots) ? READ : EDIT);
  return undefined;
}

function onlyInPlanRoot(resources: readonly string[], roots: AdmittedRoots): boolean {
  const { planRoot } = roots;
  return (
    planRoot !== undefined &&
    resources.length > 0 &&
    resources.every((resource) => physicallyInPlanRoot(resource.trim(), planRoot))
  );
}

/**
 * A plan note is exempt from workspace-edit approval only when its path names a file physically
 * inside the plan directory (#3897 review): no existing component between the run's private state
 * and the target is a symbolic link, and an existing target is a regular file with one link. The
 * kernel's link-free rule on the plan directory keeps that true after this check.
 */
function physicallyInPlanRoot(target: string, planRoot: string): boolean {
  if (!isAbsolute(target) || workspaceRelative(target, planRoot) === undefined) return false;
  const trusted = dirname(dirname(dirname(planRoot)));
  const resolved = resolve(target);
  let current = trusted;
  for (const part of relative(trusted, resolved).split(sep)) {
    current = join(current, part);
    const stat = lstatIfPresent(current);
    if (stat === undefined) return true;
    if (stat.isSymbolicLink()) return false;
    const last = current === resolved;
    if (last ? !stat.isFile() || stat.nlink > 1 : !stat.isDirectory()) return false;
  }
  return true;
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

/** Relative to the workspace, or to the plan root for an absolute path inside it. */
function admittedRelative(resource: string, roots: AdmittedRoots): string | undefined {
  const inWorkspace = workspaceRelative(resource, roots.workspaceRoot);
  if (inWorkspace !== undefined || roots.planRoot === undefined) return inWorkspace;
  return isAbsolute(resource.trim()) ? workspaceRelative(resource, roots.planRoot) : undefined;
}

/**
 * OpenCode checks a directory outside the workspace before reading or editing in it. The run's plan
 * directory is admitted like the workspace, an accepted external reference as an external read
 * (#3900 AC5); every other external directory stays a hard denial.
 */
function externalDirectory(resources: readonly string[], roots: AdmittedRoots): Classified {
  const directories = resources.map((resource) => resource.trim().replace(/\/\*$/u, ""));
  const within = (root: string | undefined): boolean =>
    root !== undefined &&
    directories.length > 0 &&
    directories.every(
      (directory) => isAbsolute(directory) && workspaceRelative(directory, root) !== undefined,
    );
  if (within(roots.planRoot)) return READ;
  if ((roots.externalRoots ?? []).some((root) => within(root))) return EXTERNAL_READ;
  return {
    reason: "workspace-escape",
    message: "Keiko refused this action: files outside the task workspace are not accessible.",
  };
}

/**
 * A read or search inside one accepted external reference (#3900 AC5): an `external-file` read the
 * run's mode decides, with the same sensitive-path and hard-link refusals as inside the workspace.
 * `undefined` when a path is not inside one, so the workspace rules decide it.
 */
function externalRead(paths: readonly string[], roots: AdmittedRoots): Classified | undefined {
  const root = (roots.externalRoots ?? []).find(
    (candidate) =>
      paths.length > 0 &&
      paths.every(
        (path) => isAbsolute(path.trim()) && workspaceRelative(path, candidate) !== undefined,
      ),
  );
  if (root === undefined) return undefined;
  for (const path of paths) {
    const contained = workspaceRelative(path, root) ?? "";
    if (contained.length > 0 && isDenied(contained))
      return {
        reason: "sensitive-path",
        message: "Keiko refused this action: the path is a protected sensitive file.",
      };
    if (linkedInWorkspace(path, root, false))
      return {
        reason: "linked-file",
        message:
          "Keiko refused this action: the file is a hard link that can name a file outside the accepted reference.",
      };
  }
  return EXTERNAL_READ;
}

/** Workspace-relative POSIX path, or undefined when the resource points outside the workspace. */
/**
 * The workspace files an admitted native `edit` check names, workspace-relative as the runtime's
 * own diff names them; plan notes and anything outside the workspace are not workspace files.
 */
export function openCodeNativeEditFiles(
  request: Pick<OpenCodeNativePolicyRequest, "permission" | "resources">,
  workspaceRoot: string,
): readonly string[] {
  if (!EDIT_ACTIONS.has(request.permission)) return [];
  return request.resources.flatMap((resource) => {
    const file = workspaceRelative(resource, workspaceRoot);
    return file === undefined || file === "" ? [] : [file];
  });
}

export function workspaceRelative(resource: string, workspaceRoot: string): string | undefined {
  const candidate = resource.trim();
  if (candidate.includes("\0")) return undefined;
  const rel = isAbsolute(candidate) ? relative(workspaceRoot, candidate) : candidate;
  const posix = rel.split(sep).join("/");
  if (posix === "" || posix === ".") return "";
  if (isAbsolute(posix) || posix === ".." || posix.startsWith("../") || posix.startsWith("/"))
    return undefined;
  const segments = posix.split("/");
  if (segments.includes("..")) return undefined;
  return posix;
}

/**
 * A reserved Git or gh invocation at a command position anywhere in the text: the start, after a
 * list operator, `(` or a backtick, or inside a quoted string that a shell or interpreter executes
 * (`sh -c "git push"`, `node -e "…execSync('git push')"`, `eval "git push"`). A quoted mention passed
 * to an ordinary program (`grep -rn "git push" docs`) is data, not a command. Each fragment is read
 * by the same tokenizer as a plain segment, so the scan stays linear in the command.
 */
function reservedInvocationInText(command: string): boolean {
  let start = 0;
  let opener = "";
  for (let index = 0; index <= command.length; index += 1) {
    const char = command.charAt(index);
    if (index < command.length && !COMMAND_DELIMITERS.has(char)) continue;
    const fragment = command.slice(start, index);
    if (executedFragment(opener, command.slice(0, Math.max(0, start - 1))))
      if (reservedTokens(commandTokens(fragment))) return true;
    opener = char;
    start = index + 1;
  }
  return false;
}

const COMMAND_DELIMITERS = new Set([";", "&", "|", "(", "`", "'", '"']);
const QUOTES = new Set(["'", '"']);
const EXECUTING_PREFIX = /(?:(?:^|\s)-[A-Za-z]*[ce]|\(|(?:^|\s)(?:eval|exec|xargs))\s*$/u;

function executedFragment(opener: string, before: string): boolean {
  return !QUOTES.has(opener) || EXECUTING_PREFIX.test(before);
}

/** Read-only forms of otherwise reserved Git subcommands stay available (status-like listings). */
const READ_ONLY_BRANCH_FLAGS = new Set([
  "--show-current",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
  "-l",
  "--list",
  "--no-color",
  "--color",
]);

const READ_ONLY_GIT_FORMS: Readonly<Record<string, (args: readonly string[]) => boolean>> = {
  branch: (args) => args.every((arg) => READ_ONLY_BRANCH_FLAGS.has(arg)),
  stash: ([first]) => first === "list" || first === "show",
  remote: (args) =>
    args.every((arg) => arg === "-v" || arg === "--verbose") || args[0] === "get-url",
  tag: ([first]) => first === undefined || first === "-l" || first === "--list",
  worktree: ([first]) => first === "list",
  submodule: ([first]) => first === "status",
};

function isReadOnlyGitForm(subcommand: string, args: readonly string[]): boolean {
  const form = Object.hasOwn(READ_ONLY_GIT_FORMS, subcommand)
    ? READ_ONLY_GIT_FORMS[subcommand]
    : undefined;
  return form?.(args) === true;
}

function reservedTokens(tokens: readonly string[]): boolean {
  const [program] = tokens;
  const subcommand = subcommandOf(tokens);
  if (subcommand === undefined) return false;
  if (program === "gh") return RESERVED_GH_SUBCOMMANDS.has(subcommand);
  if (program !== "git" || !RESERVED_GIT_SUBCOMMANDS.has(subcommand)) return false;
  return !isReadOnlyGitForm(subcommand, tokens.slice(tokens.indexOf(subcommand) + 1));
}

/**
 * OpenCode reports one resource per simple command of a shell line (`npm test && git push` arrives
 * as two), so every resource is classified on its own: any reserved delivery command refuses the
 * whole line, and the line is vetted only when every command in it is (#3897 audit).
 */
function classifyShell(resources: readonly string[]): Classified {
  const commands = resources.map((resource) => resource.trim()).filter((r) => r.length > 0);
  if (commands.length === 0) return SHELL_UNVETTED;
  if (commands.some((command) => isReservedCommand(command) || reservedInvocationInText(command)))
    return {
      reason: "delivery-reserved",
      message: OPENCODE_NATIVE_DELIVERY_REFUSAL_MESSAGE,
    };
  return commands.every((command) => commandSegments(command).every(isVettedSegment))
    ? SHELL_VETTED
    : SHELL_UNVETTED;
}

function isReservedCommand(command: string): boolean {
  return commandSegments(command).some((segment) => reservedTokens(commandTokens(segment)));
}

function askEvent(
  request: OpenCodeNativePolicyRequest,
  classification: OpenCodeNativeActionClassification,
  nowMs: number,
): SidecarPermissionEvent {
  const requestId = projectOpenCodePermissionRequestId(`per_${randomBytes(16).toString("hex")}`);
  if (requestId === undefined) throw new Error("native-policy-request-id-invalid");
  return {
    type: "permission-request",
    requestId,
    kind: classification.kind,
    actionClass:
      classification.actionClass === "workspace-read"
        ? "workspace-write"
        : classification.actionClass,
    reasonCode: "approval-required",
    expiresAt: new Date(nowMs + GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS).toISOString(),
    scopeLabel: classification.scope === "internet" ? "network-egress" : "workspace-scope",
    risk: classification.risk,
    policyReason: "approval-required",
    ...(classification.kind === "command-execution" ? { commandLabel: classification.label } : {}),
    nativeAction: { permission: request.permission, resources: request.resources },
  };
}

function deny(
  reason: OpenCodeNativePolicyDenyReason,
  message: string,
): OpenCodeNativePolicyDecision {
  return { effect: "deny", reason, message };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/** Body-free: the action name and its closed disposition, never a path, command or URL. */
export const CODING_RUNTIME_NATIVE_POLICY_DECIDED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.native-policy.decided",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeNativePolicy.recordOpenCodeNativePolicyDecision",
  fields: {
    mode: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["governed-assist", "supervised-coding", "autonomous-delivery", "unknown"],
    },
    permission: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "read",
        "glob",
        "grep",
        "list",
        "edit",
        "shell",
        "webfetch",
        "websearch",
        "skill",
        "subagent",
        "question",
        "todowrite",
        "execute",
        "external_directory",
        "doom_loop",
        "opencode_session_move",
        "opencode_worktree_create",
        "mcp",
        "other",
      ],
    },
    effect: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["allow", "deny", "ask"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "allowed",
        "mode-denied",
        "unsupported-action",
        "workspace-escape",
        "sensitive-path",
        "linked-file",
        "delivery-reserved",
        "approved",
        "denied",
        "expired",
        "cancelled",
        "unavailable",
        "authority-refused",
      ],
    },
    sessionRelation: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["primary", "child"],
    },
    // #3903 AC4: how an approved Code Mode `worktree_create` ended at the managed owner.
    worktree: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["provisioned", "resumed", "unavailable", "workspace-changed", "provision-failed"],
    },
    risk: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["low", "medium", "high", "critical"],
    },
    resourceCount: { type: "integer", dataClass: "count", required: true },
    resourceDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    requestId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    // Why the live authority refused an allowed effect (outcome `authority-refused`): the budget,
    // an expired or revoked envelope, a class outside it, a drifted binding, or no owner at all.
    authorityReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "authority-budget-exceeded",
        "authority-expired",
        "revoked",
        "authority-resolution-failed",
        "action-not-authorized",
        "drift",
        "unavailable",
        "other",
      ],
    },
    // How an admitted check was accounted against the run's tool-call budget: the invocation's
    // call reserved now, found reserved by an earlier check of the same invocation, or a check
    // that names no tool invocation and was charged on its own.
    invocationCharge: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["charged", "already-charged", "per-check"],
    },
    // The UTF-8 size of the producer's diff for a proposed edit, charged to the patch budget.
    patchBytes: { type: "integer", dataClass: "count", required: false },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-native-policy"],
  proofIds: ["coding-runtime.native-policy.decided.emitted-line"],
  releaseImpact: "minor",
});

export type OpenCodeNativePolicyOutcome =
  | "allowed"
  | OpenCodeNativePolicyDenyReason
  | "approved"
  | "denied"
  | "expired"
  | "cancelled"
  | "unavailable"
  | "authority-refused";

/** The native session that asked: the run's own session or an admitted child session (#3897). */
export type OpenCodeNativeSessionRelation = "primary" | "child";

/** The live authority's answer to an allowed effect: how it was charged, or why it was refused. */
export interface OpenCodeNativeAuthorityEvidence {
  readonly charge?: CodingToolNativeCharge | undefined;
  readonly reason?: string | undefined;
}

type NativeAuthorityReasonLog =
  | "authority-budget-exceeded"
  | "authority-expired"
  | "revoked"
  | "authority-resolution-failed"
  | "action-not-authorized"
  | "drift"
  | "unavailable"
  | "other";

/** The closed log word of a refusal reason; every binding drift is one word, anything else `other`. */
export function nativeAuthorityReasonLogValue(reason: string): NativeAuthorityReasonLog {
  switch (reason) {
    case "authority-budget-exceeded":
    case "authority-expired":
    case "revoked":
    case "authority-resolution-failed":
    case "action-not-authorized":
    case "unavailable":
      return reason;
    default:
      return reason.endsWith("-drift") ? "drift" : "other";
  }
}

function authorityEvidenceFields(authority: OpenCodeNativeAuthorityEvidence | undefined): {
  readonly invocationCharge?: CodingToolNativeCharge;
  readonly authorityReason?: NativeAuthorityReasonLog;
} {
  return {
    ...(authority?.charge === undefined ? {} : { invocationCharge: authority.charge }),
    ...(authority?.reason === undefined
      ? {}
      : { authorityReason: nativeAuthorityReasonLogValue(authority.reason) }),
  };
}

export function recordOpenCodeNativePolicyDecision(
  sink: ServerLogSink,
  runId: string,
  input: {
    readonly mode: unknown;
    readonly request: OpenCodeNativePolicyRequest;
    readonly decision: OpenCodeNativePolicyDecision;
    readonly outcome: OpenCodeNativePolicyOutcome;
    readonly sessionRelation?: OpenCodeNativeSessionRelation | undefined;
    readonly authority?: OpenCodeNativeAuthorityEvidence | undefined;
    readonly worktree?: NativeWorktreeDisposition | undefined;
  },
): void {
  const { request, decision } = input;
  const risk = decision.classification?.risk;
  const requestId = decision.effect === "ask" ? decision.event.requestId : undefined;
  sink.write(
    activityLogEvent(
      CODING_RUNTIME_NATIVE_POLICY_DECIDED_OPERATION,
      { correlationId: runId, level: decision.effect === "deny" ? "warn" : "info" },
      {
        mode: isCodingWorkbenchMode(input.mode) ? input.mode : "unknown",
        permission: loggedPermission(request, decision),
        effect: decision.effect,
        outcome: input.outcome,
        ...(input.sessionRelation === undefined ? {} : { sessionRelation: input.sessionRelation }),
        ...(risk === undefined ? {} : { risk }),
        resourceCount: request.resources.length,
        resourceDigest: createHash("sha256")
          .update(JSON.stringify(request.resources), "utf8")
          .digest("hex"),
        ...(requestId === undefined ? {} : { requestId }),
        ...(request.patchBytes === undefined ? {} : { patchBytes: request.patchBytes }),
        ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
        ...authorityEvidenceFields(input.authority),
      },
    ),
  );
}
