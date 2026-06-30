// Parsing + validation of the `POST /api/runs` request body (ADR-0011 D5 route 5). The body arrives
// as untyped JSON; this module narrows it (no `any`) into a typed `RunRequest` or a typed validation
// error. It performs SHAPE validation only — exactly one of workflowId/taskType, a present input
// object, a non-empty modelId, and a selected project workspaceRoot. The create route is ALWAYS
// dry-run: `apply` is forced false here regardless of the body, so applying is reachable only via
// the gated apply route (D8). The deeper guards (`isSensitivePath`, patch limits, target validation)
// are enforced by the workflow/harness entry points the engine calls; the BFF never reimplements
// them.

import {
  type SpokenActionAuditRecord,
  type VoiceProfile,
  type VoiceTranscriptSource,
} from "@oscharko-dev/keiko-contracts";
import type { WorkflowHandoffRequest } from "@oscharko-dev/keiko-contracts/workflow-handoff";

export type RunKind = "unit-tests" | "bug-investigation" | "explain-plan" | "verify";

export interface RunVoiceOrigin {
  readonly profile: VoiceProfile;
  readonly turnIndex: number;
  readonly source: VoiceTranscriptSource;
  readonly committedSegments: number;
  readonly committedText: string;
  readonly confirmationDigest: string | undefined;
}

export interface RunRequest {
  readonly kind: RunKind;
  readonly modelId: string;
  readonly apply: boolean;
  // The workflow/task input object, passed through to the entry point after shape validation.
  readonly input: Record<string, unknown>;
  // Optional per-run limits, passed through to the workflow/harness.
  readonly limits: Record<string, unknown> | undefined;
  // Present only for governed grounded-context workflow launches.
  readonly governedHandoff?: WorkflowHandoffRequest | undefined;
  readonly governedHandoffSourceGroundedRunId?: string | undefined;
  // Present only on inbound voice-originated governed handoffs. It carries the committed transcript
  // transiently so `POST /api/runs` can recompute governance server-side; it is never persisted.
  readonly governedHandoffVoiceOrigin?: RunVoiceOrigin | undefined;
  // Present only after server-side governance succeeds: the content-free audit record of the spoken
  // action that governed this run, threaded into evidence.
  readonly governedHandoffVoiceAction?: SpokenActionAuditRecord | undefined;
}

export interface RunRequestError {
  readonly code: "BAD_REQUEST";
  readonly message: string;
}

interface RunRequestCore {
  readonly kind: RunKind;
  readonly modelId: string;
  readonly input: Record<string, unknown>;
  readonly limits: Record<string, unknown> | undefined;
}

interface GovernedHandoffMetadata {
  readonly governedHandoff: WorkflowHandoffRequest | undefined;
  readonly governedHandoffSourceGroundedRunId: string | undefined;
  readonly governedHandoffVoiceOrigin: RunVoiceOrigin | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const VOICE_PROFILES: readonly VoiceProfile[] = [
  "none",
  "speech-to-text",
  "speech-output",
  "full-realtime",
] as const;
const VOICE_TRANSCRIPT_SOURCES: readonly VoiceTranscriptSource[] = ["dictation", "realtime"];
const MAX_VOICE_COMMITTED_TEXT_CHARS = 8192;
const MAX_VOICE_TURN_INDEX = 1_000_000;
const MAX_VOICE_COMMITTED_SEGMENTS = 10_000;
const CONFIRMATION_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function badRequest(message: string): RunRequestError {
  return { code: "BAD_REQUEST", message };
}

function isRunRequestError(value: unknown): value is RunRequestError {
  return isRecord(value) && value.code === "BAD_REQUEST" && typeof value.message === "string";
}

function isVoiceProfile(value: unknown): value is VoiceProfile {
  return typeof value === "string" && (VOICE_PROFILES as readonly string[]).includes(value);
}

function isRunVoiceTranscriptSource(value: unknown): value is VoiceTranscriptSource {
  return (
    typeof value === "string" && (VOICE_TRANSCRIPT_SOURCES as readonly string[]).includes(value)
  );
}

function isBoundedNonNegativeInteger(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

function parseOptionalString(
  body: Record<string, unknown>,
  name: string,
): string | undefined | RunRequestError {
  const value = body[name];
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" ? value : badRequest(`${name} must be a string when provided.`);
}

function parseConfirmationDigest(value: unknown): string | undefined | RunRequestError {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !CONFIRMATION_DIGEST_PATTERN.test(value)) {
    return badRequest("voiceOrigin.confirmationDigest must be a 64-char lowercase sha256 hex.");
  }
  return value;
}

function parseVoiceOriginFields(value: Record<string, unknown>): RunVoiceOrigin | RunRequestError {
  if (!isVoiceProfile(value.profile)) {
    return badRequest("voiceOrigin.profile is invalid.");
  }
  if (!isBoundedNonNegativeInteger(value.turnIndex, MAX_VOICE_TURN_INDEX)) {
    return badRequest("voiceOrigin.turnIndex must be a bounded non-negative integer.");
  }
  if (!isRunVoiceTranscriptSource(value.source)) {
    return badRequest("voiceOrigin.source is invalid.");
  }
  if (!isBoundedNonNegativeInteger(value.committedSegments, MAX_VOICE_COMMITTED_SEGMENTS)) {
    return badRequest("voiceOrigin.committedSegments must be a bounded non-negative integer.");
  }
  if (
    typeof value.committedText !== "string" ||
    value.committedText.length > MAX_VOICE_COMMITTED_TEXT_CHARS
  ) {
    return badRequest("voiceOrigin.committedText must be a string within the size limit.");
  }
  const confirmationDigest = parseConfirmationDigest(value.confirmationDigest);
  if (typeof confirmationDigest === "object") {
    return confirmationDigest;
  }
  return {
    profile: value.profile,
    turnIndex: value.turnIndex,
    source: value.source,
    committedSegments: value.committedSegments,
    committedText: value.committedText,
    confirmationDigest,
  };
}

function parseGovernedHandoff(
  body: Record<string, unknown>,
): WorkflowHandoffRequest | undefined | RunRequestError {
  const value = body.governedHandoff;
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return badRequest("governedHandoff must be an object when provided.");
  }
  return value as unknown as WorkflowHandoffRequest;
}

function parseVoiceOrigin(
  body: Record<string, unknown>,
  governedHandoff: WorkflowHandoffRequest | undefined,
): RunVoiceOrigin | undefined | RunRequestError {
  const value = body.voiceOrigin;
  if (value === undefined) {
    return undefined;
  }
  if (governedHandoff === undefined) {
    return badRequest("voiceOrigin requires governedHandoff.");
  }
  if (!isRecord(value)) {
    return badRequest("voiceOrigin must be an object when provided.");
  }
  return parseVoiceOriginFields(value);
}

function resolveKind(body: Record<string, unknown>): RunKind | RunRequestError {
  const workflowId = body.workflowId;
  const taskType = body.taskType;
  const hasWorkflow = workflowId !== undefined;
  const hasTask = taskType !== undefined;
  if (hasWorkflow === hasTask) {
    return { code: "BAD_REQUEST", message: "Provide exactly one of workflowId or taskType." };
  }
  if (hasWorkflow) {
    if (workflowId === "unit-test-generation") {
      return "unit-tests";
    }
    if (workflowId === "bug-investigation") {
      return "bug-investigation";
    }
    return { code: "BAD_REQUEST", message: "Unknown workflowId." };
  }
  if (taskType === "explain-plan") {
    return "explain-plan";
  }
  if (taskType === "verify") {
    return "verify";
  }
  return { code: "BAD_REQUEST", message: "Unsupported taskType." };
}

function validateWorkspaceRoot(input: Record<string, unknown>): RunRequestError | null {
  const workspaceRoot = input.workspaceRoot;
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    return { code: "BAD_REQUEST", message: "A non-empty workspaceRoot is required." };
  }
  return null;
}

function validateStringField(
  input: Record<string, unknown>,
  name: string,
  label: string,
): RunRequestError | null {
  const value = input[name];
  if (typeof value !== "string" || value.length === 0) {
    return { code: "BAD_REQUEST", message: `${label} must be a non-empty string.` };
  }
  return null;
}

function validateOptionalStringField(
  input: Record<string, unknown>,
  name: string,
  label: string,
): RunRequestError | null {
  const value = input[name];
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return { code: "BAD_REQUEST", message: `${label} must be a string.` };
  }
  return null;
}

function validateStringArray(
  value: unknown,
  label: string,
  options: { readonly required: boolean; readonly allowEmpty: boolean } = {
    required: false,
    allowEmpty: true,
  },
): RunRequestError | null {
  if (value === undefined) {
    return options.required
      ? { code: "BAD_REQUEST", message: `${label} must be a string array.` }
      : null;
  }
  if (!Array.isArray(value)) {
    return { code: "BAD_REQUEST", message: `${label} must be a string array.` };
  }
  if (!options.allowEmpty && value.length === 0) {
    return { code: "BAD_REQUEST", message: `${label} must contain at least one entry.` };
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      return { code: "BAD_REQUEST", message: `${label} must contain non-empty strings.` };
    }
  }
  return null;
}

// Verify shape: targetFiles (when present) must be a string[] of non-empty entries. The deeper
// guards (path containment, script detection) run inside the verification orchestrator; the BFF
// only validates shape here.
function validateVerifyInput(input: Record<string, unknown>): RunRequestError | null {
  return validateStringArray(input.targetFiles, "verify targetFiles");
}

function validateExplainPlanInput(input: Record<string, unknown>): RunRequestError | null {
  return (
    validateStringField(input, "filePath", "explain-plan filePath") ??
    validateOptionalStringField(input, "question", "explain-plan question")
  );
}

function validateUnitTestTarget(target: Record<string, unknown>): RunRequestError | null {
  const kind = target.kind;
  if (kind === "file") {
    return (
      validateStringField(target, "filePath", "unit-test target.filePath") ??
      validateOptionalStringField(target, "targetFunction", "unit-test target.targetFunction")
    );
  }
  if (kind === "module") {
    return validateStringField(target, "moduleDir", "unit-test target.moduleDir");
  }
  if (kind === "changedFiles") {
    return validateStringArray(target.filePaths, "unit-test target.filePaths", {
      required: true,
      allowEmpty: false,
    });
  }
  return {
    code: "BAD_REQUEST",
    message: "unit-test target.kind must be one of file, module, changedFiles.",
  };
}

function validateUnitTestsInput(input: Record<string, unknown>): RunRequestError | null {
  const target = input.target;
  if (!isRecord(target)) {
    return { code: "BAD_REQUEST", message: "unit-test target must be an object." };
  }
  return validateUnitTestTarget(target);
}

function validateBugReport(report: Record<string, unknown>): RunRequestError | null {
  const descriptionError = validateOptionalStringField(
    report,
    "description",
    "bug report.description",
  );
  if (descriptionError !== null) {
    return descriptionError;
  }
  const failingOutputError = validateOptionalStringField(
    report,
    "failingOutput",
    "bug report.failingOutput",
  );
  if (failingOutputError !== null) {
    return failingOutputError;
  }
  const stackTraceError = validateOptionalStringField(
    report,
    "stackTrace",
    "bug report.stackTrace",
  );
  if (stackTraceError !== null) {
    return stackTraceError;
  }
  const targetFilesError = validateStringArray(report.targetFiles, "bug report.targetFiles");
  if (targetFilesError !== null) {
    return targetFilesError;
  }
  return hasBugEvidence(report)
    ? null
    : {
        code: "BAD_REQUEST",
        message:
          "bug report requires at least one of description, failingOutput, stackTrace, or targetFiles.",
      };
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNonEmptyStringEntry(value: unknown): boolean {
  return Array.isArray(value) && value.some(hasNonEmptyString);
}

function hasBugEvidence(report: Record<string, unknown>): boolean {
  return (
    hasNonEmptyString(report.description) ||
    hasNonEmptyString(report.failingOutput) ||
    hasNonEmptyString(report.stackTrace) ||
    hasNonEmptyStringEntry(report.targetFiles)
  );
}

function validateBugInvestigationInput(input: Record<string, unknown>): RunRequestError | null {
  const report = input.report;
  if (!isRecord(report)) {
    return { code: "BAD_REQUEST", message: "bug report must be an object." };
  }
  return validateBugReport(report);
}

function validateRunInput(kind: RunKind, input: Record<string, unknown>): RunRequestError | null {
  const workspaceRootError = validateWorkspaceRoot(input);
  if (workspaceRootError !== null) {
    return workspaceRootError;
  }
  if (kind === "verify") {
    return validateVerifyInput(input);
  }
  if (kind === "explain-plan") {
    return validateExplainPlanInput(input);
  }
  if (kind === "unit-tests") {
    return validateUnitTestsInput(input);
  }
  return validateBugInvestigationInput(input);
}

function parseJsonObject(raw: string): Record<string, unknown> | RunRequestError {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : badRequest("Request body must be a JSON object.");
  } catch {
    return badRequest("Request body is not valid JSON.");
  }
}

function parseRunRequestCore(parsed: Record<string, unknown>): RunRequestCore | RunRequestError {
  const kind = resolveKind(parsed);
  if (typeof kind !== "string") {
    return kind;
  }
  const modelId = parsed.modelId;
  if (typeof modelId !== "string" || modelId.length === 0) {
    return { code: "BAD_REQUEST", message: "A non-empty modelId is required." };
  }
  const input = parsed.input;
  if (!isRecord(input)) {
    return { code: "BAD_REQUEST", message: "An input object is required." };
  }
  const inputError = validateRunInput(kind, input);
  if (inputError !== null) {
    return inputError;
  }
  const limits = parsed.limits;
  return {
    kind,
    modelId,
    input,
    limits: isRecord(limits) ? limits : undefined,
  };
}

function parseGovernedHandoffMetadata(
  parsed: Record<string, unknown>,
): GovernedHandoffMetadata | RunRequestError {
  if (parsed.governedHandoffVoiceAction !== undefined) {
    return badRequest("governedHandoffVoiceAction is server-generated and must not be provided.");
  }
  const governedHandoff = parseGovernedHandoff(parsed);
  if (isRunRequestError(governedHandoff)) {
    return governedHandoff;
  }
  const governedHandoffSourceGroundedRunId = parseOptionalString(
    parsed,
    "governedHandoffSourceGroundedRunId",
  );
  if (isRunRequestError(governedHandoffSourceGroundedRunId)) {
    return governedHandoffSourceGroundedRunId;
  }
  if (governedHandoffSourceGroundedRunId !== undefined && governedHandoff === undefined) {
    return badRequest("governedHandoffSourceGroundedRunId requires governedHandoff.");
  }
  const governedHandoffVoiceOrigin = parseVoiceOrigin(parsed, governedHandoff);
  if (isRunRequestError(governedHandoffVoiceOrigin)) {
    return governedHandoffVoiceOrigin;
  }
  return { governedHandoff, governedHandoffSourceGroundedRunId, governedHandoffVoiceOrigin };
}

function buildRunRequest(core: RunRequestCore, metadata: GovernedHandoffMetadata): RunRequest {
  return {
    kind: core.kind,
    modelId: core.modelId,
    // Dry-run-first (ADR-0011 D8 / security M1): the create route NEVER applies, even if the client
    // body carries `apply:true`. Applying is the sole responsibility of POST /api/runs/:runId/apply
    // (route 9), which re-invokes the workflow through the gated path. A one-shot create-with-apply
    // would bypass the explicit review→apply step, so the body flag is deliberately ignored here.
    apply: false,
    input: core.input,
    limits: core.limits,
    ...(metadata.governedHandoff === undefined
      ? {}
      : { governedHandoff: metadata.governedHandoff }),
    ...(metadata.governedHandoffSourceGroundedRunId === undefined
      ? {}
      : { governedHandoffSourceGroundedRunId: metadata.governedHandoffSourceGroundedRunId }),
    ...(metadata.governedHandoffVoiceOrigin === undefined
      ? {}
      : { governedHandoffVoiceOrigin: metadata.governedHandoffVoiceOrigin }),
  };
}

// Parses the raw JSON text into a validated RunRequest, or a typed BAD_REQUEST error.
export function parseRunRequest(raw: string): RunRequest | RunRequestError {
  const parsed = parseJsonObject(raw);
  if (isRunRequestError(parsed)) {
    return parsed;
  }
  const core = parseRunRequestCore(parsed);
  if (isRunRequestError(core)) {
    return core;
  }
  const metadata = parseGovernedHandoffMetadata(parsed);
  if (isRunRequestError(metadata)) {
    return metadata;
  }
  return buildRunRequest(core, metadata);
}
