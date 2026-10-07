import type { CodingWorkbenchValidationResult } from "./coding-workbench.js";
import {
  exactKeys,
  invalid,
  isOneOf,
  isRecord,
  result,
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
  validateFeedBase(value, errors);
  if (value.availability === "available") validateAvailableFeed(value, errors);
  if (errors.length === 0 && serializedBytes(value) > CODING_SAFE_ACTIVITY_MAX_UTF8_BYTES) {
    errors.push("safeActivityFeed exceeds the aggregate UTF-8 byte budget");
  }
  return result(value, errors);
}

function feedKeys(availability: unknown): readonly string[] {
  const base = ["schemaVersion", "availability", "runId", "updatedAt", "droppedEventCount"];
  return availability === "available" ? [...base, "turns", "truncated", "plan"] : base;
}

function validateFeedBase(value: Record<string, unknown>, errors: string[]): void {
  if (value.schemaVersion !== CODING_SAFE_ACTIVITY_CONTRACT_VERSION) {
    errors.push("safeActivityFeed.schemaVersion is invalid");
  }
  if (value.availability !== "available" && value.availability !== "unavailable") {
    errors.push("safeActivityFeed.availability is invalid");
  }
  validateSafeId(value.runId, "safeActivityFeed.runId", errors, 128);
  validateUtcMilliseconds(value.updatedAt, "safeActivityFeed.updatedAt", errors);
  if (
    !Number.isSafeInteger(value.droppedEventCount) ||
    Number(value.droppedEventCount) < 0 ||
    Number(value.droppedEventCount) > CODING_SAFE_ACTIVITY_MAX_DROPPED_EVENT_COUNT
  ) {
    errors.push("safeActivityFeed.droppedEventCount is invalid");
  }
}

function validateAvailableFeed(value: Record<string, unknown>, errors: string[]): void {
  if (!Array.isArray(value.turns) || value.turns.length > CODING_SAFE_ACTIVITY_MAX_TURNS) {
    errors.push("safeActivityFeed.turns must be a bounded array");
  } else {
    const ids = { turns: new Set<string>(), messages: new Set<string>(), tools: new Set<string>() };
    value.turns.forEach((turn, index) => {
      validateTurn(turn, index, ids, errors);
    });
  }
  if (typeof value.truncated !== "boolean") {
    errors.push("safeActivityFeed.truncated must be a boolean");
  }
  if ("plan" in value) validatePlan(value.plan, errors);
}

function validatePlan(value: unknown, errors: string[]): void {
  const before = errors.length;
  const path = "safeActivityFeed.plan";
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  errors.push(
    ...exactKeys(value, ["revision", "anchorMessageId", "updatedAt", "steps", "truncated"], path),
  );
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) {
    errors.push(`${path}.revision must be a positive safe integer`);
  }
  validateSafeId(value.anchorMessageId, `${path}.anchorMessageId`, errors, 128);
  validateUtcMilliseconds(value.updatedAt, `${path}.updatedAt`, errors);
  validatePlanSteps(value.steps, path, errors);
  if (typeof value.truncated !== "boolean") errors.push(`${path}.truncated must be a boolean`);
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
}

function validatePlanSteps(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value) || value.length > CODING_SAFE_ACTIVITY_MAX_PLAN_STEPS) {
    errors.push(`${path}.steps must be a bounded array`);
    return;
  }
  value.forEach((step, index) => {
    validatePlanStep(step, `${path}.steps[${String(index)}]`, errors);
  });
}

function validatePlanStep(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  errors.push(...exactKeys(value, ["text", "state", "truncated"], path));
  if (
    typeof value.text !== "string" ||
    value.text.length < 1 ||
    value.text.length > CODING_SAFE_ACTIVITY_MAX_PLAN_STEP_TEXT_CHARS
  ) {
    errors.push(`${path}.text must be a bounded non-empty string`);
  } else if (stripUnsafeFormatChars(value.text) !== value.text) {
    errors.push(`${path}.text contains unsafe format characters`);
  }
  if (!isOneOf(value.state, CODING_SAFE_ACTIVITY_PLAN_STEP_STATES)) {
    errors.push(`${path}.state is invalid`);
  }
  if (typeof value.truncated !== "boolean") {
    errors.push(`${path}.truncated must be a boolean`);
  }
}

function planHasTruncatedStep(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value.steps) &&
    value.steps.some((step) => isRecord(step) && step.truncated === true)
  );
}

interface FeedIdentities {
  readonly turns: Set<string>;
  readonly messages: Set<string>;
  readonly tools: Set<string>;
}

function validateTurn(value: unknown, index: number, ids: FeedIdentities, errors: string[]): void {
  const before = errors.length;
  const path = `safeActivityFeed.turns[${String(index)}]`;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  errors.push(...exactKeys(value, ["turnId", "messages", "tools", "truncated"], path));
  validateUniqueId(value.turnId, `${path}.turnId`, ids.turns, errors);
  validateMessages(value.messages, path, ids.messages, errors);
  validateTools(value.tools, path, ids.tools, errors);
  if (typeof value.truncated !== "boolean") errors.push(`${path}.truncated must be a boolean`);
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
}

function validateMessages(value: unknown, path: string, ids: Set<string>, errors: string[]): void {
  if (!Array.isArray(value) || value.length > CODING_SAFE_ACTIVITY_MAX_MESSAGES_PER_TURN) {
    errors.push(`${path}.messages must be a bounded array`);
    return;
  }
  value.forEach((message, index) => {
    validateMessage(message, `${path}.messages[${String(index)}]`, ids, errors);
  });
}

function validateMessage(value: unknown, path: string, ids: Set<string>, errors: string[]): void {
  const before = errors.length;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  errors.push(
    ...exactKeys(
      value,
      ["messageId", "role", "occurredAt", "segments", "truncated", "reasoning"],
      path,
    ),
  );
  validateUniqueId(value.messageId, `${path}.messageId`, ids, errors);
  if (!isOneOf(value.role, CODING_SAFE_ACTIVITY_MESSAGE_ROLES)) {
    errors.push(`${path}.role is invalid`);
  }
  validateUtcMilliseconds(value.occurredAt, `${path}.occurredAt`, errors);
  validateSegments(value.segments, path, errors);
  if ("reasoning" in value) validateReasoning(value, path, errors);
  if (typeof value.truncated !== "boolean") errors.push(`${path}.truncated must be a boolean`);
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
}

function validateSegments(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value) || value.length > CODING_SAFE_ACTIVITY_MAX_SEGMENTS_PER_MESSAGE) {
    errors.push(`${path}.segments must be a bounded array`);
    return;
  }
  value.forEach((segment, index) => {
    const segmentPath = `${path}.segments[${String(index)}]`;
    if (!isRecord(segment)) {
      errors.push(`${segmentPath} must be an object`);
      return;
    }
    errors.push(...exactKeys(segment, ["kind", "text", "truncated"], segmentPath));
    if (segment.kind !== "text") errors.push(`${segmentPath}.kind is invalid`);
    if (
      typeof segment.text !== "string" ||
      segment.text.length < 1 ||
      segment.text.length > CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS
    ) {
      errors.push(`${segmentPath}.text must be a bounded non-empty string`);
    } else if (stripUnsafeFormatChars(segment.text) !== segment.text) {
      errors.push(`${segmentPath}.text contains unsafe format characters`);
    }
    if (typeof segment.truncated !== "boolean") {
      errors.push(`${segmentPath}.truncated must be a boolean`);
    }
  });
}

function validateReasoning(message: Record<string, unknown>, path: string, errors: string[]): void {
  const reasoningPath = `${path}.reasoning`;
  const value = message.reasoning;
  if (message.role !== "assistant") errors.push(`${reasoningPath} is only allowed on assistant`);
  if (!isRecord(value)) {
    errors.push(`${reasoningPath} must be an object`);
    return;
  }
  errors.push(...exactKeys(value, ["text", "truncated"], reasoningPath));
  if (
    typeof value.text !== "string" ||
    value.text.length < 1 ||
    utf8Bytes(value.text) > CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES
  ) {
    errors.push(`${reasoningPath}.text must be a bounded non-empty string`);
  } else if (stripUnsafeFormatChars(value.text) !== value.text) {
    errors.push(`${reasoningPath}.text contains unsafe format characters`);
  }
  if (typeof value.truncated !== "boolean") {
    errors.push(`${reasoningPath}.truncated must be a boolean`);
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function validateTools(value: unknown, path: string, ids: Set<string>, errors: string[]): void {
  if (!Array.isArray(value) || value.length > CODING_SAFE_ACTIVITY_MAX_TOOLS_PER_TURN) {
    errors.push(`${path}.tools must be a bounded array`);
    return;
  }
  value.forEach((tool, index) => {
    validateTool(tool, `${path}.tools[${String(index)}]`, ids, errors);
  });
}

function messageHasTruncatedSegment(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value.segments) &&
    value.segments.some((segment) => isRecord(segment) && segment.truncated === true)
  );
}

function turnHasTruncatedMessage(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value.messages) &&
    value.messages.some((message) => isRecord(message) && message.truncated === true)
  );
}

function validateTool(value: unknown, path: string, ids: Set<string>, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  errors.push(...exactKeys(value, ["callId", "tool", "state", "occurredAt", "presentation"], path));
  validateUniqueId(value.callId, `${path}.callId`, ids, errors);
  validateSafeId(value.tool, `${path}.tool`, errors, CODING_SAFE_ACTIVITY_TOOL_LABEL_MAX_CHARS);
  if (!isOneOf(value.state, CODING_SAFE_ACTIVITY_TOOL_STATES)) {
    errors.push(`${path}.state is invalid`);
  }
  validateUtcMilliseconds(value.occurredAt, `${path}.occurredAt`, errors);
  if (
    value.presentation !== undefined &&
    !isCodingSafeActivityToolPresentation(value.presentation)
  ) {
    errors.push(`${path}.presentation is invalid`);
  }
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
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function validateUniqueId(value: unknown, path: string, ids: Set<string>, errors: string[]): void {
  const before = errors.length;
  validateSafeId(value, path, errors, 128);
  if (errors.length !== before || typeof value !== "string") return;
  if (ids.has(value)) errors.push(`${path} must be unique`);
  else ids.add(value);
}

function validateUtcMilliseconds(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    errors.push(`${path} must be a strict UTC millisecond instant`);
    return;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== value) {
    errors.push(`${path} must be a strict UTC millisecond instant`);
  }
}

function serializedBytes(value: object): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
