import { captureCatalogJson, createToolRef } from "@oscharko-dev/keiko-tool-catalog";
import {
  TOOL_CATALOG_LIMITS,
  TOOL_RESULT_REASONS,
  type CatalogJsonObject,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  TOOL_HANDLER_READINESS,
  captureToolInvocationReceipt,
  toolLifecyclePhaseFor,
  type ToolLifecycleEvent,
  type ToolLifecyclePhase,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import { isErrorKind } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { isValidCorrelationId } from "../correlation.js";
import { redactLogFields } from "../observability/log-redaction.js";
import type { ServerLogEvent, ServerLogSink } from "../observability/server-log.js";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";

const BASE_FIELDS = ["op", "correlationId", "catalogRevision", "profile", "projectionDigest"];
const PHASE_FIELDS = {
  projection: ["readiness"],
  "bind-ready": ["readiness", "handlerSetDigest"],
  "bind-unavailable": ["readiness", "reason"],
  "invocation-started": ["invocationId", "toolRef", "state", "reservationId", "reason"],
  terminal: [
    "invocationId",
    "toolRef",
    "status",
    "reason",
    "durationMs",
    "settlementId",
    "effectStarted",
    "budgetDisposition",
    "reservationId",
  ],
  discarded: ["invocationId", "toolRef", "settlementId", "reason"],
} as const;
const TERMINAL_OPTIONAL = [
  "inputBytes",
  "outputBytes",
  "resultCount",
  "truncated",
  "errorKind",
  "frames",
  "causeChain",
];
const DIGEST_FIELDS = new Set(["catalogRevision", "projectionDigest", "handlerSetDigest"]);
const ID_FIELDS = new Set(["invocationId", "reservationId", "settlementId"]);
const METRIC_FIELDS = new Set(["durationMs", "inputBytes", "outputBytes", "resultCount"]);
const TOKEN = /^[A-Za-z0-9_.-]{1,128}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const READINESS: ReadonlySet<string> = new Set(TOOL_HANDLER_READINESS);
const BIND_REASONS: ReadonlySet<string> = new Set([
  ...TOOL_RESULT_REASONS.failed,
  ...TOOL_RESULT_REASONS.invalid,
  ...TOOL_RESULT_REASONS.denied,
]);

function requireLifecycle(condition: boolean): asserts condition {
  if (!condition) throw new TypeError("Invalid tool lifecycle evidence");
}
function object(value: CatalogJsonValue | undefined): CatalogJsonObject {
  requireLifecycle(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as CatalogJsonObject;
}
function exactKeys(
  value: CatalogJsonObject,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  requireLifecycle(
    required.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every((key) => allowed.has(key)),
  );
}
function validProfile(value: CatalogJsonValue | undefined): boolean {
  const profile = object(value);
  exactKeys(profile, ["id", "version"]);
  return (
    typeof profile.id === "string" &&
    TOKEN.test(profile.id) &&
    typeof profile.version === "number" &&
    Number.isSafeInteger(profile.version) &&
    profile.version > 0
  );
}
function validTool(value: CatalogJsonValue | undefined): boolean {
  if (value === null) return true;
  const ref = object(value);
  exactKeys(ref, ["canonicalId", "contractVersion"]);
  requireLifecycle(typeof ref.canonicalId === "string" && typeof ref.contractVersion === "number");
  createToolRef(ref.canonicalId, ref.contractVersion);
  return true;
}
function validDiagnostics(key: string, value: CatalogJsonValue | undefined): boolean {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return false;
  if (value.length === 0) return true;
  const redacted = redactLogFields({ [key]: value })?.[key];
  return (
    Array.isArray(redacted) &&
    value.length === redacted.length &&
    value.every((item, index) => item === redacted[index])
  );
}
function validMetric(key: string, value: CatalogJsonValue): boolean {
  const maximum =
    key === "resultCount"
      ? TOOL_CATALOG_LIMITS.maxArrayItems
      : key === "durationMs"
        ? Number.MAX_SAFE_INTEGER
        : TOOL_CATALOG_LIMITS.maxResultBytes;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
function validField(key: string, value: CatalogJsonValue): boolean {
  if (DIGEST_FIELDS.has(key)) return typeof value === "string" && DIGEST.test(value);
  if (ID_FIELDS.has(key)) return validIdentifier(key, value);
  if (METRIC_FIELDS.has(key)) return validMetric(key, value);
  if (key === "correlationId" || key === "parentCorrelationId")
    return typeof value === "string" && isValidCorrelationId(value);
  if (key === "profile") return validProfile(value);
  if (key === "toolRef") return validTool(value);
  return validStateField(key, value);
}
function validIdentifier(key: string, value: CatalogJsonValue): boolean {
  return value === null ? key === "reservationId" : typeof value === "string" && TOKEN.test(value);
}
function validStateField(key: string, value: CatalogJsonValue): boolean {
  if (key === "frames" || key === "causeChain") return validDiagnostics(key, value);
  if (key === "errorKind") return isErrorKind(value);
  if (key === "effectStarted" || key === "truncated") return typeof value === "boolean";
  if (key === "readiness") return typeof value === "string" && READINESS.has(value);
  return typeof value === "string";
}
function optionalFields(phase: ToolLifecyclePhase): readonly string[] {
  const own =
    phase === "terminal" ? TERMINAL_OPTIONAL : phase === "projection" ? ["resultCount"] : [];
  return ["parentCorrelationId", ...own];
}
function terminalStatus(value: CatalogJsonObject): void {
  requireLifecycle(
    typeof value.status === "string" && Object.hasOwn(TOOL_RESULT_REASONS, value.status),
  );
  const reasons: readonly string[] =
    TOOL_RESULT_REASONS[value.status as keyof typeof TOOL_RESULT_REASONS];
  requireLifecycle(typeof value.reason === "string" && reasons.includes(value.reason));
  if (value.status === "failed") {
    requireLifecycle(
      isErrorKind(value.errorKind) &&
        validDiagnostics("frames", value.frames) &&
        validDiagnostics("causeChain", value.causeChain),
    );
  } else
    requireLifecycle(
      !["errorKind", "frames", "causeChain"].some((key) => Object.hasOwn(value, key)),
    );
}
function terminalReservation(value: CatalogJsonObject): void {
  captureToolInvocationReceipt({
    invocationId: value.invocationId,
    settlementId: value.settlementId,
    reservationId: value.reservationId,
    status: value.status,
    effectStarted: value.effectStarted,
    budgetDisposition: value.budgetDisposition,
  });
  if (value.toolRef === null)
    requireLifecycle(
      value.status !== "completed" &&
        !value.effectStarted &&
        value.budgetDisposition === "not-reserved",
    );
}
function phaseShape(phase: ToolLifecyclePhase, value: CatalogJsonObject): void {
  if (phase === "terminal") {
    terminalStatus(value);
    terminalReservation(value);
    return;
  }
  bindingShape(phase, value);
  invocationShape(phase, value);
}
function bindingShape(phase: ToolLifecyclePhase, value: CatalogJsonObject): void {
  if (phase === "bind-ready") requireLifecycle(value.readiness === "ready");
  if (phase === "bind-unavailable")
    requireLifecycle(
      value.readiness !== "ready" &&
        typeof value.reason === "string" &&
        BIND_REASONS.has(value.reason),
    );
}
function invocationShape(phase: ToolLifecyclePhase, value: CatalogJsonObject): void {
  if (phase === "invocation-started")
    requireLifecycle(
      value.state === "started" &&
        value.reason === "none" &&
        value.reservationId !== null &&
        value.toolRef !== null,
    );
  if (phase === "discarded")
    requireLifecycle(value.reason === "late-completion" && value.toolRef !== null);
}

/** Closed, detached runtime evidence validation before the generic redactor and every sink. */
export function validateToolLifecycleEvent(source: unknown): ToolLifecycleEvent {
  try {
    const value = object(captureCatalogJson(source, 8192));
    const phase = typeof value.op === "string" ? toolLifecyclePhaseFor(value.op) : undefined;
    requireLifecycle(phase !== undefined);
    exactKeys(value, [...BASE_FIELDS, ...PHASE_FIELDS[phase]], optionalFields(phase));
    requireLifecycle(Object.entries(value).every(([key, field]) => validField(key, field)));
    phaseShape(phase, value);
    return deepFreeze(value) as unknown as ToolLifecycleEvent;
  } catch {
    throw new TypeError("Invalid tool lifecycle evidence");
  }
}

function writeLifecycle(sink: ServerLogSink, event: ToolLifecycleEvent): void {
  const fields: Omit<ServerLogEvent, "op"> = {
    level:
      event.op === "tool-catalog.invocation-settled" && event.status === "failed"
        ? "error"
        : "info",
    category: "security",
    correlationId: event.correlationId,
    extra: { ...event },
    ...(event.parentCorrelationId === undefined
      ? {}
      : { parentCorrelationId: event.parentCorrelationId }),
  };
  // These are actual writes: source extraction records exactly the six generated lifecycle IDs.
  switch (event.op) {
    case "tool-catalog.projection":
      sink.write({ ...fields, op: "tool-catalog.projection" });
      break;
    case "tool-catalog.bind-ready":
      sink.write({ ...fields, op: "tool-catalog.bind-ready" });
      break;
    case "tool-catalog.bind-unavailable":
      sink.write({ ...fields, op: "tool-catalog.bind-unavailable" });
      break;
    case "tool-catalog.invocation-started":
      sink.write({ ...fields, op: "tool-catalog.invocation-started" });
      break;
    case "tool-catalog.invocation-settled":
      sink.write({ ...fields, op: "tool-catalog.invocation-settled" });
      break;
    case "tool-catalog.completion-discarded":
      sink.write({ ...fields, op: "tool-catalog.completion-discarded" });
      break;
  }
}

export interface CatalogLifecycleLogPort {
  readonly primary: ServerLogSink;
  readonly diagnostics: ServerDiagnosticSink;
  readonly auxiliary?: ServerLogSink;
}
function writeToSink(
  sink: ServerLogSink,
  event: ToolLifecycleEvent,
  diagnostics: ServerDiagnosticSink,
  source: "tool-catalog-lifecycle-primary" | "tool-catalog-lifecycle-auxiliary",
): void {
  try {
    writeLifecycle(sink, event);
  } catch (error) {
    emitServerDiagnostic(
      diagnostics,
      serverDiagnosticFromError({
        correlationId: event.correlationId,
        operation: "tool-catalog.lifecycle-sink-failed",
        source,
        error,
        redact: () => "server-operation-failed",
      }),
    );
  }
}
export function emitToolLifecycleEvent(port: CatalogLifecycleLogPort, source: unknown): void {
  const event = validateToolLifecycleEvent(source);
  // An auxiliary callback never runs before the primary durable-write attempt.
  writeToSink(port.primary, event, port.diagnostics, "tool-catalog-lifecycle-primary");
  if (port.auxiliary !== undefined)
    writeToSink(port.auxiliary, event, port.diagnostics, "tool-catalog-lifecycle-auxiliary");
}

export { redactLogFields } from "../observability/log-redaction.js";
