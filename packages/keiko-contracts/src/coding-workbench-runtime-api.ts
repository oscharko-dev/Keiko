import { validatePhysicalArrayEntries } from "./contract-validation-primitives.js";
import {
  CODING_WORKBENCH_MODEL_SOURCES,
  CODING_WORKBENCH_MODES,
  CODING_WORKBENCH_OPERATOR_DECISIONS,
  CODING_WORKBENCH_RUNTIME_SOURCES,
  isCodingWorkbenchModeWidening,
  resolveEffectiveCodingWorkbenchMode,
  type CodingWorkbenchAuxiliaryStatus,
  type CodingWorkbenchContentTrust,
  type CodingWorkbenchModelSource,
  type CodingWorkbenchOperatorDecision,
  type CodingWorkbenchMode,
  type CodingWorkbenchPermissionRequest,
  type CodingWorkbenchRuntimeEventKind,
  type CodingWorkbenchRuntimeSource,
  type CodingWorkbenchValidationResult,
  type CodingWorkbenchVerificationSummary,
  type CodingWorkbenchNativeRetry,
} from "./coding-workbench.js";
import { validateCodingWorkbenchPermissionRequest } from "./coding-workbench-validation.js";
import {
  exactKeys,
  invalid,
  isOneOf,
  isRecord,
  sseEventKeys,
  validateSafeId,
  validateSseEventFields,
  validateStrictUtcInstant,
  validateUntrustedDisplayText,
} from "./coding-workbench-runtime-api-validation.js";
import {
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  CODING_WORKBENCH_RUNTIME_FAILURE_CODES,
  CODING_WORKBENCH_RUNTIME_STATE_NAMES,
  type CodingWorkbenchIssueBinding,
  type CodingWorkbenchRuntimeFailureCode,
  type CodingWorkbenchRuntimeStateName,
} from "./coding-workbench-runtime.js";
import type {
  CodingWorkbenchGatewayEventKind,
  CodingWorkbenchTurnFailureCode,
} from "./coding-workbench-runtime-constants.js";
import { MODEL_REASONING_EFFORTS, type ModelReasoningEffort } from "./gateway.js";
export {
  CODING_WORKBENCH_GATEWAY_EVENT_KINDS,
  type CodingWorkbenchGatewayEventKind,
  type CodingWorkbenchTurnFailureCode,
} from "./coding-workbench-runtime-constants.js";
import { validateCodingWorkbenchIssueBinding } from "./coding-workbench-issue-binding.js";
export { CODING_WORKBENCH_ISSUE_NUMBER_MAX } from "./coding-workbench-issue-binding.js";
import { GITHUB_ISSUE_REFERENCE_MAX_CHARS } from "./github-issue-reference.js";
import { isVerifiedCommitResult, type VerifiedCommitResult } from "./verified-commit.js";
import { isDraftDeliveryRecord, type DraftDeliveryRecord } from "./draft-delivery.js";
import { isReadinessSnapshot, type ReadinessSnapshot } from "./git-ci-readiness.js";
import {
  isWorkbenchDescriptionStatus,
  type WorkbenchDescriptionStatus,
} from "./workbench-description-status.js";

/** Browser-level preference, deliberately not an adapter, model, profile, or endpoint selector. */
export type CodingWorkbenchRuntimePreference = "managed-gateway" | "codex-subscription";

export const CODING_WORKBENCH_RUNTIME_PREFERENCES: readonly CodingWorkbenchRuntimePreference[] =
  Object.freeze(["managed-gateway", "codex-subscription"] as const);

/**
 * The built-in primary agents an operator may select for a Coding Workbench turn, as in standalone
 * OpenCode (Tab switches between them). `build` is the default agent every run starts under; `plan`
 * is OpenCode's own read-only agent: its shipped policy denies edits except its own plan file, so
 * it narrows what the turn may do and never widens authority.
 */
export type CodingWorkbenchBuiltInAgent = "build" | "plan";

export const CODING_WORKBENCH_AGENTS: readonly CodingWorkbenchBuiltInAgent[] = Object.freeze([
  "build",
  "plan",
] as const);

/**
 * The primary agent a turn runs under: a built-in, or on the native profile a custom primary agent
 * the run's runtime lists right now (#3903 AC1), a repository or configured agent whose mode is
 * `primary` or `all`. A custom one is named by its bounded agent name and the server confirms it
 * against the run's live listing before it switches; the run's mode still decides every action.
 * The intersection keeps the built-in names as literals beside every other name.
 */
export type CodingWorkbenchAgent = CodingWorkbenchBuiltInAgent | (string & Record<never, never>);

/** The agent every run starts under and the one an absent `agent` field means. */
export const DEFAULT_CODING_WORKBENCH_AGENT: CodingWorkbenchBuiltInAgent = "build";

export function isCodingWorkbenchBuiltInAgent(
  value: unknown,
): value is CodingWorkbenchBuiltInAgent {
  return isOneOf(value, CODING_WORKBENCH_AGENTS);
}

// Names a custom primary agent can never carry: the runtime's built-in subagents and hidden agents,
// and any spelling of a built-in primary agent other than its own. Selecting one of them as the
// primary agent is never a choice the runtime offers (#3897).
const CODING_WORKBENCH_RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set([
  "build",
  "plan",
  "general",
  "explore",
  "compaction",
  "title",
  "summary",
]);

/**
 * A built-in agent, or a well-formed custom primary agent name that no built-in or reserved agent
 * carries in any spelling. Whether such an agent exists is the run's own live listing.
 */
export function isCodingWorkbenchAgent(value: unknown): value is CodingWorkbenchAgent {
  if (isCodingWorkbenchBuiltInAgent(value)) return true;
  return (
    isCodingWorkbenchMentionName(value) &&
    !CODING_WORKBENCH_RESERVED_AGENT_NAMES.has(value.toLowerCase())
  );
}

/**
 * How a message sent WHILE a turn runs reaches the run's session, as in standalone OpenCode
 * (`POST /api/session/{sessionID}/prompt`, `delivery`). `steer` injects it into the running turn at
 * its next step boundary; `queue` delivers it after the turn's current work. A closed vocabulary:
 * the browser cannot name an arbitrary OpenCode delivery mode. Absent means an ordinary follow-up.
 */
export type CodingWorkbenchPromptDelivery = "steer" | "queue";

export const CODING_WORKBENCH_PROMPT_DELIVERIES: readonly CodingWorkbenchPromptDelivery[] =
  Object.freeze(["steer", "queue"] as const);

export function isCodingWorkbenchPromptDelivery(
  value: unknown,
): value is CodingWorkbenchPromptDelivery {
  return isOneOf(value, CODING_WORKBENCH_PROMPT_DELIVERIES);
}

/**
 * A workspace file the human attached to a prompt with `@`. The browser names the file by its path
 * RELATIVE to the run's workspace root and never sends an absolute path or a URI: the server
 * resolves it against the run's own workspace, refuses anything that is not a plain, contained,
 * non-sensitive text file, and only then maps it to the runtime's attachment (ADR-0137 D10).
 */
export interface CodingWorkbenchPromptReference {
  readonly path: string;
}

/** At most this many files ride on one prompt. */
export const CODING_WORKBENCH_PROMPT_REFERENCES_MAX = 16;
export const CODING_WORKBENCH_PROMPT_REFERENCE_PATH_MAX_CHARS = 1024;
const CODING_WORKBENCH_PROMPT_REFERENCE_SEGMENT_MAX_CHARS = 255;
const DRIVE_LETTER_PREFIX = /^[A-Za-z]:/u;

function referenceSegmentAdmitted(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment.length <= CODING_WORKBENCH_PROMPT_REFERENCE_SEGMENT_MAX_CHARS &&
    segment !== "." &&
    segment !== ".."
  );
}

/**
 * Transport shape of one reference path, decided without touching a filesystem: a bounded POSIX
 * path relative to the workspace root, with no empty, `.` or `..` segment, no backslash, no control
 * character and no absolute or drive-letter spelling. Whether the path names a contained, readable
 * text file is the server's decision against the run's workspace.
 */
export function isCodingWorkbenchPromptReferencePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= CODING_WORKBENCH_PROMPT_REFERENCE_PATH_MAX_CHARS &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !DRIVE_LETTER_PREFIX.test(value) &&
    !containsControlCharacter(value) &&
    value.split("/").every(referenceSegmentAdmitted)
  );
}

export function parseCodingWorkbenchPromptReferences(
  value: unknown,
): CodingWorkbenchValidationResult<readonly CodingWorkbenchPromptReference[]> {
  if (!Array.isArray(value)) return invalid("references must be an array");
  const errors: string[] = [];
  const admitted = checkCodingWorkbenchPromptReferences(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function checkCodingWorkbenchPromptReferences(
  value: readonly unknown[],
  errors: string[],
): value is readonly CodingWorkbenchPromptReference[] {
  if (value.length === 0 || value.length > CODING_WORKBENCH_PROMPT_REFERENCES_MAX) {
    errors.push(
      `references must hold 1 to ${String(CODING_WORKBENCH_PROMPT_REFERENCES_MAX)} files`,
    );
  }
  const seen = new Set<string>();
  validatePhysicalArrayEntries(
    value,
    "references",
    errors,
    false,
    "must be an object",
    (entry, path, issues): boolean => {
      const memberErrors = referenceEntryErrors(entry, path, seen);
      issues.push(...memberErrors);
      return memberErrors.length === 0;
    },
  );
  return errors.length === 0;
}

function referenceEntryErrors(entry: unknown, path: string, seen: Set<string>): string[] {
  if (!isRecord(entry)) return [`${path} must be an object`];
  const errors = exactKeys(entry, ["path"], path);
  if (!isCodingWorkbenchPromptReferencePath(entry.path)) {
    errors.push(`${path}.path must be a bounded workspace-relative path`);
  } else if (seen.has(entry.path)) {
    errors.push(`${path}.path repeats an earlier reference`);
  } else {
    seen.add(entry.path);
  }
  return errors;
}

/**
 * A slash command a native run offers, as the runtime lists it (`GET /api/command`, ADR-0137 D10):
 * the name the operator types after `/` and the one-line description the runtime gives it. Both are
 * untrusted display text from the runtime, bounded here so a hostile or malformed listing can never
 * reach the browser unbounded. A command is a server-authored prompt template; naming one grants
 * nothing, and every effect it causes still passes the run's own policy.
 */
export interface CodingWorkbenchCommand {
  readonly name: string;
  readonly description?: string | undefined;
}

/** At most this many commands ride one listing. */
export const CODING_WORKBENCH_COMMANDS_MAX = 64;
export const CODING_WORKBENCH_COMMAND_NAME_MAX_CHARS = 64;
export const CODING_WORKBENCH_COMMAND_DESCRIPTION_MAX_CHARS = 200;
const CODING_WORKBENCH_COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

/**
 * The commands every native run starts with: the runtime's own built-ins (`init`, guided AGENTS.md
 * setup, and `review`, review of the changes), pinned by the original-runtime proof. They let the
 * composer of a new task offer a `/` menu before any run, and so any runtime, exists to list
 * commands; the run's own listing stays the authority once it does.
 */
export const CODING_WORKBENCH_BUILT_IN_COMMAND_NAMES: readonly string[] = Object.freeze([
  "init",
  "review",
]);

/** Transport shape of a command name: bounded, no whitespace, no path or control character. */
export function isCodingWorkbenchCommandName(value: unknown): value is string {
  return typeof value === "string" && CODING_WORKBENCH_COMMAND_NAME.test(value);
}

/**
 * The command a start or a follow-up names: only the name, never the template. The text after the
 * command is the request's `taskIntent`. Whether the run's runtime lists the name is the server's
 * decision when the turn is dispatched.
 */
export interface CodingWorkbenchCommandRequest {
  readonly name: string;
}

export function parseCodingWorkbenchCommandRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchCommandRequest> {
  if (!isRecord(value)) return invalid("command must be an object");
  const errors = exactKeys(value, ["name"], "command");
  const admitted = checkCodingWorkbenchCommandRequest(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function checkCodingWorkbenchCommandRequest(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchCommandRequest {
  if (!isCodingWorkbenchCommandName(value.name)) {
    errors.push("command.name must be a bounded command name");
  }
  return errors.length === 0;
}

function commandEntryErrors(entry: unknown, path: string, seen: Set<string>): string[] {
  if (!isRecord(entry)) return [`${path} must be an object`];
  const errors = exactKeys(entry, ["name", "description"], path);
  if (!isCodingWorkbenchCommandName(entry.name)) {
    errors.push(`${path}.name must be a bounded command name`);
  } else if (seen.has(entry.name)) {
    errors.push(`${path}.name repeats an earlier command`);
  } else {
    seen.add(entry.name);
  }
  if (
    entry.description !== undefined &&
    !validateUntrustedDisplayText(entry.description, CODING_WORKBENCH_COMMAND_DESCRIPTION_MAX_CHARS)
  ) {
    errors.push(`${path}.description must be bounded display text`);
  }
  return errors;
}

/**
 * The native agents and skills a prompt may mention (S15, #3906), as the run's runtime lists them:
 * `@name` names a subagent the runtime offers, `$id` one of its skills. An entry is the runtime's
 * own untrusted display text, bounded here like a command. Mentioning one asks the runtime to
 * involve it, exactly as its own interface does; it grants nothing, and every effect it causes
 * still passes the run's native policy.
 */
export interface CodingWorkbenchMentionableAgent {
  readonly name: string;
  readonly description?: string | undefined;
}

export interface CodingWorkbenchMentionableSkill {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
}

/**
 * The subagents every native run starts with (`general`, `explore`), pinned by the original-runtime
 * listing of 2.1.4. They let the composer of a new task offer `@` before any run exists to list
 * them; the run's own listing is the authority once it does, and the server confirms every mention.
 */
export const CODING_WORKBENCH_BUILT_IN_SUBAGENTS: readonly CodingWorkbenchMentionableAgent[] =
  Object.freeze([{ name: "general" }, { name: "explore" }]);

/** At most this many agents or skills ride one listing, and this many mentions one prompt. */
export const CODING_WORKBENCH_MENTIONABLES_MAX = 64;
export const CODING_WORKBENCH_PROMPT_MENTIONS_MAX = 8;
export const CODING_WORKBENCH_MENTION_DESCRIPTION_MAX_CHARS = 200;
const CODING_WORKBENCH_MENTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** Transport shape of an agent name or a skill id: bounded, no whitespace, path or control. */
export function isCodingWorkbenchMentionName(value: unknown): value is string {
  return typeof value === "string" && CODING_WORKBENCH_MENTION_NAME.test(value);
}

/**
 * Where a mention stands in the prompt's text, as the runtime records it: the half-open range
 * `[start, end)` of `text`, the token as typed (`@general`, `$review-method`).
 */
export interface CodingWorkbenchPromptMentionSpan {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface CodingWorkbenchAgentMention {
  readonly name: string;
  readonly mention?: CodingWorkbenchPromptMentionSpan | undefined;
}

export interface CodingWorkbenchSkillMention {
  readonly id: string;
  readonly mention?: CodingWorkbenchPromptMentionSpan | undefined;
}

/** The agents and skills a start or a follow-up mentions; whether the run lists them is the server's call. */
export interface CodingWorkbenchPromptMentions {
  readonly agents?: readonly CodingWorkbenchAgentMention[] | undefined;
  readonly skills?: readonly CodingWorkbenchSkillMention[] | undefined;
}

/** Bound of a mention span's offsets: the prompt text is bounded far below this. */
const MENTION_OFFSET_MAX = 1_000_000;

function isMentionOffset(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MENTION_OFFSET_MAX
  );
}

function mentionSpanErrors(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!isRecord(value)) return [`${path} must be an object`];
  const errors = exactKeys(value, ["start", "end", "text"], path);
  const { start, end, text } = value;
  if (!isMentionOffset(start) || !isMentionOffset(end) || end <= start) {
    errors.push(`${path} must be a bounded half-open range`);
  } else if (typeof text !== "string" || text.length !== end - start) {
    errors.push(`${path}.text must be the mentioned token`);
  }
  return errors;
}

function mentionListErrors(
  value: unknown,
  key: "agents" | "skills",
  field: "name" | "id",
): string[] {
  if (value === undefined) return [];
  const path = `mentions.${key}`;
  if (!Array.isArray(value)) return [`${path} must be an array`];
  const errors: string[] = [];
  if (value.length === 0 || value.length > CODING_WORKBENCH_PROMPT_MENTIONS_MAX) {
    errors.push(`${path} must hold 1 to ${String(CODING_WORKBENCH_PROMPT_MENTIONS_MAX)} entries`);
  }
  const seen = new Set<string>();
  validatePhysicalArrayEntries(
    value,
    path,
    errors,
    false,
    "must be an object",
    (entry, at, issues): boolean => {
      if (!isRecord(entry)) {
        issues.push(`${at} must be an object`);
        return false;
      }
      const before = issues.length;
      issues.push(...exactKeys(entry, [field, "mention"], at));
      const identity = entry[field];
      if (!isCodingWorkbenchMentionName(identity)) issues.push(`${at}.${field} is invalid`);
      else if (seen.has(identity)) issues.push(`${at}.${field} repeats an earlier mention`);
      else seen.add(identity);
      issues.push(...mentionSpanErrors(entry.mention, `${at}.mention`));
      return issues.length === before;
    },
  );
  return errors;
}

export function parseCodingWorkbenchPromptMentions(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchPromptMentions> {
  if (!isRecord(value)) return invalid("mentions must be an object");
  const errors = exactKeys(value, ["agents", "skills"], "mentions");
  const admitted = checkCodingWorkbenchPromptMentions(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function checkCodingWorkbenchPromptMentions(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchPromptMentions {
  if (value.agents === undefined && value.skills === undefined) {
    errors.push("mentions must name an agent or a skill");
  }
  errors.push(
    ...mentionListErrors(value.agents, "agents", "name"),
    ...mentionListErrors(value.skills, "skills", "id"),
  );
  return errors.length === 0;
}

function mentionableErrors(
  entry: unknown,
  path: string,
  keys: readonly string[],
  seen: Set<string>,
): string[] {
  if (!isRecord(entry)) return [`${path} must be an object`];
  const errors = exactKeys(entry, keys, path);
  const identity = keys[0] === "id" ? entry.id : entry.name;
  if (!isCodingWorkbenchMentionName(identity)) errors.push(`${path} identity is invalid`);
  else if (seen.has(identity)) errors.push(`${path} repeats an earlier entry`);
  else seen.add(identity);
  if (keys[0] === "id" && !validateUntrustedDisplayText(entry.name, 64)) {
    errors.push(`${path}.name must be bounded display text`);
  }
  if (
    entry.description !== undefined &&
    !validateUntrustedDisplayText(entry.description, CODING_WORKBENCH_MENTION_DESCRIPTION_MAX_CHARS)
  ) {
    errors.push(`${path}.description must be bounded display text`);
  }
  return errors;
}

function mentionablesErrors(
  value: unknown,
  key: "agents" | "primaryAgents" | "skills",
  keys: readonly string[],
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [`commandsChannelPayload.${key} must be an array`];
  const errors: string[] = [];
  if (value.length > CODING_WORKBENCH_MENTIONABLES_MAX) {
    errors.push(`${key} must hold at most ${String(CODING_WORKBENCH_MENTIONABLES_MAX)} entries`);
  }
  const seen = new Set<string>();
  validatePhysicalArrayEntries(
    value,
    key,
    errors,
    false,
    "must be an object",
    (entry, path, issues): boolean => {
      const memberErrors = mentionableErrors(entry, path, keys, seen);
      issues.push(...memberErrors);
      return memberErrors.length === 0;
    },
  );
  return errors;
}

/** Session facet of the commands channel: the status of the presented cookie only (ADR-0141). */
export const CODING_WORKBENCH_RUNTIME_COMMANDS_SESSION_STATES = ["active", "unpaired"] as const;

export type CodingWorkbenchRuntimeCommandsSession =
  (typeof CODING_WORKBENCH_RUNTIME_COMMANDS_SESSION_STATES)[number];

/**
 * `GET /runs/:runId/commands`: the commands the run's runtime lists right now. Absent `commands`
 * means the run offers none (a mapped profile, a run that is not live, or a listing the runtime
 * could not give). An unpaired caller receives the constant `{ session: "unpaired" }` regardless
 * of the run, so the route is not an existence oracle.
 */
export interface CodingWorkbenchRuntimeCommandsChannelPayload {
  readonly session: CodingWorkbenchRuntimeCommandsSession;
  readonly commands?: readonly CodingWorkbenchCommand[] | undefined;
  /** The subagents a prompt may mention with `@` (#3906); absent, the run offers none. */
  readonly agents?: readonly CodingWorkbenchMentionableAgent[] | undefined;
  /**
   * The custom primary agents the run may switch to beside `build` and `plan` (#3903 AC1), as the
   * runtime lists them; absent, it offers none.
   */
  readonly primaryAgents?: readonly CodingWorkbenchMentionableAgent[] | undefined;
  /** The skills a prompt may mention with `$` (#3906); absent, the run offers none. */
  readonly skills?: readonly CodingWorkbenchMentionableSkill[] | undefined;
}

export function unpairedCodingWorkbenchRuntimeCommandsChannelPayload(): CodingWorkbenchRuntimeCommandsChannelPayload {
  return { session: "unpaired" };
}

/** Exact keys, a valid session facet, a bounded duplicate-free listing, none when unpaired. */
export function validateCodingWorkbenchRuntimeCommandsChannelPayload(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeCommandsChannelPayload> {
  if (!isRecord(value)) return invalid("commands channel payload must be an object");
  const errors = exactKeys(
    value,
    ["session", "commands", "agents", "primaryAgents", "skills"],
    "commandsChannelPayload",
  );
  const admitted = checkCodingWorkbenchRuntimeCommandsChannelPayload(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function checkCodingWorkbenchRuntimeCommandsChannelPayload(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeCommandsChannelPayload {
  if (!isOneOf(value.session, CODING_WORKBENCH_RUNTIME_COMMANDS_SESSION_STATES)) {
    errors.push("commandsChannelPayload.session is invalid");
  }
  const listed = [value.commands, value.agents, value.primaryAgents, value.skills].some(
    (list) => list !== undefined,
  );
  if (value.session === "unpaired" && listed) {
    errors.push("commandsChannelPayload listings must be absent when the session is unpaired");
  }
  errors.push(
    ...(value.commands === undefined ? [] : commandListErrors(value.commands)),
    ...mentionablesErrors(value.agents, "agents", ["name", "description"]),
    ...mentionablesErrors(value.primaryAgents, "primaryAgents", ["name", "description"]),
    ...mentionablesErrors(value.skills, "skills", ["id", "name", "description"]),
  );
  return errors.length === 0;
}

function commandListErrors(commands: unknown): string[] {
  if (!Array.isArray(commands)) return ["commandsChannelPayload.commands must be an array"];
  const errors: string[] = [];
  if (commands.length > CODING_WORKBENCH_COMMANDS_MAX) {
    errors.push(`commands must hold at most ${String(CODING_WORKBENCH_COMMANDS_MAX)} entries`);
  }
  const seen = new Set<string>();
  validatePhysicalArrayEntries(
    commands,
    "commands",
    errors,
    false,
    "must be an object",
    (entry, path, issues): boolean => {
      const memberErrors = commandEntryErrors(entry, path, seen);
      issues.push(...memberErrors);
      return memberErrors.length === 0;
    },
  );
  return errors;
}

export const CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS = 128;
export const CODING_WORKBENCH_RUNTIME_MODEL_ID_MAX_CHARS = 200;
export const CODING_WORKBENCH_RUNTIME_SSE_CURSOR_MAX_CHARS = 128;

export interface CodingWorkbenchRuntimeReadinessRequest {
  readonly requestedMode: CodingWorkbenchMode;
}

/**
 * Closed, content-free reason vocabulary for `runtimeAvailable: false`. Codes name the first
 * failed activation prerequisite; they never carry paths, digests, or environment values.
 */
export type CodingWorkbenchRuntimeUnavailableReason =
  | "runtime-disabled"
  | "platform-unqualified"
  | "dev-lane-refused"
  | "payload-missing"
  | "payload-unapproved"
  | "payload-tampered"
  | "secure-read-unavailable"
  | "loopback-unavailable"
  | "runtime-unqualified";

export const CODING_WORKBENCH_RUNTIME_UNAVAILABLE_REASONS: readonly CodingWorkbenchRuntimeUnavailableReason[] =
  Object.freeze([
    "runtime-disabled",
    "platform-unqualified",
    "dev-lane-refused",
    "payload-missing",
    "payload-unapproved",
    "payload-tampered",
    "secure-read-unavailable",
    "loopback-unavailable",
    "runtime-unqualified",
  ] as const);

/**
 * How much evidence backs an AVAILABLE runtime. `platform-qualified` is the release-signed,
 * notarized/Authenticode-attested packaged artifact. `functional-not-platform-qualified` covers
 * every runtime whose integrity is proven by recomputed digests alone and that carries no platform
 * signature chain — the supported dev lane (ADR-0140) and the packaged evaluation lane (ADR-0163 D9).
 */
export type CodingWorkbenchRuntimeEvidenceClass =
  "platform-qualified" | "functional-not-platform-qualified";

export const CODING_WORKBENCH_RUNTIME_EVIDENCE_CLASSES: readonly CodingWorkbenchRuntimeEvidenceClass[] =
  Object.freeze(["platform-qualified", "functional-not-platform-qualified"] as const);

/** Content-free server authority and runtime-composition projection used before Start is enabled. */
export interface CodingWorkbenchRuntimeReadiness {
  readonly schemaVersion: typeof CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
  readonly requestedMode: CodingWorkbenchMode;
  readonly deploymentCeiling: CodingWorkbenchMode;
  readonly effectiveMode: CodingWorkbenchMode;
  readonly runtimeAvailable: boolean;
  /** Present exactly when `runtimeAvailable` is false; names the first failed prerequisite. */
  readonly runtimeUnavailableReason?: CodingWorkbenchRuntimeUnavailableReason | undefined;
  /**
   * Present exactly when `runtimeAvailable` is true. An available runtime must always say how
   * strong its evidence is: an absent field that read as "verified" would be a fail-open default
   * and would reproduce the green-readiness-over-an-unverified-runtime class (audit F-01).
   */
  readonly runtimeEvidenceClass?: CodingWorkbenchRuntimeEvidenceClass | undefined;
  /**
   * The primary agents this deployment's OpenCode tool profile can honour, computed server-side
   * (#3897). Always carries the default agent (`build`); `plan` is listed only where OpenCode runs
   * its own tools (the native profile), because a mapped profile would run a read-only request as
   * an editing agent. The browser offers an agent switch only for what is listed here, and the
   * server refuses (`invalid-intent`) any start or follow-up that names an agent outside it.
   */
  readonly selectableAgents: readonly CodingWorkbenchBuiltInAgent[];
  /**
   * What the composed OpenCode tool profile can do with a prompt's inputs, computed server-side
   * (#3897). Absent reads as nothing: the browser offers Send now, Queue and the `@` file picker
   * only where this says so, and the server refuses (`invalid-intent`) a follow-up that uses one
   * the run's runtime cannot honour, exactly as it refuses a `plan` request.
   */
  readonly promptInputs?: CodingWorkbenchRuntimePromptInputs | undefined;
  /**
   * The version facts of the activated runtime (#3904 AC4), only when it is available. Absent reads
   * as not reported, never as the pinned version: a server that cannot name the runtime it
   * verified must not let the browser claim one.
   */
  readonly runtimeVersion?: CodingWorkbenchRuntimeVersion | undefined;
}

/** Where the activated runtime came from (#3904 AC4); see `CodingWorkbenchRuntimeVersion`. */
export type CodingWorkbenchRuntimeOrigin =
  "portable-release" | "npm-runtime-package" | "dev-checkout";

export const CODING_WORKBENCH_RUNTIME_ORIGINS: readonly CodingWorkbenchRuntimeOrigin[] =
  Object.freeze(["portable-release", "npm-runtime-package", "dev-checkout"] as const);

/**
 * What runs and what this build expects (#3904 AC4). `opencode` is the version the verified
 * runtime's approved release metadata names; `pinned` is the version this Keiko build stages. They
 * differ while an earlier approved runtime package is still installed. A newer runtime arrives only
 * with a Keiko update; the runtime never updates itself.
 */
export interface CodingWorkbenchRuntimeVersion {
  readonly opencode: string;
  readonly pinned: string;
  readonly origin: CodingWorkbenchRuntimeOrigin;
}

/** The prompt inputs a runtime can honour; see `CodingWorkbenchRuntimeReadiness.promptInputs`. */
export interface CodingWorkbenchRuntimePromptInputs {
  /** A message may be sent while a turn runs, as `steer` or `queue`. */
  readonly delivery: boolean;
  /**
   * Workspace files may be referenced with `@` and attached to a prompt: to a follow-up and, as the
   * run's workspace is resolved when its first turn is dispatched, to the start.
   */
  readonly references: boolean;
  /**
   * A turn may be started by one of the runtime's slash commands (`/init`, `/review`): a start or
   * a follow-up may carry `command`. Absent reads as false, like any prompt input an older server
   * never offered.
   */
  readonly commands?: boolean | undefined;
  /**
   * A prompt may mention the runtime's subagents with `@` and its skills with `$` (S15, #3906): a
   * start or a follow-up may carry `mentions`. Absent reads as false.
   */
  readonly mentions?: boolean | undefined;
}

export interface CodingWorkbenchRuntimeProjectMemoryRequest {
  readonly enabled: boolean;
}

/**
 * Starts a new task as a fork of another Coding History task (S03, #3904): the new task begins from
 * the source task's saved native session, in the same workspace, and shows the source's conversation
 * up to the fork point as its own earlier history. It names a task and optionally a message of it,
 * nothing else: the fork is minted, bounded and approved like any other start, so it carries none of
 * the source run's authority. A server that holds no saved session for the source still starts the
 * task, with the source's history as context, exactly as a follow-up does.
 */
export interface CodingWorkbenchRuntimeForkRequest {
  /** The Coding History task to fork; it must belong to the active workspace. */
  readonly taskId: string;
  /**
   * The user message of that task (an id from its Coding History) to fork just before, so the new
   * task carries what came ahead of it and not the message or anything after. Absent forks the task
   * as it ended.
   */
  readonly beforeMessageId?: string | undefined;
}

export interface CodingWorkbenchRuntimeStartRequest {
  readonly requestId: string;
  /** Transient model input; no response, snapshot, SSE projection, or evidence may retain it. */
  readonly taskIntent: string;
  /** Durable conversation identity; never grants execution authority. */
  readonly conversationId?: string | undefined;
  /** Forks another task into a new one; never combined with `conversationId`. */
  readonly fork?: CodingWorkbenchRuntimeForkRequest | undefined;
  readonly requestedMode: CodingWorkbenchMode;
  readonly runtimePreference?: CodingWorkbenchRuntimePreference | undefined;
  readonly modelId?: string | undefined;
  readonly reasoningEffort?: ModelReasoningEffort | undefined;
  /**
   * The GitHub issue the run must be bound to (#3385): the raw text the user pasted — an issue URL,
   * `owner/repo#n` or `#n` — never a structured repository/number pair the browser could author.
   * The server resolves it against the ACTIVE workspace's own repository into a content-free
   * `CodingWorkbenchIssueBinding` before any run is minted; a deployment without that resolver
   * refuses the field outright, so supplying it can never silently start a generic run. Transient
   * intent like `taskIntent`: it is parsed, never persisted.
   */
  readonly issueRef?: string | undefined;
  /** Optimistic precondition from the accepted preview; never authority. */
  readonly expectedIssueBindingDigest?: string | undefined;
  /** A prompt link supplies context; only an explicit delivery request binds the run to delivery. */
  readonly issuePurpose?: "context" | "delivery" | undefined;
  /**
   * Operator preference only. The browser can turn project memory context on/off for this run, but
   * it cannot choose scopes, paths, user memory, or credentials. The server derives those from the
   * active workspace binding and defaults an omitted field to enabled for older clients.
   */
  readonly projectMemory?: CodingWorkbenchRuntimeProjectMemoryRequest | undefined;
  /**
   * The primary agent the run's first turn runs under. Absent means the default (`build`), exactly
   * as before. Selecting `plan` needs a runtime that can honour it; the server refuses the start
   * (`invalid-intent`) rather than run a read-only request as `build`. A start names a built-in.
   */
  readonly agent?: CodingWorkbenchBuiltInAgent | undefined;
  /**
   * Workspace files the first prompt references with `@`, by path relative to the workspace root
   * (ADR-0137 D10). They are resolved against the run's own canonical workspace root when the
   * first turn is dispatched, through the same admission as a follow-up's; a reference that is
   * refused refuses the start (`invalid-intent`) instead of starting without it.
   */
  readonly references?: readonly CodingWorkbenchPromptReference[] | undefined;
  /**
   * Starts the run's first turn with one of the runtime's slash commands, the text being
   * `taskIntent` (which may then be empty). A native runtime only; it cannot be combined with an
   * issue reference, whose context a command turn does not carry.
   */
  readonly command?: CodingWorkbenchCommandRequest | undefined;
  /**
   * The subagents and skills the first prompt mentions (S15, #3906). Like `references`, they are
   * checked against the run's own runtime when its first turn is dispatched; a mention the runtime
   * does not list refuses the start (`invalid-intent`) instead of starting without it.
   */
  readonly mentions?: CodingWorkbenchPromptMentions | undefined;
}

/**
 * Body of `POST /runs/:runId/follow-up`. `agent` selects the primary agent for this and the
 * following turns; absent keeps the run's current agent.
 *
 * `delivery` makes the message a steering or queued message for the turn that is running right now
 * (it never starts a turn, so it cannot name an `agent`); `references` attaches workspace files to
 * the prompt, by path relative to the run's workspace (ADR-0137 D10).
 */
export interface CodingWorkbenchRuntimeFollowUpRequest {
  readonly requestId: string;
  readonly expectedRevision: number;
  /** Transient model input; no response, snapshot, SSE projection, or evidence may retain it. */
  readonly taskIntent: string;
  readonly agent?: CodingWorkbenchAgent | undefined;
  readonly delivery?: CodingWorkbenchPromptDelivery | undefined;
  readonly references?: readonly CodingWorkbenchPromptReference[] | undefined;
  /**
   * Runs the turn as one of the runtime's slash commands, the text being `taskIntent` (which may
   * then be empty). It starts a turn like any follow-up, so it cannot also be a `delivery`.
   */
  readonly command?: CodingWorkbenchCommandRequest | undefined;
  /** The subagents and skills this message mentions (S15, #3906), checked against the run's listing. */
  readonly mentions?: CodingWorkbenchPromptMentions | undefined;
}

/**
 * The turn-revert actions of a live native run (B3, S04). `undo` stops the turn in flight, when
 * there is one, and restores the workspace files the run's newest turn changed; `restore` re-applies
 * them while the undo is still staged. Closed, so the browser can name nothing else.
 */
export type CodingWorkbenchRuntimeRevertAction = "undo" | "restore";

export const CODING_WORKBENCH_RUNTIME_REVERT_ACTIONS: readonly CodingWorkbenchRuntimeRevertAction[] =
  Object.freeze(["undo", "restore"] as const);

export function isCodingWorkbenchRuntimeRevertAction(
  value: unknown,
): value is CodingWorkbenchRuntimeRevertAction {
  return isOneOf(value, CODING_WORKBENCH_RUNTIME_REVERT_ACTIONS);
}

/** Body of `POST /runs/:runId/revert`: the usual revision-bound envelope plus the closed action. */
export interface CodingWorkbenchRuntimeRevertRequest {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly action: CodingWorkbenchRuntimeRevertAction;
}

/** Upper bound on a revert file or line count; matches the approval-review count bound. */
export const CODING_WORKBENCH_RUNTIME_REVERT_MAX_COUNT = 1_000_000;

/**
 * What an undo would do or has done: counts only. `staged` says an undo is in place and a
 * `restore` can bring the changes back; otherwise the counts describe the run's newest turn. No
 * path, patch or message ever rides this projection.
 */
export interface CodingWorkbenchRuntimeRevertState {
  readonly staged: boolean;
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
}

/** Session facet of the revert channel: the status of the presented cookie only (ADR-0141). */
export const CODING_WORKBENCH_RUNTIME_REVERT_SESSION_STATES = ["active", "unpaired"] as const;

export type CodingWorkbenchRuntimeRevertSession =
  (typeof CODING_WORKBENCH_RUNTIME_REVERT_SESSION_STATES)[number];

/**
 * `GET /runs/:runId/revert`: absent `revert` means no undo is available for the run (a runtime
 * without snapshots, a run that is not live, or a session the runtime cannot read). An unpaired
 * caller receives the constant `{ session: "unpaired" }` regardless of the run.
 */
export interface CodingWorkbenchRuntimeRevertChannelPayload {
  readonly session: CodingWorkbenchRuntimeRevertSession;
  readonly revert?: CodingWorkbenchRuntimeRevertState | undefined;
}

export function unpairedCodingWorkbenchRuntimeRevertChannelPayload(): CodingWorkbenchRuntimeRevertChannelPayload {
  return { session: "unpaired" };
}

function revertCountValid(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= CODING_WORKBENCH_RUNTIME_REVERT_MAX_COUNT
  );
}

function validateRevertState(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("revertChannelPayload.revert must be an object");
    return;
  }
  errors.push(
    ...exactKeys(value, ["staged", "fileCount", "additions", "deletions"], "revertChannelPayload"),
  );
  if (typeof value.staged !== "boolean") errors.push("revertChannelPayload.staged is invalid");
  for (const key of ["fileCount", "additions", "deletions"] as const) {
    if (!revertCountValid(value[key])) errors.push(`revertChannelPayload.${key} is invalid`);
  }
}

/** Exact keys, a valid session facet, bounded counts, and no revert state for an unpaired caller. */
export function validateCodingWorkbenchRuntimeRevertChannelPayload(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeRevertChannelPayload> {
  if (!isRecord(value)) return invalid("revert channel payload must be an object");
  const errors = exactKeys(value, ["session", "revert"], "revertChannelPayload");
  const admitted = checkCodingWorkbenchRuntimeRevertChannelPayload(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function checkCodingWorkbenchRuntimeRevertChannelPayload(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeRevertChannelPayload {
  if (!isOneOf(value.session, CODING_WORKBENCH_RUNTIME_REVERT_SESSION_STATES)) {
    errors.push("revertChannelPayload.session is invalid");
  }
  if (value.session === "unpaired" && value.revert !== undefined) {
    errors.push("revertChannelPayload.revert must be absent when the session is unpaired");
  }
  if (value.revert !== undefined) validateRevertState(value.revert, errors);
  return errors.length === 0;
}

/**
 * The actions on a message Keiko delivered into a running turn and the runtime has not handed to the
 * model yet (S07, ADR-0137 D10): `cancel` withdraws it, `promote` changes a queued message to `steer`
 * so it joins the turn at its next step (Send now). Closed, so the browser can name nothing else.
 */
export type CodingWorkbenchRuntimeInboxAction = "cancel" | "promote";

export const CODING_WORKBENCH_RUNTIME_INBOX_ACTIONS: readonly CodingWorkbenchRuntimeInboxAction[] =
  Object.freeze(["cancel", "promote"] as const);

export function isCodingWorkbenchRuntimeInboxAction(
  value: unknown,
): value is CodingWorkbenchRuntimeInboxAction {
  return isOneOf(value, CODING_WORKBENCH_RUNTIME_INBOX_ACTIONS);
}

/** At most this many pending messages ride one listing: the most a run retains (ADR-0137 D10). */
export const CODING_WORKBENCH_RUNTIME_INBOX_ITEMS_MAX = 32;
/** The operator's own text as a one-line preview; longer text ends in an ellipsis. */
export const CODING_WORKBENCH_RUNTIME_INBOX_PREVIEW_MAX_CHARS = 200;
const CODING_WORKBENCH_RUNTIME_INBOX_ITEM_ID = /^msg_[A-Za-z0-9_-]{1,251}$/u;

/**
 * Transport shape of a pending message's id (the runtime's own message id, which Keiko minted when it
 * delivered the message). Whether the id names a message of THIS run's turn that is still pending is
 * the server's decision; the browser only hands back an id it was listed.
 */
export function isCodingWorkbenchRuntimeInboxItemId(value: unknown): value is string {
  return typeof value === "string" && CODING_WORKBENCH_RUNTIME_INBOX_ITEM_ID.test(value);
}

/** Body of `POST /runs/:runId/inbox`: the usual revision-bound envelope, the action and the item. */
export interface CodingWorkbenchRuntimeInboxRequest {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly action: CodingWorkbenchRuntimeInboxAction;
  readonly itemId: string;
}

export function parseCodingWorkbenchRuntimeInboxRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeInboxRequest> {
  if (!isRecord(value)) return invalid("inbox request must be an object");
  const errors = exactKeys(
    value,
    ["requestId", "expectedRevision", "action", "itemId"],
    "inboxRequest",
  );
  const admitted = checkCodingWorkbenchRuntimeInboxRequest(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function checkCodingWorkbenchRuntimeInboxRequest(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeInboxRequest {
  validateRequestId(value.requestId, errors);
  validateExpectedRevision(value, errors);
  if (!isCodingWorkbenchRuntimeInboxAction(value.action)) errors.push("action is invalid");
  if (!isCodingWorkbenchRuntimeInboxItemId(value.itemId)) errors.push("itemId is invalid");
  return errors.length === 0;
}

/**
 * One message Keiko delivered into the running turn that is still waiting: how it will be delivered
 * and the operator's own text as a one-line preview (control and invisible characters removed,
 * whitespace collapsed, at most `CODING_WORKBENCH_RUNTIME_INBOX_PREVIEW_MAX_CHARS`). Nothing the
 * runtime holds about the message beside its id and delivery ever rides this projection.
 */
export interface CodingWorkbenchRuntimeInboxItem {
  readonly itemId: string;
  readonly delivery: CodingWorkbenchPromptDelivery;
  readonly preview: string;
}

/** Session facet of the inbox channel: the status of the presented cookie only (ADR-0141). */
export const CODING_WORKBENCH_RUNTIME_INBOX_SESSION_STATES = ["active", "unpaired"] as const;

export type CodingWorkbenchRuntimeInboxSession =
  (typeof CODING_WORKBENCH_RUNTIME_INBOX_SESSION_STATES)[number];

/**
 * `GET /runs/:runId/inbox`: the pending messages of the turn that is running, in the order the
 * runtime will hand them to the model (every `steer` message, then every `queue` message, each in
 * the order it was delivered). Absent `items` means the run offers none (a mapped profile, a run
 * whose turn is not in flight, a listing the runtime could not give); present and empty means
 * nothing is waiting. An unpaired caller receives the constant `{ session: "unpaired" }` regardless
 * of the run, so the route is not an existence oracle.
 */
export interface CodingWorkbenchRuntimeInboxChannelPayload {
  readonly session: CodingWorkbenchRuntimeInboxSession;
  readonly items?: readonly CodingWorkbenchRuntimeInboxItem[] | undefined;
}

export function unpairedCodingWorkbenchRuntimeInboxChannelPayload(): CodingWorkbenchRuntimeInboxChannelPayload {
  return { session: "unpaired" };
}

function inboxItemErrors(entry: unknown, path: string, seen: Set<string>): string[] {
  if (!isRecord(entry)) return [`${path} must be an object`];
  const errors = exactKeys(entry, ["itemId", "delivery", "preview"], path);
  if (!isCodingWorkbenchRuntimeInboxItemId(entry.itemId)) {
    errors.push(`${path}.itemId is invalid`);
  } else if (seen.has(entry.itemId)) {
    errors.push(`${path}.itemId repeats an earlier item`);
  } else {
    seen.add(entry.itemId);
  }
  if (!isCodingWorkbenchPromptDelivery(entry.delivery)) errors.push(`${path}.delivery is invalid`);
  if (
    !validateUntrustedDisplayText(entry.preview, CODING_WORKBENCH_RUNTIME_INBOX_PREVIEW_MAX_CHARS, {
      minChars: 0,
    })
  ) {
    errors.push(`${path}.preview must be bounded display text`);
  }
  return errors;
}

function inboxListErrors(items: unknown): string[] {
  if (!Array.isArray(items)) return ["inboxChannelPayload.items must be an array"];
  const errors: string[] = [];
  if (items.length > CODING_WORKBENCH_RUNTIME_INBOX_ITEMS_MAX) {
    errors.push(
      `items must hold at most ${String(CODING_WORKBENCH_RUNTIME_INBOX_ITEMS_MAX)} entries`,
    );
  }
  const seen = new Set<string>();
  validatePhysicalArrayEntries(
    items,
    "items",
    errors,
    false,
    "must be an object",
    (entry, path, issues): boolean => {
      const memberErrors = inboxItemErrors(entry, path, seen);
      issues.push(...memberErrors);
      return memberErrors.length === 0;
    },
  );
  return errors;
}

/** Exact keys, a valid session facet, a bounded duplicate-free listing, none when unpaired. */
export function validateCodingWorkbenchRuntimeInboxChannelPayload(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeInboxChannelPayload> {
  if (!isRecord(value)) return invalid("inbox channel payload must be an object");
  const errors = exactKeys(value, ["session", "items"], "inboxChannelPayload");
  const admitted = checkCodingWorkbenchRuntimeInboxChannelPayload(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function checkCodingWorkbenchRuntimeInboxChannelPayload(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeInboxChannelPayload {
  if (!isOneOf(value.session, CODING_WORKBENCH_RUNTIME_INBOX_SESSION_STATES)) {
    errors.push("inboxChannelPayload.session is invalid");
  }
  if (value.session === "unpaired" && value.items !== undefined) {
    errors.push("inboxChannelPayload.items must be absent when the session is unpaired");
  }
  if (value.items !== undefined) errors.push(...inboxListErrors(value.items));
  return errors.length === 0;
}

/** The retry route has the same fresh, transient intent shape as start. */
export type CodingWorkbenchRuntimeRetryRequest = CodingWorkbenchRuntimeStartRequest;

export interface CodingWorkbenchRuntimeStopRequest {
  readonly requestId: string;
}

export interface CodingWorkbenchRuntimeResumeRequest {
  readonly requestId: string;
  /** Omitted means retain the run's current mode; supplied values may only narrow it. */
  readonly requestedMode?: CodingWorkbenchMode | undefined;
}

export interface CodingWorkbenchRuntimeTakeoverRequest {
  readonly requestId: string;
}

export type CodingWorkbenchRuntimeApprovalDecision = "approved" | "denied";

export const CODING_WORKBENCH_RUNTIME_APPROVAL_DECISIONS: readonly CodingWorkbenchRuntimeApprovalDecision[] =
  Object.freeze(["approved", "denied"] as const);

/**
 * The bounded, content-free permission fact required to bind an approval decision to a snapshot.
 * This deliberately reuses the existing validated public permission vocabulary.
 */
export type CodingWorkbenchRuntimePendingPermission = Pick<
  CodingWorkbenchPermissionRequest,
  | "requestId"
  | "kind"
  | "actionClass"
  | "reasonCode"
  | "actionKind"
  | "scopeLabel"
  | "risk"
  | "policyReason"
  | "connectorScopes"
  | "commandLabel"
  | "nativePermission"
  | "expiresAt"
>;

export interface CodingWorkbenchRuntimeApprovalDecisionRequest {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly decision: CodingWorkbenchRuntimeApprovalDecision;
  readonly grantScope?: "once" | "task" | undefined;
  readonly commandTemplateId?: string | undefined;
  readonly safeArgumentClasses?: readonly string[] | undefined;
}

// Body for POST /runs/:runId/research/revoke (#2387). Bound to the observed revision and the exact
// grant id so a stale or forged revoke fails closed; the server drops the grant for the parent AND
// every child and answers with the revision-bumped, grant-absent snapshot.
export interface CodingWorkbenchRuntimeResearchRevokeRequest {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly grantId: string;
}

export interface CodingWorkbenchRuntimeRecoveryAcknowledgementRequest {
  readonly requestId: string;
  readonly acknowledged: true;
}

export type CodingWorkbenchRuntimeResultStatus = "cancelled" | "failed" | "signalled" | "succeeded";

export interface CodingWorkbenchRuntimeProcessSummary {
  readonly byteCount: number;
  readonly lineCount: number;
  readonly sha256: string;
  readonly truncated: boolean;
}

export interface CodingWorkbenchRuntimeResult {
  readonly status: CodingWorkbenchRuntimeResultStatus;
  readonly exitCode: number | null;
  readonly output: CodingWorkbenchRuntimeProcessSummary;
  readonly error: CodingWorkbenchRuntimeProcessSummary;
}

export type CodingWorkbenchContextUsageSource = "estimated" | "provider-reported";

/** Optional measured attribution. Omitted categories were not reported and must not be inferred. */
export interface CodingWorkbenchContextUsageBreakdown {
  readonly conversationMessagesTokens?: number | undefined;
  readonly systemContextTokens?: number | undefined;
  readonly toolDefinitionTokens?: number | undefined;
  readonly providerAccountingAdjustmentTokens?: number | undefined;
}

export interface CodingWorkbenchContextCompaction {
  readonly count: number;
  readonly lastCompactedAt?: string | undefined;
  readonly thresholdTokens?: number | undefined;
}

export type CodingWorkbenchContextUsage =
  | {
      readonly state: "unavailable";
      readonly updatedAt: string;
    }
  | {
      readonly state: "available";
      readonly source: CodingWorkbenchContextUsageSource;
      readonly capacityTokens: number;
      readonly usedInputTokens: number;
      readonly reservedOutputTokens: number;
      readonly freeTokens: number;
      readonly breakdown?: CodingWorkbenchContextUsageBreakdown | undefined;
      readonly cumulativePromptTokens: number;
      readonly runPromptBudgetTokens?: number | undefined;
      readonly compaction?: CodingWorkbenchContextCompaction | undefined;
      readonly updatedAt: string;
    };

/**
 * Content-free status projection. `runId` is intentionally optional for unbound availability
 * states; task/workspace/authority/process/model content never crosses this boundary.
 */
export interface CodingWorkbenchRuntimeSnapshot {
  readonly schemaVersion: typeof CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
  readonly state: CodingWorkbenchRuntimeStateName;
  readonly revision: number;
  readonly updatedAt: string;
  readonly runId?: string | undefined;
  /** Original start/retry intent; never rewritten by a narrower resume. */
  readonly requestedMode?: CodingWorkbenchMode | undefined;
  /** Server-confirmed live authority after ceiling and resume narrowing. */
  readonly effectiveMode?: CodingWorkbenchMode | undefined;
  readonly runtimeSource?: CodingWorkbenchRuntimeSource | undefined;
  readonly modelSource?: CodingWorkbenchModelSource | undefined;
  readonly failureCode?: CodingWorkbenchRuntimeFailureCode | undefined;
  /** Honest runtime/provider accounting; unavailable never implies a guessed model limit. */
  readonly contextUsage?: CodingWorkbenchContextUsage | undefined;
  /** Present only when durable server truth records acknowledgement for a recovery-required run. */
  readonly recoveryAcknowledged?: true | undefined;
  /** Present exactly while the runtime is awaiting an operator decision. */
  readonly pendingPermission?: CodingWorkbenchRuntimePendingPermission | undefined;
  /**
   * Why the run is `paused`. Absent means an operator paused it from the Workbench, which is what
   * `paused` used to mean unconditionally. A value names a decision only a local human can make and
   * a governed tool is waiting in place for; the run resumes itself once that decision lands, so
   * the operator's action is the decision, not a Resume click.
   */
  readonly pauseReason?: CodingWorkbenchOperatorDecision | undefined;
  /** Terminal, body-free process outcome; never contains stdout or stderr content. */
  readonly result?: CodingWorkbenchRuntimeResult | undefined;
  /**
   * Present exactly when the run was started from an accepted GitHub issue (#3385). Digests, a
   * number and a branch name only — the issue's text never crosses this boundary.
   */
  readonly issueBinding?: CodingWorkbenchIssueBinding | undefined;
  /** Latest durable commit receipt; no message, paths, command or approval token. */
  readonly verifiedCommitResult?: VerifiedCommitResult | undefined;
  /** Durable repository delivery facts; no authored text, command, credentials or approval grant. */
  readonly draftDelivery?: DraftDeliveryRecord | undefined;
  /** Last bounded CI observation. Its timestamp and head binding confer no execution authority. */
  readonly ciReadiness?: ReadinessSnapshot | undefined;
  /**
   * Present exactly when a stable succeeded head has an automatic description-draft attempt
   * (#3401). No title, body, diff or model text ever crosses this boundary — see
   * `WorkbenchDescriptionStatus`. Generation grants no remote-write authority: applying the draft
   * still uses #3399's existing PR preview, policy and one-use approval.
   */
  readonly descriptionStatus?: WorkbenchDescriptionStatus | undefined;
  readonly conversationId?: string | undefined;
}

export type CodingWorkbenchRuntimeStatus = CodingWorkbenchRuntimeSnapshot;

export type CodingWorkbenchRuntimeSseEventKind = "status" | "runtime-event";

export const CODING_WORKBENCH_RUNTIME_SSE_EVENT_KINDS: readonly CodingWorkbenchRuntimeSseEventKind[] =
  Object.freeze(["status", "runtime-event"] as const);

/**
 * Bounded SSE projection. It reports only the lifecycle vocabulary, a monotonic revision, and a
 * safe cursor; raw prompt/model/process/workspace content remains on the server's transient path.
 */
export type CodingWorkbenchRuntimeSseEvent =
  | {
      readonly schemaVersion: typeof CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
      readonly cursor: string;
      readonly sequence: number;
      readonly occurredAt: string;
      readonly kind: "status";
      readonly runId: string;
      readonly state: CodingWorkbenchRuntimeStateName;
      readonly revision: number;
      readonly failureCode?: CodingWorkbenchRuntimeFailureCode | undefined;
    }
  | {
      readonly schemaVersion: typeof CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
      readonly cursor: string;
      readonly sequence: number;
      readonly occurredAt: string;
      readonly kind: "runtime-event";
      readonly runId: string;
      readonly state: CodingWorkbenchRuntimeStateName;
      readonly revision: number;
      // An adapter event kind, or one of the SSE-only gateway facts (#3873 review).
      readonly eventKind: CodingWorkbenchRuntimeEventKind | CodingWorkbenchGatewayEventKind;
      readonly failureCode?:
        CodingWorkbenchRuntimeFailureCode | CodingWorkbenchTurnFailureCode | undefined;
      /**
       * The normalized #2387 outcome for a research-performed / skill-invoked / child-run-* frame.
       * `limit-reached` and `stopped` stay distinct from `denied` so the timeline never mislabels an
       * exhausted budget or a cascaded stop as a failure. Absent for every other event kind.
       */
      readonly auxiliaryOutcome?: CodingWorkbenchAuxiliaryStatus | undefined;
      /**
       * #2637: present as `untrusted` on an accepted `research-performed` frame, so the timeline can
       * tell the operator that the page text the run just took in is quarantined third-party data.
       * A constant marker — it names the channel's trust, never a byte of the page. Absent on every
       * other frame.
       */
      readonly contentTrust?: CodingWorkbenchContentTrust | undefined;
      /** Optional measured check metadata on verification-summarized events only. */
      readonly verificationSummary?: CodingWorkbenchVerificationSummary | undefined;
      /** Required only on native-retry-changed; null reports the native producer's clear. */
      readonly nativeRetry?: CodingWorkbenchNativeRetry | null | undefined;
    };

function checkStartRequest(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeStartRequest {
  const request = validateRequestId(value.requestId, errors);
  const intent = validateTaskIntent(value.taskIntent, errors, value.command !== undefined);
  const conversation =
    value.conversationId === undefined ||
    validateSafeId(value.conversationId, "conversationId", errors, 128);
  const mode = isOneOf(value.requestedMode, CODING_WORKBENCH_MODES);
  if (!mode) errors.push("requestedMode is invalid");
  const preference = validateRuntimePreference(value.runtimePreference, errors);
  const model = validateRuntimeModelId(value.modelId, errors);
  const reasoning = validateReasoningEffort(value.reasoningEffort, errors);
  const issue = validateIssueRef(value.issueRef, errors);
  const purpose = validateIssuePurpose(value.issuePurpose, value.issueRef, errors);
  const memory = validateProjectMemoryRequest(value.projectMemory, errors);
  const promptBefore = errors.length;
  validateStartAgent(value.agent, errors);
  validateStartPromptInputs(value, errors);
  const prompt = errors.length === promptBefore;
  const digest = validateExpectedIssueDigest(value, errors);
  return [
    request,
    intent,
    conversation,
    mode,
    preference,
    model,
    reasoning,
    issue,
    purpose,
    memory,
    prompt,
    digest,
  ].every(Boolean);
}

function validateExpectedIssueDigest(value: Record<string, unknown>, errors: string[]): boolean {
  if (value.expectedIssueBindingDigest === undefined) return true;
  if (value.issueRef === undefined || typeof value.expectedIssueBindingDigest !== "string") {
    errors.push("expectedIssueBindingDigest requires an issue reference and sha256 digest");
    return false;
  }
  const digest: unknown = value.expectedIssueBindingDigest;
  const admitted = typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest);
  if (!admitted)
    errors.push("expectedIssueBindingDigest requires an issue reference and sha256 digest");
  return admitted;
}

function checkReadinessRequest(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeReadinessRequest {
  const admitted = isOneOf(value.requestedMode, CODING_WORKBENCH_MODES);
  if (!admitted) errors.push("requestedMode is invalid");
  return admitted;
}

function checkResumeRequest(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeResumeRequest {
  const request = validateRequestId(value.requestId, errors);
  const mode =
    value.requestedMode === undefined || isOneOf(value.requestedMode, CODING_WORKBENCH_MODES);
  if (!mode) errors.push("requestedMode is invalid");
  return request && mode;
}

function validateExpectedRevision(value: Record<string, unknown>, errors: string[]): boolean {
  if (!Number.isSafeInteger(value.expectedRevision)) {
    errors.push("expectedRevision must be a non-negative safe integer");
    return false;
  }
  const revision: unknown = value.expectedRevision;
  const admitted = typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0;
  if (!admitted) errors.push("expectedRevision must be a non-negative safe integer");
  return admitted;
}

function checkResearchRevokeRequest(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeResearchRevokeRequest {
  const request = validateRequestId(value.requestId, errors);
  const revision = validateExpectedRevision(value, errors);
  const grant = validateSafeId(
    value.grantId,
    "grantId",
    errors,
    CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS,
  );
  return request && revision && grant;
}

function checkRecoveryAcknowledgementRequest(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeRecoveryAcknowledgementRequest {
  const request = validateRequestId(value.requestId, errors);
  const acknowledged = value.acknowledged === true;
  if (!acknowledged) errors.push("acknowledged must be true");
  return request && acknowledged;
}

function checkRequestIdOnly(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeStopRequest {
  return validateRequestId(value.requestId, errors);
}

// The text of a request. A slash command takes its arguments from it, and a command such as
// `/review` needs none, so only a request that names a command may carry an empty text.
function validateTaskIntent(
  value: unknown,
  errors: string[],
  commandNamed = false,
): value is string {
  const minimum = commandNamed ? 0 : 1;
  if (typeof value !== "string" || value.length < minimum || value.length > 65_536) {
    errors.push(
      commandNamed
        ? "taskIntent must be a bounded string"
        : "taskIntent must be a bounded non-empty string",
    );
    return false;
  }
  return true;
}

// Mentions are supplementary like a command: an absent field adds no key.
function validateMentions(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  const mentions = parseCodingWorkbenchPromptMentions(value);
  if (!mentions.ok) errors.push(...mentions.errors);
}

// A command is a supplementary field like `agent`: an absent one adds no key, an invalid one
// reports the command parser's own reasons.
function validateCommandRequest(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  const command = parseCodingWorkbenchCommandRequest(value);
  if (!command.ok) errors.push(...command.errors);
}

function validateAgent(value: unknown, errors: string[]): void {
  if (value !== undefined && !isCodingWorkbenchAgent(value)) errors.push("agent is invalid");
}

// A start names a built-in agent only: a custom primary agent exists in a run's own listing, so it
// can be chosen for a follow-up once that run lists it, never for a run that does not exist yet.
function validateStartAgent(value: unknown, errors: string[]): void {
  if (value !== undefined && !isCodingWorkbenchBuiltInAgent(value)) errors.push("agent is invalid");
}

function validateRuntimePreference(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchRuntimePreference | undefined {
  if (value !== undefined && !isOneOf(value, CODING_WORKBENCH_RUNTIME_PREFERENCES)) {
    errors.push("runtimePreference is invalid");
    return false;
  }
  return true;
}
function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function validateRuntimeModelId(value: unknown, errors: string[]): value is string | undefined {
  if (value === undefined) return true;
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > CODING_WORKBENCH_RUNTIME_MODEL_ID_MAX_CHARS ||
    containsControlCharacter(value)
  ) {
    errors.push("modelId must be bounded safe text");
    return false;
  }
  return true;
}
function validateReasoningEffort(
  value: unknown,
  errors: string[],
): value is ModelReasoningEffort | undefined {
  if (value !== undefined && !isOneOf(value, MODEL_REASONING_EFFORTS)) {
    errors.push("reasoningEffort is invalid");
    return false;
  }
  return true;
}
// Transport shape only: one bounded, control-character-free string, sharing the parser's own
// length bound so a reference the contract admits is never one the parser refuses for size. What
// the text MEANS is decided by the server-side resolver against the active repository.
function validateIssueRef(value: unknown, errors: string[]): value is string | undefined {
  if (value === undefined) return true;
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > GITHUB_ISSUE_REFERENCE_MAX_CHARS ||
    containsControlCharacter(value)
  ) {
    errors.push("issueRef must be bounded safe text");
    return false;
  }
  return true;
}
function validateIssuePurpose(
  value: unknown,
  issueRef: unknown,
  errors: string[],
): value is "context" | "delivery" | undefined {
  if (value === undefined) return true;
  if (issueRef === undefined || (value !== "context" && value !== "delivery")) {
    errors.push("issuePurpose requires an issue reference and a supported purpose");
    return false;
  }
  return true;
}
function validateProjectMemoryRequest(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchRuntimeProjectMemoryRequest | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) {
    errors.push("projectMemory must be an object");
    return false;
  }
  errors.push(...exactKeys(value, ["enabled"], "projectMemory"));
  const enabled = typeof value.enabled === "boolean";
  if (!enabled) errors.push("projectMemory.enabled must be boolean");
  return enabled;
}
export function parseCodingWorkbenchRuntimeStartRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeStartRequest> {
  if (!isRecord(value)) return invalid("start request must be an object");
  const errors = exactKeys(value, START_REQUEST_KEYS, "startRequest");
  const admitted = checkStartRequest(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

const START_REQUEST_KEYS: readonly string[] = [
  "requestId",
  "taskIntent",
  "conversationId",
  "requestedMode",
  "runtimePreference",
  "modelId",
  "reasoningEffort",
  "issueRef",
  "expectedIssueBindingDigest",
  "issuePurpose",
  "projectMemory",
  "agent",
  "references",
  "command",
  "mentions",
  "fork",
];

// A fork names the task to fork and, optionally, the message to fork before; it starts a NEW task, so
// it cannot also continue one.
function validateForkRequest(value: Record<string, unknown>, errors: string[]): void {
  if (value.fork === undefined) return;
  if (value.conversationId !== undefined) errors.push("fork cannot continue a conversation");
  if (!isRecord(value.fork)) {
    errors.push("fork must be an object");
    return;
  }
  errors.push(...exactKeys(value.fork, ["taskId", "beforeMessageId"], "fork"));
  validateSafeId(value.fork.taskId, "fork.taskId", errors, 128);
  if (value.fork.beforeMessageId !== undefined) {
    validateSafeId(value.fork.beforeMessageId, "fork.beforeMessageId", errors, 128);
  }
}

// The first prompt's references and command (ADR-0137 D10): the same bounds as a follow-up's, and a
// command turn carries none of an issue's context, so the two never combine.
function validateStartPromptInputs(value: Record<string, unknown>, errors: string[]): void {
  if (value.references !== undefined) {
    const references = parseCodingWorkbenchPromptReferences(value.references);
    if (!references.ok) errors.push(...references.errors);
  }
  validateMentions(value.mentions, errors);
  validateCommandRequest(value.command, errors);
  if (value.command !== undefined && value.issueRef !== undefined) {
    errors.push("command cannot be combined with an issue reference");
  }
  validateForkRequest(value, errors);
}

// A retry uses the identical request shape as the initial start; the distinct name documents the
// retry call site's intent to readers without duplicating the validation logic.
export function parseCodingWorkbenchRuntimeRetryRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeStartRequest> {
  return parseCodingWorkbenchRuntimeStartRequest(value);
}

export function parseCodingWorkbenchRuntimeFollowUpRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeFollowUpRequest> {
  if (!isRecord(value)) return invalid("follow-up request must be an object");
  const errors = exactKeys(
    value,
    [
      "requestId",
      "expectedRevision",
      "taskIntent",
      "agent",
      "delivery",
      "references",
      "command",
      "mentions",
    ],
    "followUpRequest",
  );
  const admitted = checkCodingWorkbenchRuntimeFollowUpRequest(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function checkCodingWorkbenchRuntimeFollowUpRequest(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeFollowUpRequest {
  validateRequestId(value.requestId, errors);
  validateExpectedRevision(value, errors);
  validateTaskIntent(value.taskIntent, errors, value.command !== undefined);
  validateAgent(value.agent, errors);
  validatePromptDelivery(value, errors);
  validateCommandRequest(value.command, errors);
  validateMentions(value.mentions, errors);
  if (value.references !== undefined) {
    const references = parseCodingWorkbenchPromptReferences(value.references);
    if (!references.ok) errors.push(...references.errors);
  }
  return errors.length === 0;
}

// A delivered message joins the turn that is running, so it cannot also switch that turn's agent.
function validatePromptDelivery(value: Record<string, unknown>, errors: string[]): void {
  if (value.delivery === undefined) return;
  if (!isCodingWorkbenchPromptDelivery(value.delivery)) errors.push("delivery is invalid");
  else if (value.agent !== undefined) errors.push("delivery cannot select an agent");
  else if (value.command !== undefined) errors.push("delivery cannot run a command");
}

export function parseCodingWorkbenchRuntimeReadinessRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeReadinessRequest> {
  if (!isRecord(value)) return invalid("runtime readiness request must be an object");
  const errors = exactKeys(value, ["requestedMode"], "runtimeReadinessRequest");
  const admitted = checkReadinessRequest(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}
export function parseCodingWorkbenchRuntimeStopRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeStopRequest> {
  return parseRequestIdOnly(value, "stopRequest");
}

export function parseCodingWorkbenchRuntimeResumeRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeResumeRequest> {
  if (!isRecord(value)) return invalid("runtime resume request must be an object");
  const errors = exactKeys(value, ["requestId", "requestedMode"], "runtimeResume");
  const admitted = checkResumeRequest(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}
export function parseCodingWorkbenchRuntimeTakeoverRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeTakeoverRequest> {
  return parseRequestIdOnly(value, "takeoverRequest");
}

export function parseCodingWorkbenchRuntimeApprovalDecisionRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeApprovalDecisionRequest> {
  if (!isRecord(value)) return invalid("approval decision must be an object");
  const errors = exactKeys(
    value,
    [
      "requestId",
      "expectedRevision",
      "decision",
      "grantScope",
      "commandTemplateId",
      "safeArgumentClasses",
    ],
    "approvalDecision",
  );
  const admitted = checkApprovalRequest(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function checkApprovalRequest(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeApprovalDecisionRequest {
  const request = validateRequestId(value.requestId, errors);
  const revision = validateExpectedRevision(value, errors);
  const decision = isOneOf(value.decision, CODING_WORKBENCH_RUNTIME_APPROVAL_DECISIONS);
  if (!decision) errors.push("decision is invalid");
  const grants = validateApprovalGrantFields(value, errors);
  return request && revision && decision && grants;
}

function validateApprovalGrantFields(value: Record<string, unknown>, errors: string[]): boolean {
  const scope =
    value.grantScope === undefined || value.grantScope === "once" || value.grantScope === "task";
  if (!scope) errors.push("grantScope is invalid");
  const command =
    value.commandTemplateId === undefined ||
    validateSafeId(
      value.commandTemplateId,
      "commandTemplateId",
      errors,
      CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS,
    );
  const args = validateSafeArgumentClasses(value.safeArgumentClasses, errors);
  if (
    value.decision !== "approved" &&
    (value.grantScope !== undefined ||
      value.commandTemplateId !== undefined ||
      value.safeArgumentClasses !== undefined)
  )
    errors.push("denied decisions cannot carry grant fields");
  return [scope, command, args].every(Boolean);
}
function validateSafeArgumentClasses(
  value: unknown,
  errors: string[],
): value is readonly string[] | undefined {
  if (!Array.isArray(value)) {
    if (value !== undefined) errors.push("safeArgumentClasses must be an array");
    return value === undefined;
  }
  if (value.length > 16) {
    errors.push("safeArgumentClasses exceeds 16 entries");
    return false;
  }
  const count = value.length;
  let admitted = true;
  for (let index = 0; index < count; index += 1) {
    const entry: unknown = value[index];
    const valid = validateSafeId(
      entry,
      `safeArgumentClasses[${String(index)}]`,
      errors,
      CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS,
    );
    if (!(index in value)) return false;
    admitted = valid && admitted;
  }
  return admitted;
}
export function parseCodingWorkbenchRuntimeResearchRevokeRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeResearchRevokeRequest> {
  if (!isRecord(value)) return invalid("research revoke request must be an object");
  const errors = exactKeys(value, ["requestId", "expectedRevision", "grantId"], "researchRevoke");
  const admitted = checkResearchRevokeRequest(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}
export function parseCodingWorkbenchRuntimeRecoveryAcknowledgementRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeRecoveryAcknowledgementRequest> {
  if (!isRecord(value)) return invalid("recovery acknowledgement must be an object");
  const errors = exactKeys(value, ["requestId", "acknowledged"], "recoveryAcknowledgement");
  const admitted = checkRecoveryAcknowledgementRequest(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}
export function validateCodingWorkbenchRuntimeSnapshot(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeSnapshot> {
  if (!isRecord(value)) return invalid("runtime snapshot must be an object");
  const errors = exactKeys(
    value,
    [
      "schemaVersion",
      "state",
      "revision",
      "updatedAt",
      "runId",
      "requestedMode",
      "effectiveMode",
      "runtimeSource",
      "modelSource",
      "failureCode",
      "contextUsage",
      "recoveryAcknowledged",
      "pendingPermission",
      "pauseReason",
      "result",
      "issueBinding",
      "verifiedCommitResult",
      "draftDelivery",
      "ciReadiness",
      "descriptionStatus",
      "conversationId",
    ],
    "runtimeSnapshot",
  );
  const admitted = checkSnapshot(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function checkSnapshot(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeSnapshot {
  const fields = validateSnapshotFields(value, errors);
  const conversation =
    value.conversationId === undefined ||
    validateSafeId(value.conversationId, "conversationId", errors, 128);
  const context = validateContextUsage(value.contextUsage, errors);
  const issue = validateIssueBinding(value.issueBinding, errors);
  const verified = validateSnapshotVerifiedCommit(value, errors);
  const delivery = validateSnapshotDraftDelivery(value, errors);
  const ci = validateSnapshotCiReadiness(value, errors);
  const description = validateSnapshotDescriptionStatus(value, errors);
  const outcome = validateRuntimeResult(value.result, errors);
  if (
    value.result !== undefined &&
    !["succeeded", "failed", "cancelled", "taken-over"].includes(String(value.state))
  )
    errors.push("result is permitted only on a terminal snapshot");
  return [fields, conversation, context, issue, verified, delivery, ci, description, outcome].every(
    Boolean,
  );
}

function validateContextUsage(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchContextUsage | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) {
    errors.push("contextUsage must be an object");
    return false;
  }
  if (value.state === "unavailable") {
    errors.push(...exactKeys(value, ["state", "updatedAt"], "contextUsage"));
    return validateStrictUtcInstant(value.updatedAt, "contextUsage.updatedAt", errors);
  }
  return validateAvailableContextUsage(value, errors);
}
function validateAvailableContextUsage(value: Record<string, unknown>, errors: string[]): boolean {
  errors.push(
    ...exactKeys(
      value,
      [
        "state",
        "source",
        "capacityTokens",
        "usedInputTokens",
        "reservedOutputTokens",
        "freeTokens",
        "breakdown",
        "cumulativePromptTokens",
        "runPromptBudgetTokens",
        "compaction",
        "updatedAt",
      ],
      "contextUsage",
    ),
  );
  const state = value.state === "available";
  if (!state) errors.push("contextUsage.state is invalid");
  const source = value.source === "estimated" || value.source === "provider-reported";
  if (!source) errors.push("contextUsage.source is invalid");
  const counts = validateContextCounts(value, errors);
  const breakdownValue: unknown = value.breakdown;
  const used: unknown = value.usedInputTokens;
  const usedNumber = Number(used);
  const breakdown = validateContextBreakdown(breakdownValue, usedNumber, errors);
  const usedCount = validateObservedContextCount(used, "usedInputTokens", errors);
  const compaction = validateContextCompaction(value.compaction, errors);
  const updated = validateStrictUtcInstant(value.updatedAt, "contextUsage.updatedAt", errors);
  return [state, source, counts, breakdown, usedCount, compaction, updated].every(Boolean);
}

function validateContextCounts(value: Record<string, unknown>, errors: string[]): boolean {
  const fields = [
    "capacityTokens",
    "usedInputTokens",
    "reservedOutputTokens",
    "freeTokens",
    "cumulativePromptTokens",
  ] as const;
  let admitted = true;
  for (const field of fields) {
    const count = validBoundedCount(value[field], Number.MAX_SAFE_INTEGER);
    if (!count) {
      errors.push(`contextUsage.${field} is invalid`);
    }
    admitted = count && admitted;
  }
  const geometryCounts = validateGeometryCounts(value, fields, errors);
  const arithmetic = !geometryCounts || validateContextArithmetic(value, errors);
  const budget = validateRunPromptBudget(value, errors);
  return admitted && geometryCounts && arithmetic && budget;
}

function validateGeometryCounts(
  value: Record<string, unknown>,
  fields: readonly string[],
  errors: string[],
): boolean {
  for (const field of fields) {
    if (!validBoundedCount(value[field], Number.MAX_SAFE_INTEGER)) {
      const diagnostic = `contextUsage.${field} is invalid`;
      if (!errors.includes(diagnostic)) errors.push(diagnostic);
      return false;
    }
  }
  return true;
}

function validateContextArithmetic(value: Record<string, unknown>, errors: string[]): boolean {
  const capacity: unknown = value.capacityTokens;
  const capacityNumber = Number(capacity);
  const used: unknown = value.usedInputTokens;
  const usedNumber = Number(used);
  const reserved: unknown = value.reservedOutputTokens;
  const reservedNumber = Number(reserved);
  const free: unknown = value.freeTokens;
  const freeNumber = Number(free);
  if (capacityNumber !== usedNumber + reservedNumber + freeNumber) {
    errors.push("contextUsage token geometry is inconsistent");
  }
  const operands: readonly (readonly [string, unknown])[] = [
    ["capacityTokens", capacity],
    ["usedInputTokens", used],
    ["reservedOutputTokens", reserved],
    ["freeTokens", free],
  ];
  let admitted = true;
  for (const [field, observed] of operands) {
    const valid = validBoundedCount(observed, Number.MAX_SAFE_INTEGER);
    if (!valid) {
      const diagnostic = `contextUsage.${field} is invalid`;
      if (!errors.includes(diagnostic)) errors.push(diagnostic);
    }
    admitted = valid && admitted;
  }
  return admitted;
}

function validateRunPromptBudget(value: Record<string, unknown>, errors: string[]): boolean {
  if (value.runPromptBudgetTokens === undefined) return true;
  if (!validBoundedCount(value.runPromptBudgetTokens, Number.MAX_SAFE_INTEGER)) {
    errors.push("contextUsage.runPromptBudgetTokens is invalid");
    return false;
  }
  const budget: unknown = value.runPromptBudgetTokens;
  const budgetNumber = Number(budget);
  const cumulative: unknown = value.cumulativePromptTokens;
  const cumulativeNumber = Number(cumulative);
  const exceedsBudget = budgetNumber < cumulativeNumber;
  const admitted = validBoundedCount(budget, Number.MAX_SAFE_INTEGER) && !exceedsBudget;
  if (!admitted) errors.push("contextUsage.runPromptBudgetTokens is invalid");
  const cumulativeCount = validateObservedContextCount(
    cumulative,
    "cumulativePromptTokens",
    errors,
  );
  return admitted && cumulativeCount;
}

function validateObservedContextCount(value: unknown, field: string, errors: string[]): boolean {
  const admitted = validBoundedCount(value, Number.MAX_SAFE_INTEGER);
  if (!admitted) {
    const diagnostic = `contextUsage.${field} is invalid`;
    if (!errors.includes(diagnostic)) errors.push(diagnostic);
  }
  return admitted;
}

function validateContextBreakdown(
  value: unknown,
  usedTokens: number,
  errors: string[],
): value is CodingWorkbenchContextUsageBreakdown | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) {
    errors.push("contextUsage.breakdown must be an object");
    return false;
  }
  const fields = [
    "conversationMessagesTokens",
    "systemContextTokens",
    "toolDefinitionTokens",
    "providerAccountingAdjustmentTokens",
  ] as const;
  errors.push(...exactKeys(value, fields, "contextUsage.breakdown"));
  const reported: unknown[] = fields.flatMap((field) =>
    value[field] === undefined ? [] : [value[field]],
  );
  const admitted = reported.every((count) => validBoundedCount(count, Number.MAX_SAFE_INTEGER));
  if (!admitted) {
    errors.push("contextUsage.breakdown contains an invalid count");
  } else if (reported.reduce<number>((sum, count) => sum + count, 0) > usedTokens) {
    errors.push("contextUsage.breakdown exceeds usedInputTokens");
  }
  return admitted;
}
function validateContextCompaction(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchContextCompaction | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) {
    errors.push("contextUsage.compaction must be an object");
    return false;
  }
  errors.push(
    ...exactKeys(value, ["count", "lastCompactedAt", "thresholdTokens"], "contextUsage.compaction"),
  );
  const count = validBoundedCount(value.count, Number.MAX_SAFE_INTEGER);
  if (!count) errors.push("contextUsage.compaction.count is invalid");
  const compacted =
    value.lastCompactedAt === undefined ||
    validateStrictUtcInstant(
      value.lastCompactedAt,
      "contextUsage.compaction.lastCompactedAt",
      errors,
    );
  const threshold =
    value.thresholdTokens === undefined ||
    validBoundedCount(value.thresholdTokens, Number.MAX_SAFE_INTEGER);
  if (!threshold) errors.push("contextUsage.compaction.thresholdTokens is invalid");
  return count && compacted && threshold;
}
function validateIssueBinding(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchIssueBinding | undefined {
  if (value === undefined) return true;
  const validated = validateCodingWorkbenchIssueBinding(value);
  if (!validated.ok) errors.push(...validated.errors);
  return validated.ok;
}
function validateSnapshotVerifiedCommit(
  snapshot: Record<string, unknown>,
  errors: string[],
): boolean {
  const receipt = snapshot.verifiedCommitResult;
  if (receipt === undefined) return true;
  if (!isVerifiedCommitResult(receipt)) {
    errors.push("verifiedCommitResult must be a closed verified commit receipt");
    return false;
  }
  const issue = snapshot.issueBinding;
  const issueDigest = isRecord(issue) ? issue.bindingDigest : undefined;
  if (receipt.runId !== snapshot.runId || receipt.issueBindingDigest !== issueDigest) {
    errors.push("verifiedCommitResult must match the snapshot run and issue binding");
  }
  return true;
}
function validateSnapshotDraftDelivery(
  snapshot: Record<string, unknown>,
  errors: string[],
): boolean {
  const delivery = snapshot.draftDelivery;
  if (delivery === undefined) return true;
  if (!isDraftDeliveryRecord(delivery)) {
    errors.push("draftDelivery must be a closed durable delivery record");
    return false;
  }
  const issue = snapshot.issueBinding;
  const target = delivery.binding;
  if (
    !isRecord(issue) ||
    ![
      target.runId === snapshot.runId,
      target.issueBindingDigest === issue.bindingDigest,
      target.remoteDigest === issue.remoteDigest,
      target.issueIdDigest === issue.issueIdDigest,
      target.issueNumber === issue.issueNumber,
      target.baseRef === issue.defaultBaseRef,
    ].every(Boolean)
  ) {
    errors.push("draftDelivery must match the snapshot run and frozen issue binding");
  }
  return true;
}
function validateSnapshotCiReadiness(snapshot: Record<string, unknown>, errors: string[]): boolean {
  const readiness = snapshot.ciReadiness;
  if (readiness === undefined) return true;
  const draft = snapshot.draftDelivery;
  if (!isReadinessSnapshot(readiness) || !isDraftDeliveryRecord(draft)) {
    errors.push("ciReadiness must be a closed observation of a confirmed delivery");
    return false;
  }
  if (
    ![
      readiness.runId === snapshot.runId,
      readiness.remoteDigest === draft.binding.remoteDigest,
      readiness.repository.toLowerCase() === draft.binding.repository.toLowerCase(),
      readiness.prNumber === draft.pullRequest?.number,
      readiness.headRef === draft.binding.headRef,
      readiness.headSha === draft.binding.headSha,
      readiness.baseRef === draft.binding.baseRef,
    ].every(Boolean)
  )
    errors.push("ciReadiness must match the snapshot run and confirmed delivery target");
  return true;
}
// The status can outlive the LATEST `verifiedCommitResult` shown on the snapshot (that field
// reflects the most recent proposal attempt, which may be a later failed/blocked one, while the
// description job binds the last SUCCESSFUL head — codingRuntimeVerifiedCommitAuthorityStore.ts /
// epic #3384 correction 5), so only the run identity is cross-checked here.
function validateSnapshotDescriptionStatus(
  snapshot: Record<string, unknown>,
  errors: string[],
): boolean {
  const status = snapshot.descriptionStatus;
  if (status === undefined) return true;
  if (!isWorkbenchDescriptionStatus(status)) {
    errors.push("descriptionStatus must be a closed durable description status");
    return false;
  }
  if (status.runId !== snapshot.runId) {
    errors.push("descriptionStatus must match the snapshot run");
  }
  return true;
}
function validateRuntimeResult(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchRuntimeResult | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) {
    errors.push("result must be an object");
    return false;
  }
  errors.push(...exactKeys(value, ["status", "exitCode", "output", "error"], "result"));
  const status = isOneOf(value.status, ["cancelled", "failed", "signalled", "succeeded"]);
  if (!status) errors.push("result.status is invalid");
  const exit = validateResultExitCode(value, errors);
  const output = validateProcessSummary(value.output, "result.output", errors);
  const error = validateProcessSummary(value.error, "result.error", errors);
  return status && exit && output && error;
}
function validateResultExitCode(value: Record<string, unknown>, errors: string[]): boolean {
  if (value.exitCode === null) return true;
  if (!Number.isSafeInteger(value.exitCode)) {
    errors.push("result.exitCode is invalid");
    return false;
  }
  const lower: unknown = value.exitCode;
  if (typeof lower !== "number" || !Number.isSafeInteger(lower) || lower < 0) {
    errors.push("result.exitCode is invalid");
    return false;
  }
  const upper: unknown = value.exitCode;
  const admitted = validBoundedCount(upper, 255);
  if (!admitted) errors.push("result.exitCode is invalid");
  return admitted;
}

function validateProcessSummary(
  value: unknown,
  path: string,
  errors: string[],
): value is CodingWorkbenchRuntimeProcessSummary {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  errors.push(...exactKeys(value, ["byteCount", "lineCount", "sha256", "truncated"], path));
  const bytes = validBoundedCount(value.byteCount, 1_073_741_824);
  if (!bytes) errors.push(`${path}.byteCount is invalid`);
  const lines = validBoundedCount(value.lineCount, 1_000_000);
  if (!lines) errors.push(`${path}.lineCount is invalid`);
  const digest = validProcessSummaryDigest(value);
  if (!digest) errors.push(`${path}.sha256 is invalid`);
  const truncated = typeof value.truncated === "boolean";
  if (!truncated) errors.push(`${path}.truncated is invalid`);
  return bytes && lines && digest && truncated;
}
function validProcessSummaryDigest(value: Record<string, unknown>): boolean {
  if (typeof value.sha256 !== "string") return false;
  const digest: unknown = value.sha256;
  return typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest);
}

function validBoundedCount(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
// A status read validates the identical snapshot shape; the distinct name documents the read call
// site's intent to readers without duplicating the validation logic.
export function validateCodingWorkbenchRuntimeStatus(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeSnapshot> {
  return validateCodingWorkbenchRuntimeSnapshot(value);
}

export function validateCodingWorkbenchRuntimeReadiness(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeReadiness> {
  if (!isRecord(value)) return invalid("runtime readiness must be an object");
  const errors = exactKeys(
    value,
    [
      "schemaVersion",
      "requestedMode",
      "deploymentCeiling",
      "effectiveMode",
      "runtimeAvailable",
      "runtimeUnavailableReason",
      "runtimeEvidenceClass",
      "selectableAgents",
      "promptInputs",
      "runtimeVersion",
    ],
    "runtimeReadiness",
  );
  const admitted = checkRuntimeReadiness(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function checkRuntimeReadiness(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeReadiness {
  const version = value.schemaVersion === CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
  if (!version) {
    errors.push("schemaVersion is invalid");
  }
  let modes = true;
  for (const field of ["requestedMode", "deploymentCeiling", "effectiveMode"] as const) {
    const valid = isOneOf(value[field], CODING_WORKBENCH_MODES);
    if (!valid) errors.push(`${field} is invalid`);
    modes = valid && modes;
  }
  const reason = validateRuntimeUnavailableReason(value, errors);
  const evidence = validateRuntimeEvidenceClass(value, errors);
  const capabilitiesBefore = errors.length;
  validateSelectableAgents(value, errors);
  validatePromptInputs(value.promptInputs, errors);
  validateRuntimeVersion(value, errors);
  const capabilities = errors.length === capabilitiesBefore;
  // The server may confirm a NARROWER effective mode than the plain request/ceiling clamp (the
  // #2386 mode-change gate anchors it to the live run), but never a wider one: widening past the
  // clamp is the fail-closed contract boundary.
  if (
    isOneOf(value.requestedMode, CODING_WORKBENCH_MODES) &&
    isOneOf(value.deploymentCeiling, CODING_WORKBENCH_MODES) &&
    isOneOf(value.effectiveMode, CODING_WORKBENCH_MODES) &&
    isCodingWorkbenchModeWidening(
      resolveEffectiveCodingWorkbenchMode(value.requestedMode, value.deploymentCeiling),
      value.effectiveMode,
    )
  ) {
    errors.push("effectiveMode must not widen past requestedMode and deploymentCeiling");
  }
  const available = typeof value.runtimeAvailable === "boolean";
  if (!available) errors.push("runtimeAvailable is invalid");
  return [version, modes, reason, evidence, capabilities, available].every(Boolean);
}

/**
 * The unavailable reason is bound to the availability boolean in both directions: an available
 * runtime must not carry a reason, and an unavailable runtime must name one — a bare `false`
 * would reintroduce the unexplained-unavailability posture this field exists to end.
 */
function validateRuntimeUnavailableReason(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  const reason = value.runtimeUnavailableReason;
  if (reason !== undefined && !isOneOf(reason, CODING_WORKBENCH_RUNTIME_UNAVAILABLE_REASONS)) {
    errors.push("runtimeUnavailableReason is invalid");
    return false;
  }
  if (value.runtimeAvailable === true && reason !== undefined) {
    errors.push("runtimeUnavailableReason must be absent when the runtime is available");
  }
  if (value.runtimeAvailable === false && reason === undefined) {
    errors.push("runtimeUnavailableReason is required when the runtime is unavailable");
  }
  return true;
}
/**
 * The exact mirror of the unavailable reason, bound to the AVAILABLE branch. Requiring it there is
 * the load-bearing half: an optional field whose absence reads as "verified" would let an
 * unverified runtime render as plain green.
 */
function validateRuntimeEvidenceClass(value: Record<string, unknown>, errors: string[]): boolean {
  const evidenceClass = value.runtimeEvidenceClass;
  if (
    evidenceClass !== undefined &&
    !isOneOf(evidenceClass, CODING_WORKBENCH_RUNTIME_EVIDENCE_CLASSES)
  ) {
    errors.push("runtimeEvidenceClass is invalid");
    return false;
  }
  if (value.runtimeAvailable === true && evidenceClass === undefined) {
    errors.push("runtimeEvidenceClass is required when the runtime is available");
  }
  if (value.runtimeAvailable === false && evidenceClass !== undefined) {
    errors.push("runtimeEvidenceClass must be absent when the runtime is unavailable");
  }
  return true;
}

/**
 * The selectable agents are a closed, duplicate-free list that keeps the default agent. An absent,
 * unknown or default-less list is refused rather than read as "build only": a payload that could
 * advertise an agent this contract does not know must never reach the browser's agent switch.
 */
function validateSelectableAgents(value: Record<string, unknown>, errors: string[]): void {
  const agents = value.selectableAgents;
  if (
    !Array.isArray(agents) ||
    agents.length > CODING_WORKBENCH_AGENTS.length ||
    !agents.every(isCodingWorkbenchBuiltInAgent) ||
    new Set<unknown>(agents).size !== agents.length
  ) {
    errors.push("selectableAgents is invalid");
    return;
  }
  if (!agents.includes(DEFAULT_CODING_WORKBENCH_AGENT)) {
    errors.push("selectableAgents must include the default agent");
  }
}

// A release version: numeric core and an optional bounded pre-release, never a path or a range.
const RUNTIME_VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/u;

function isRuntimeVersionText(value: unknown): value is string {
  return typeof value === "string" && RUNTIME_VERSION_PATTERN.test(value);
}

/**
 * Absent reads as not reported. A present value names two release versions and a closed origin,
 * and only an available runtime may carry one.
 */
function validateRuntimeVersion(value: Record<string, unknown>, errors: string[]): void {
  const version = value.runtimeVersion;
  if (version === undefined) return;
  if (!isRecord(version)) {
    errors.push("runtimeVersion must be an object");
    return;
  }
  errors.push(...exactKeys(version, ["opencode", "pinned", "origin"], "runtimeVersion"));
  for (const field of ["opencode", "pinned"] as const) {
    if (!isRuntimeVersionText(version[field])) errors.push(`runtimeVersion.${field} is invalid`);
  }
  if (!isOneOf(version.origin, CODING_WORKBENCH_RUNTIME_ORIGINS)) {
    errors.push("runtimeVersion.origin is invalid");
  }
  if (value.runtimeAvailable !== true) {
    errors.push("runtimeVersion must be absent when the runtime is unavailable");
  }
}

/**
 * Absent reads as no prompt input; a present value is the booleans and nothing else. `delivery` and
 * `references` are always stated, `commands` may be absent (a server older than the command
 * surface never states it, which reads as false).
 */
function validatePromptInputs(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push("promptInputs must be an object");
    return;
  }
  errors.push(
    ...exactKeys(value, ["delivery", "references", "commands", "mentions"], "promptInputs"),
  );
  for (const field of ["delivery", "references"] as const) {
    if (typeof value[field] !== "boolean") errors.push(`promptInputs.${field} must be boolean`);
  }
  for (const field of ["commands", "mentions"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") {
      errors.push(`promptInputs.${field} must be boolean`);
    }
  }
}

export function validateCodingWorkbenchRuntimeSseEvent(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeSseEvent> {
  if (!isRecord(value)) return invalid("runtime SSE event must be an object");
  const errors = exactKeys(value, sseEventKeys(value.kind), "runtimeSseEvent");
  const admitted = checkSseEvent(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function checkSseEvent(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeSseEvent {
  return validateSseEventFields(
    value,
    errors,
    CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS,
    CODING_WORKBENCH_RUNTIME_SSE_EVENT_KINDS,
  );
}

function parseRequestIdOnly(
  value: unknown,
  path: string,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeStopRequest> {
  if (!isRecord(value)) return invalid(`${path} must be an object`);
  const errors = exactKeys(value, ["requestId"], path);
  const admitted = checkRequestIdOnly(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}
function validateSnapshotFields(value: Record<string, unknown>, errors: string[]): boolean {
  const version = value.schemaVersion === CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
  if (!version) errors.push("schemaVersion is invalid");
  const state = isOneOf(value.state, CODING_WORKBENCH_RUNTIME_STATE_NAMES);
  if (!state) errors.push("state is invalid");
  const revision = validateSnapshotRevision(value, errors);
  const updated = validateStrictUtcInstant(value.updatedAt, "updatedAt", errors);
  const optional = validateOptionalSnapshotFields(value, errors);
  const failure = validateFailureCode(value.failureCode, errors);
  const recovery = validateRecoveryAcknowledgement(value, errors);
  const pending = validatePendingPermission(value, errors);
  const pause = validatePauseReason(value, errors);
  return [version, state, revision, updated, optional, failure, recovery, pending, pause].every(
    Boolean,
  );
}

function validateSnapshotRevision(value: Record<string, unknown>, errors: string[]): boolean {
  if (!Number.isSafeInteger(value.revision)) {
    errors.push("revision must be a non-negative safe integer");
    return false;
  }
  const revision: unknown = value.revision;
  const admitted = validBoundedCount(revision, Number.MAX_SAFE_INTEGER);
  if (!admitted) errors.push("revision must be a non-negative safe integer");
  return admitted;
}

// A pause reason outside `paused` would describe a state the run is not in. The converse is
// deliberately permitted: an operator-initiated pause carries no reason, which is what `paused`
// meant before a governed tool could ask for a decision.
function validatePauseReason(value: Record<string, unknown>, errors: string[]): boolean {
  if (value.pauseReason === undefined) return true;
  if (!isOneOf(value.pauseReason, CODING_WORKBENCH_OPERATOR_DECISIONS)) {
    errors.push("pauseReason is invalid");
    return false;
  }
  if (value.state !== "paused") errors.push("pauseReason is only allowed when state is paused");
  return true;
}
function validateRecoveryAcknowledgement(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  if (value.recoveryAcknowledged === undefined) return true;
  const acknowledged = value.recoveryAcknowledged === true;
  if (!acknowledged) errors.push("recoveryAcknowledged must be true");
  if (value.state !== "recovery-required")
    errors.push("recoveryAcknowledged is only allowed when state is recovery-required");
  return acknowledged;
}
function validateOptionalSnapshotFields(value: Record<string, unknown>, errors: string[]): boolean {
  const run =
    value.runId === undefined ||
    validateSafeId(value.runId, "runId", errors, CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS);
  const requested = validateOptionalEnum(
    value.requestedMode,
    CODING_WORKBENCH_MODES,
    "requestedMode",
    errors,
  );
  const effective = validateOptionalEnum(
    value.effectiveMode,
    CODING_WORKBENCH_MODES,
    "effectiveMode",
    errors,
  );
  validateSnapshotModeRelationship(value, errors);
  const runtime = validateOptionalEnum(
    value.runtimeSource,
    CODING_WORKBENCH_RUNTIME_SOURCES,
    "runtimeSource",
    errors,
  );
  const model = validateOptionalEnum(
    value.modelSource,
    CODING_WORKBENCH_MODEL_SOURCES,
    "modelSource",
    errors,
  );
  return run && requested && effective && runtime && model;
}
function validateSnapshotModeRelationship(value: Record<string, unknown>, errors: string[]): void {
  const requested = value.requestedMode;
  const effective = value.effectiveMode;
  if (effective === undefined) return;
  if (!isOneOf(requested, CODING_WORKBENCH_MODES)) {
    errors.push("requestedMode is required when effectiveMode is present");
    return;
  }
  if (
    isOneOf(effective, CODING_WORKBENCH_MODES) &&
    isCodingWorkbenchModeWidening(requested, effective)
  ) {
    errors.push("effectiveMode must not widen past requestedMode");
  }
}

function validateOptionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  errors: string[],
): value is T | undefined {
  if (value !== undefined && !isOneOf(value, allowed)) {
    errors.push(`${path} is invalid`);
    return false;
  }
  return true;
}
function validatePendingPermission(value: Record<string, unknown>, errors: string[]): boolean {
  const awaitingApproval = value.state === "awaiting-approval";
  if (awaitingApproval && value.pendingPermission === undefined) {
    errors.push("pendingPermission is required when state is awaiting-approval");
    return false;
  }
  if (!awaitingApproval && value.pendingPermission !== undefined) {
    errors.push("pendingPermission is only allowed when state is awaiting-approval");
    return false;
  }
  if (value.pendingPermission === undefined) return true;
  const validation = validateCodingWorkbenchPermissionRequest(value.pendingPermission);
  if (!validation.ok)
    errors.push(...validation.errors.map((error) => `pendingPermission.${error}`));
  return validation.ok;
}
function validateFailureCode(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchRuntimeFailureCode | undefined {
  if (value !== undefined && !isOneOf(value, CODING_WORKBENCH_RUNTIME_FAILURE_CODES)) {
    errors.push("failureCode is invalid");
    return false;
  }
  return true;
}
function validateRequestId(value: unknown, errors: string[]): value is string {
  return validateSafeId(value, "requestId", errors, CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS);
}
