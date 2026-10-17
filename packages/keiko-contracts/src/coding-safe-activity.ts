import type { CodingWorkbenchValidationResult } from "./coding-workbench.js";
import {
  exactKeys,
  invalid,
  isOneOf,
  isRecord,
  validateSafeId,
} from "./coding-workbench-runtime-api-validation.js";
import { stripUnsafeFormatChars } from "./text-safety.js";
import { isPortableWorkspaceRelativePath } from "./workspace-contract-primitives.js";
import { EDITOR_AGENT_CONFLICT_CODES, EDITOR_AGENT_FAILURE_CODES } from "./editor-agent.js";

export const CODING_SAFE_ACTIVITY_CONTRACT_VERSION = "1" as const;
export const CODING_SAFE_ACTIVITY_MESSAGE_ROLES = ["user", "assistant"] as const;
export const CODING_SAFE_ACTIVITY_TOOL_STATES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "denied",
  "cancelled",
] as const;
export const CODING_SAFE_ACTIVITY_PLAN_STEP_STATES = [
  "pending",
  "active",
  "completed",
  "cancelled",
] as const;
export const CODING_SAFE_ACTIVITY_MAX_TURNS = 32;
export const CODING_SAFE_ACTIVITY_MAX_MESSAGES_PER_TURN = 16;
export const CODING_SAFE_ACTIVITY_MAX_SEGMENTS_PER_MESSAGE = 32;
export const CODING_SAFE_ACTIVITY_MAX_TOOLS_PER_TURN = 64;
export const CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS = 4_096;
export const CODING_SAFE_ACTIVITY_MAX_MESSAGE_UTF8_BYTES = 16 * 1_024;
// #3878: an assistant message's model reasoning keeps to half of the message budget, so the answer
// always keeps room of its own.
export const CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES = 8 * 1_024;
export const CODING_SAFE_ACTIVITY_MAX_TURN_UTF8_BYTES = 32 * 1_024;
// Leaves serialization reserve for the authenticated channel's tagged snapshot wrapper.
export const CODING_SAFE_ACTIVITY_MAX_UTF8_BYTES = 60 * 1_024;
export const CODING_SAFE_ACTIVITY_MAX_DROPPED_EVENT_COUNT = 65_535;
export const CODING_SAFE_ACTIVITY_TOOL_LABEL_MAX_CHARS = 128;
export const CODING_SAFE_ACTIVITY_MAX_PLAN_STEPS = 64;
export const CODING_SAFE_ACTIVITY_MAX_PLAN_STEP_TEXT_CHARS = 256;
// Fits inside the aggregate feed budget beside a fully populated turn history.
export const CODING_SAFE_ACTIVITY_MAX_PLAN_UTF8_BYTES = 8 * 1_024;

/** The existing governed edit facade's closed refusal vocabulary, shared with its live UI. */
export const CODING_SAFE_ACTIVITY_EDIT_REFUSAL_REASON_CODES = [
  ...EDITOR_AGENT_CONFLICT_CODES,
  ...EDITOR_AGENT_FAILURE_CODES,
  "RESPONSE_TOO_LARGE",
  "TRANSPORT_FAILURE",
  "REDIRECT_BLOCKED",
  "EDIT_TRANSPORT_ERROR",
  "EDIT_PREPARE_FAILED",
  "WORKSPACE_ACCESS_LOST",
  "EDIT_MUTATION_FAILED",
  "ci-observation-required",
] as const;
export type CodingSafeActivityEditRefusalReason =
  (typeof CODING_SAFE_ACTIVITY_EDIT_REFUSAL_REASON_CODES)[number];

/** Canonical server facts only. Live authenticated presentation; never Activity Log evidence. */
export interface CodingSafeActivityToolPresentation {
  /** The workspace-contained file a completed governed read actually returned. */
  readonly relativePath?: string;
  /** The authoritative file at which edit materialization refused; absent if unknown. */
  readonly affectedRelativePath?: string;
  /** Bytes in the returned read window, not the whole file. */
  readonly readByteCount?: number;
  /** Line count of the whole read file, not the returned window. */
  readonly totalFileLines?: number;
  /** Actual discovery items returned after filtering and limits, not inventory or text lines. */
  readonly returnedPathCount?: number;
  readonly refusalReason?: CodingSafeActivityEditRefusalReason;
  /** Elapsed bridge service time; includes governed waits, excludes model generation time. */
  readonly bridgeDurationMs?: number;
}

export type CodingSafeActivityMessageRole = (typeof CODING_SAFE_ACTIVITY_MESSAGE_ROLES)[number];
export type CodingSafeActivityToolState = (typeof CODING_SAFE_ACTIVITY_TOOL_STATES)[number];
export type CodingSafeActivityPlanStepState =
  (typeof CODING_SAFE_ACTIVITY_PLAN_STEP_STATES)[number];

/**
 * Untrusted runtime text. Consumers must render it through escaped text nodes or Keiko's vetted
 * SafeMarkdown renderer; never inject raw markup or executable content.
 */
export interface CodingSafeActivityTextSegment {
  readonly kind: "text";
  readonly text: string;
  /** True when the segment was shortened to remain inside a declared projection bound. */
  readonly truncated: boolean;
}

/**
 * #3878: the model's own reasoning beside an assistant message, as the provider returned it
 * (`reasoning_content`). Untrusted, unverified model text: consumers render it as escaped text,
 * label it as unverified model reasoning and never treat it as the answer. Live content only — it
 * never enters Coding History, evidence, a support export or the Activity Log.
 */
export interface CodingSafeActivityReasoning {
  readonly text: string;
  /** True when the reasoning was shortened to remain inside its declared projection bound. */
  readonly truncated: boolean;
}

export interface CodingSafeActivityMessage {
  readonly messageId: string;
  readonly role: CodingSafeActivityMessageRole;
  readonly occurredAt: string;
  readonly segments: readonly CodingSafeActivityTextSegment[];
  readonly truncated: boolean;
  /** Assistant messages only; absent when the model returned no reasoning or it is not shown. */
  readonly reasoning?: CodingSafeActivityReasoning;
}

export interface CodingSafeActivityTool {
  readonly callId: string;
  /** Closed-adapter safe label only; raw arguments/results and provider data are absent. */
  readonly tool: string;
  readonly state: CodingSafeActivityToolState;
  readonly occurredAt: string;
  readonly presentation?: CodingSafeActivityToolPresentation;
}

export interface CodingSafeActivityTurn {
  readonly turnId: string;
  readonly messages: readonly CodingSafeActivityMessage[];
  readonly tools: readonly CodingSafeActivityTool[];
  /** True when a message, segment, tool, or byte-budget eviction removed part of this turn. */
  readonly truncated: boolean;
}

/** Untrusted plan step text. Consumers must render this as text, never markup or executable content. */
export interface CodingSafeActivityPlanStep {
  readonly text: string;
  readonly state: CodingSafeActivityPlanStepState;
  /** True when the step text was shortened to remain inside a declared projection bound. */
  readonly truncated: boolean;
}

export interface CodingSafeActivityPlan {
  /** Monotonic projection-assigned revision anchoring live plan updates for consumers. */
  readonly revision: number;
  /** Assistant message that carried the latest accepted plan update. */
  readonly anchorMessageId: string;
  readonly updatedAt: string;
  readonly steps: readonly CodingSafeActivityPlanStep[];
  /** True when steps were dropped or clipped to stay inside the declared plan bounds. */
  readonly truncated: boolean;
}

export interface AvailableCodingSafeActivityFeed {
  readonly schemaVersion: typeof CODING_SAFE_ACTIVITY_CONTRACT_VERSION;
  readonly availability: "available";
  readonly runId: string;
  readonly updatedAt: string;
  readonly turns: readonly CodingSafeActivityTurn[];
  /** Latest agent-maintained plan snapshot; absent until the first accepted plan update. */
  readonly plan?: CodingSafeActivityPlan;
  /** True when whole turns were evicted from the bounded feed. */
  readonly truncated: boolean;
  readonly droppedEventCount: number;
}

export interface UnavailableCodingSafeActivityFeed {
  readonly schemaVersion: typeof CODING_SAFE_ACTIVITY_CONTRACT_VERSION;
  readonly availability: "unavailable";
  readonly runId: string;
  readonly updatedAt: string;
  readonly droppedEventCount: number;
}

export type CodingSafeActivityFeed =
  AvailableCodingSafeActivityFeed | UnavailableCodingSafeActivityFeed;

export function unavailableCodingSafeActivityFeed(
  runId: string,
  updatedAt: string,
): UnavailableCodingSafeActivityFeed {
  return {
    schemaVersion: CODING_SAFE_ACTIVITY_CONTRACT_VERSION,
    availability: "unavailable",
    runId,
    updatedAt,
    droppedEventCount: 0,
  };
}

export function validateCodingSafeActivityFeed(
  value: unknown,
): CodingWorkbenchValidationResult<CodingSafeActivityFeed> {
  try {
    return validateFeed(value);
  } catch {
    return invalid("safe activity feed validation failed");
  }
}

function validateFeed(value: unknown): CodingWorkbenchValidationResult<CodingSafeActivityFeed> {
  if (!isRecord(value)) return invalid("safe activity feed must be an object");
  const errors = exactKeys(value, feedKeys(value.availability), "safeActivityFeed");
  const admitted = checkFeed(value, errors);
  if (errors.length === 0 && serializedBytes(value) > CODING_SAFE_ACTIVITY_MAX_UTF8_BYTES) {
    errors.push("safeActivityFeed exceeds the aggregate UTF-8 byte budget");
  }
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function checkFeed(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingSafeActivityFeed {
  const base = validateFeedBase(value, errors);
  const availability: unknown = value.availability;
  const variant =
    availability === "available"
      ? validateAvailableFeed(value, errors)
      : availability === "unavailable";
  if (availability !== "available" && availability !== "unavailable") {
    const diagnostic = "safeActivityFeed.availability is invalid";
    if (!errors.includes(diagnostic)) errors.push(diagnostic);
  }
  return base && variant;
}

function feedKeys(availability: unknown): readonly string[] {
  const base = ["schemaVersion", "availability", "runId", "updatedAt", "droppedEventCount"];
  return availability === "available" ? [...base, "turns", "truncated", "plan"] : base;
}

function validateFeedBase(value: Record<string, unknown>, errors: string[]): boolean {
  const version = value.schemaVersion === CODING_SAFE_ACTIVITY_CONTRACT_VERSION;
  if (!version) {
    errors.push("safeActivityFeed.schemaVersion is invalid");
  }
  const availability = value.availability === "available" || value.availability === "unavailable";
  if (!availability) {
    errors.push("safeActivityFeed.availability is invalid");
  }
  const run = validateSafeId(value.runId, "safeActivityFeed.runId", errors, 128);
  const updated = validateUtcMilliseconds(value.updatedAt, "safeActivityFeed.updatedAt", errors);
  const dropped = validDroppedEventCount(value);
  if (!dropped) {
    errors.push("safeActivityFeed.droppedEventCount is invalid");
  }
  return version && availability && run && updated && dropped;
}

function validDroppedEventCount(value: Record<string, unknown>): boolean {
  if (!Number.isSafeInteger(value.droppedEventCount)) return false;
  const lower: unknown = value.droppedEventCount;
  if (typeof lower !== "number" || !Number.isSafeInteger(lower) || lower < 0) return false;
  const upper: unknown = value.droppedEventCount;
  return (
    typeof upper === "number" &&
    Number.isSafeInteger(upper) &&
    upper <= CODING_SAFE_ACTIVITY_MAX_DROPPED_EVENT_COUNT &&
    upper >= 0
  );
}

function validPlanRevision(value: Record<string, unknown>): boolean {
  if (!Number.isSafeInteger(value.revision)) return false;
  const revision: unknown = value.revision;
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 1;
}

function validateAvailableFeed(value: Record<string, unknown>, errors: string[]): boolean {
  const turns = validateFeedTurns(value, errors);
  const truncated = typeof value.truncated === "boolean";
  if (!truncated) errors.push("safeActivityFeed.truncated must be a boolean");
  const plan = !("plan" in value) || validatePlan(value.plan, errors);
  return turns && truncated && plan;
}

function validateFeedTurns(value: Record<string, unknown>, errors: string[]): boolean {
  if (!Array.isArray(value.turns) || value.turns.length > CODING_SAFE_ACTIVITY_MAX_TURNS) {
    errors.push("safeActivityFeed.turns must be a bounded array");
    return false;
  }
  const turns: unknown = value.turns;
  if (!Array.isArray(turns)) {
    errors.push("safeActivityFeed.turns must be a bounded array");
    return false;
  }
  const ids = { turns: new Set<string>(), messages: new Set<string>(), tools: new Set<string>() };
  const count = turns.length;
  let admitted = true;
  for (let index = 0; index < count; index += 1) {
    if (!(index in turns)) {
      errors.push(`safeActivityFeed.turns[${String(index)}] must be an object`);
      return false;
    }
    const turn: unknown = turns[index];
    admitted = validateTurn(turn, index, ids, errors) && admitted;
  }
  return admitted;
}

function validatePlan(value: unknown, errors: string[]): value is CodingSafeActivityPlan {
  const before = errors.length;
  const path = "safeActivityFeed.plan";
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  errors.push(
    ...exactKeys(value, ["revision", "anchorMessageId", "updatedAt", "steps", "truncated"], path),
  );
  const revision = validPlanRevision(value);
  if (!revision) {
    errors.push(`${path}.revision must be a positive safe integer`);
  }
  const anchor = validateSafeId(value.anchorMessageId, `${path}.anchorMessageId`, errors, 128);
  const updated = validateUtcMilliseconds(value.updatedAt, `${path}.updatedAt`, errors);
  const steps = validatePlanSteps(value.steps, path, errors);
  const truncated = typeof value.truncated === "boolean";
  if (!truncated) errors.push(`${path}.truncated must be a boolean`);
  if (planHasTruncatedStep(value) && value.truncated !== true) {
    errors.push(`${path}.truncated must reflect truncated steps`);
  }
  // KEIKO-0749: mirror validateFeed's guard — only serialise for the byte budget check when the
  // structure is otherwise valid. serializedBytes runs JSON.stringify over the entire nested
  // object; running it on a value the caller has already failed shape-validation on wastes work.
  if (
    errors.length === before &&
    serializedBytes(value) > CODING_SAFE_ACTIVITY_MAX_PLAN_UTF8_BYTES
  ) {
    errors.push(`${path} exceeds the plan UTF-8 byte budget`);
  }
  return [revision, anchor, updated, steps, truncated].every(Boolean);
}

function validatePlanSteps(
  value: unknown,
  path: string,
  errors: string[],
): value is readonly CodingSafeActivityPlanStep[] {
  if (!Array.isArray(value) || value.length > CODING_SAFE_ACTIVITY_MAX_PLAN_STEPS) {
    errors.push(`${path}.steps must be a bounded array`);
    return false;
  }
  const count = value.length;
  let admitted = true;
  for (let index = 0; index < count; index += 1) {
    const memberPath = `${path}.steps[${String(index)}]`;
    if (!(index in value)) {
      errors.push(`${memberPath} must be an object`);
      return false;
    }
    const member: unknown = value[index];
    admitted = validatePlanStep(member, memberPath, errors) && admitted;
  }
  return admitted;
}

function validatePlanStep(
  value: unknown,
  path: string,
  errors: string[],
): value is CodingSafeActivityPlanStep {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  errors.push(...exactKeys(value, ["text", "state", "truncated"], path));
  let text = true;
  if (
    typeof value.text !== "string" ||
    value.text.length < 1 ||
    value.text.length > CODING_SAFE_ACTIVITY_MAX_PLAN_STEP_TEXT_CHARS
  ) {
    text = false;
    errors.push(`${path}.text must be a bounded non-empty string`);
  } else if (stripUnsafeFormatChars(value.text) !== value.text) {
    errors.push(`${path}.text contains unsafe format characters`);
    text = false;
  }
  const state = isOneOf(value.state, CODING_SAFE_ACTIVITY_PLAN_STEP_STATES);
  if (!state) errors.push(`${path}.state is invalid`);
  const truncated = typeof value.truncated === "boolean";
  if (!truncated) {
    errors.push(`${path}.truncated must be a boolean`);
  }
  return text && state && truncated;
}

function planHasTruncatedStep(value: Record<string, unknown>): boolean {
  if (!Array.isArray(value.steps)) return false;
  const entries: unknown = value.steps;
  if (!Array.isArray(entries)) return false;
  const count = entries.length;
  for (let index = 0; index < count; index += 1) {
    if (!(index in entries)) continue;
    const step: unknown = entries[index];
    if (isRecord(step) && step.truncated === true) return true;
  }
  return false;
}

interface FeedIdentities {
  readonly turns: Set<string>;
  readonly messages: Set<string>;
  readonly tools: Set<string>;
}

function validateTurn(
  value: unknown,
  index: number,
  ids: FeedIdentities,
  errors: string[],
): value is CodingSafeActivityTurn {
  const before = errors.length;
  const path = `safeActivityFeed.turns[${String(index)}]`;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  errors.push(...exactKeys(value, ["turnId", "messages", "tools", "truncated"], path));
  const turn = validateUniqueId(value.turnId, `${path}.turnId`, ids.turns, errors);
  const messages = validateMessages(value.messages, path, ids.messages, errors);
  const tools = validateTools(value.tools, path, ids.tools, errors);
  const truncated = typeof value.truncated === "boolean";
  if (!truncated) errors.push(`${path}.truncated must be a boolean`);
  if (turnHasTruncatedMessage(value) && value.truncated !== true) {
    errors.push(`${path}.truncated must reflect truncated messages`);
  }
  // KEIKO-0749: only run the deep serializedBytes call when the structure is otherwise valid,
  // mirroring validateFeed's own guard.
  if (
    errors.length === before &&
    serializedBytes(value) > CODING_SAFE_ACTIVITY_MAX_TURN_UTF8_BYTES
  ) {
    errors.push(`${path} exceeds the turn UTF-8 byte budget`);
  }
  return turn && messages && tools && truncated;
}

function validateMessages(
  value: unknown,
  path: string,
  ids: Set<string>,
  errors: string[],
): value is readonly CodingSafeActivityMessage[] {
  if (!Array.isArray(value) || value.length > CODING_SAFE_ACTIVITY_MAX_MESSAGES_PER_TURN) {
    errors.push(`${path}.messages must be a bounded array`);
    return false;
  }
  const count = value.length;
  let admitted = true;
  for (let index = 0; index < count; index += 1) {
    const memberPath = `${path}.messages[${String(index)}]`;
    if (!(index in value)) {
      errors.push(`${memberPath} must be an object`);
      return false;
    }
    const member: unknown = value[index];
    admitted = validateMessage(member, memberPath, ids, errors) && admitted;
  }
  return admitted;
}

function validateMessage(
  value: unknown,
  path: string,
  ids: Set<string>,
  errors: string[],
): value is CodingSafeActivityMessage {
  const before = errors.length;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  errors.push(
    ...exactKeys(
      value,
      ["messageId", "role", "occurredAt", "segments", "truncated", "reasoning"],
      path,
    ),
  );
  const message = validateUniqueId(value.messageId, `${path}.messageId`, ids, errors);
  const role = isOneOf(value.role, CODING_SAFE_ACTIVITY_MESSAGE_ROLES);
  if (!role) {
    errors.push(`${path}.role is invalid`);
  }
  const occurred = validateUtcMilliseconds(value.occurredAt, `${path}.occurredAt`, errors);
  const segments = validateSegments(value.segments, path, errors);
  const reasoning = !("reasoning" in value) || validateReasoning(value, path, errors);
  const truncated = typeof value.truncated === "boolean";
  if (!truncated) errors.push(`${path}.truncated must be a boolean`);
  if (messageHasTruncatedSegment(value) && value.truncated !== true) {
    errors.push(`${path}.truncated must reflect truncated segments`);
  }
  // KEIKO-0749: only run the deep serializedBytes call when the structure is otherwise valid.
  if (
    errors.length === before &&
    serializedBytes(value) > CODING_SAFE_ACTIVITY_MAX_MESSAGE_UTF8_BYTES
  ) {
    errors.push(`${path} exceeds the message UTF-8 byte budget`);
  }
  return [message, role, occurred, segments, reasoning, truncated].every(Boolean);
}

function validateSegments(
  value: unknown,
  path: string,
  errors: string[],
): value is readonly CodingSafeActivityTextSegment[] {
  if (!Array.isArray(value) || value.length > CODING_SAFE_ACTIVITY_MAX_SEGMENTS_PER_MESSAGE) {
    errors.push(`${path}.segments must be a bounded array`);
    return false;
  }
  const count = value.length;
  let admitted = true;
  for (let index = 0; index < count; index += 1) {
    const segmentPath = `${path}.segments[${String(index)}]`;
    if (!(index in value)) {
      errors.push(`${segmentPath} must be an object`);
      return false;
    }
    const segment: unknown = value[index];
    admitted = validateSegment(segment, segmentPath, errors) && admitted;
  }
  return admitted;
}

function validateSegment(
  value: unknown,
  path: string,
  errors: string[],
): value is CodingSafeActivityTextSegment {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  errors.push(...exactKeys(value, ["kind", "text", "truncated"], path));
  const kind = value.kind === "text";
  if (!kind) errors.push(`${path}.kind is invalid`);
  let text = true;
  if (
    typeof value.text !== "string" ||
    value.text.length < 1 ||
    value.text.length > CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS
  ) {
    text = false;
    errors.push(`${path}.text must be a bounded non-empty string`);
  } else if (stripUnsafeFormatChars(value.text) !== value.text) {
    errors.push(`${path}.text contains unsafe format characters`);
    text = false;
  }
  const truncated = typeof value.truncated === "boolean";
  if (!truncated) errors.push(`${path}.truncated must be a boolean`);
  return kind && text && truncated;
}

function validateReasoning(
  message: Record<string, unknown>,
  path: string,
  errors: string[],
): boolean {
  const reasoningPath = `${path}.reasoning`;
  const value = message.reasoning;
  if (message.role !== "assistant") errors.push(`${reasoningPath} is only allowed on assistant`);
  if (!isRecord(value)) {
    errors.push(`${reasoningPath} must be an object`);
    return false;
  }
  errors.push(...exactKeys(value, ["text", "truncated"], reasoningPath));
  let text = true;
  if (
    typeof value.text !== "string" ||
    value.text.length < 1 ||
    utf8Bytes(value.text) > CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES
  ) {
    text = false;
    errors.push(`${reasoningPath}.text must be a bounded non-empty string`);
  } else if (stripUnsafeFormatChars(value.text) !== value.text) {
    errors.push(`${reasoningPath}.text contains unsafe format characters`);
    text = false;
  }
  const truncated = typeof value.truncated === "boolean";
  if (!truncated) {
    errors.push(`${reasoningPath}.truncated must be a boolean`);
  }
  return text && truncated;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function validateTools(
  value: unknown,
  path: string,
  ids: Set<string>,
  errors: string[],
): value is readonly CodingSafeActivityTool[] {
  if (!Array.isArray(value) || value.length > CODING_SAFE_ACTIVITY_MAX_TOOLS_PER_TURN) {
    errors.push(`${path}.tools must be a bounded array`);
    return false;
  }
  const count = value.length;
  let admitted = true;
  for (let index = 0; index < count; index += 1) {
    const memberPath = `${path}.tools[${String(index)}]`;
    if (!(index in value)) {
      errors.push(`${memberPath} must be an object`);
      return false;
    }
    const member: unknown = value[index];
    admitted = validateTool(member, memberPath, ids, errors) && admitted;
  }
  return admitted;
}

function messageHasTruncatedSegment(value: Record<string, unknown>): boolean {
  if (!Array.isArray(value.segments)) return false;
  const entries: unknown = value.segments;
  if (!Array.isArray(entries)) return false;
  const count = entries.length;
  for (let index = 0; index < count; index += 1) {
    if (!(index in entries)) continue;
    const segment: unknown = entries[index];
    if (isRecord(segment) && segment.truncated === true) return true;
  }
  return false;
}

function turnHasTruncatedMessage(value: Record<string, unknown>): boolean {
  if (!Array.isArray(value.messages)) return false;
  const entries: unknown = value.messages;
  if (!Array.isArray(entries)) return false;
  const count = entries.length;
  for (let index = 0; index < count; index += 1) {
    if (!(index in entries)) continue;
    const message: unknown = entries[index];
    if (isRecord(message) && message.truncated === true) return true;
  }
  return false;
}

function validateTool(
  value: unknown,
  path: string,
  ids: Set<string>,
  errors: string[],
): value is CodingSafeActivityTool {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  errors.push(...exactKeys(value, ["callId", "tool", "state", "occurredAt", "presentation"], path));
  const call = validateUniqueId(value.callId, `${path}.callId`, ids, errors);
  const tool = validateSafeId(
    value.tool,
    `${path}.tool`,
    errors,
    CODING_SAFE_ACTIVITY_TOOL_LABEL_MAX_CHARS,
  );
  const state = isOneOf(value.state, CODING_SAFE_ACTIVITY_TOOL_STATES);
  if (!state) {
    errors.push(`${path}.state is invalid`);
  }
  const occurred = validateUtcMilliseconds(value.occurredAt, `${path}.occurredAt`, errors);
  const presentation =
    value.presentation === undefined || isCodingSafeActivityToolPresentation(value.presentation);
  if (!presentation) {
    errors.push(`${path}.presentation is invalid`);
  }
  return call && tool && state && occurred && presentation;
}

export function isCodingSafeActivityToolPresentation(
  value: unknown,
): value is CodingSafeActivityToolPresentation {
  if (!isRecord(value) || Object.keys(value).length === 0) return false;
  const allowed = [
    "relativePath",
    "affectedRelativePath",
    "readByteCount",
    "totalFileLines",
    "returnedPathCount",
    "refusalReason",
    "bridgeDurationMs",
  ];
  if (exactKeys(value, allowed, "presentation").length > 0) return false;
  if (!validPresentationPaths(value) || !validPresentationCounts(value)) return false;
  return (
    value.refusalReason === undefined ||
    isOneOf(value.refusalReason, CODING_SAFE_ACTIVITY_EDIT_REFUSAL_REASON_CODES)
  );
}

function validPresentationPaths(value: Record<string, unknown>): boolean {
  return ["relativePath", "affectedRelativePath"].every(
    (key) => value[key] === undefined || isCodingSafeActivityPresentationPath(value[key]),
  );
}

function validPresentationCounts(value: Record<string, unknown>): boolean {
  return ["readByteCount", "totalFileLines", "returnedPathCount", "bridgeDurationMs"].every(
    (key) => {
      const count = value[key];
      return (
        count === undefined ||
        (typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
      );
    },
  );
}

/** Reuses the workspace path contract and excludes deceptive/control characters from UI labels. */
export function isCodingSafeActivityPresentationPath(value: unknown): value is string {
  return (
    isPortableWorkspaceRelativePath(value) &&
    stripUnsafeFormatChars(value) === value &&
    displayPathHasNoControls(value)
  );
}

function displayPathHasNoControls(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function validateUniqueId(
  value: unknown,
  path: string,
  ids: Set<string>,
  errors: string[],
): value is string {
  const admitted = validateSafeId(value, path, errors, 128);
  if (!admitted || typeof value !== "string") return false;
  if (ids.has(value)) errors.push(`${path} must be unique`);
  else ids.add(value);
  return true;
}

function validateUtcMilliseconds(value: unknown, path: string, errors: string[]): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    errors.push(`${path} must be a strict UTC millisecond instant`);
    return false;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== value) {
    errors.push(`${path} must be a strict UTC millisecond instant`);
    return false;
  }
  return true;
}

function serializedBytes(value: object): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
