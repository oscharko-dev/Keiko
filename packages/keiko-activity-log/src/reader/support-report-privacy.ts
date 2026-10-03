import { constants } from "node:os";
import {
  ACTIVITY_LOG_ERROR_KINDS,
  ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
  isActivityLogInstanceId,
  normalizeKeikoFrame,
  type ActivityLogFieldContract,
  type DiagnosticSufficiencyReason,
  type SupportIncidentPrivateProjection,
  type SupportReportEvent,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  CLIENT_ERROR_CLASSES,
  isPersistedClientDiagnosticFrame,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import {
  REDACTED_SHAPE,
  REDACTED_KEY,
  REDACTED_LENGTH,
  REDACTED_SECRET,
  REDACTED_PATH,
  REDACTED_PERSONAL,
} from "../log-redaction.js";
import {
  SUPPORT_CODE_MODULES,
  SUPPORT_CODE_ERROR_CLASSES,
  SUPPORT_CODE_TOKENS,
} from "./support-code-inventory.generated.js";
import type { SupportReaderRegistry } from "./support-registry.js";

const MODULES = new Set(SUPPORT_CODE_MODULES);
const REDACTION_MARKERS = new Set([
  REDACTED_SHAPE,
  REDACTED_KEY,
  REDACTED_LENGTH,
  REDACTED_SECRET,
  REDACTED_PATH,
  REDACTED_PERSONAL,
]);
const ERROR_CLASSES = new Set([...SUPPORT_CODE_ERROR_CLASSES, ...CLIENT_ERROR_CLASSES]);
const TECHNICAL_TOKENS = new Set([
  ...SUPPORT_CODE_TOKENS,
  ...ACTIVITY_LOG_ERROR_KINDS,
  ...Object.keys(constants.errno),
  ...Object.keys(constants.signals),
]);
const HTTP_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "CONNECT",
  "TRACE",
]);
const SYMBOL_FIELDS = new Set([
  "toolCanonicalId",
  "profileId",
  "failedOp",
  "droppedOp",
  "diagnosticOperation",
  "source",
  "code",
  "signal",
]);
const PROJECTED_MARKERS = new Set(["path", "routeTemplate", "clientNote", "diagnosticSummary"]);
const NUMERIC_VERSION =
  /^v?\d{1,8}(?:\.\d{1,8}){0,3}(?:-(?:alpha|beta|rc|dev|canary|preview)(?:[.-]\d{1,8})?)?$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** The local mapping never enters the artifact; equality survives without exporting labels. */
export interface SupportReportPrivacyProjection {
  readonly incident: SupportIncidentPrivateProjection;
  readonly event: (event: SupportReportEvent) => SupportReportEvent | undefined;
  readonly reasons: () => readonly DiagnosticSufficiencyReason[];
}
interface PrivacyContext {
  readonly incident: SupportIncidentPrivateProjection;
  readonly registry: SupportReaderRegistry;
  readonly reference: (value: string) => string;
  readonly loseDetail: () => void;
}

function referenceAllocator(): (value: string) => string {
  const labels = new Map<string, string>();
  return (value): string => {
    if (value === ACTIVITY_LOG_UNKNOWN_CORRELATION_ID || REDACTION_MARKERS.has(value)) return value;
    const existing = labels.get(value);
    if (existing !== undefined) return existing;
    const opaque = `id${String(labels.size + 1).padStart(6, "0")}`;
    labels.set(value, opaque);
    return opaque;
  };
}

function isCodeFrame(value: unknown): value is string {
  if (isPersistedClientDiagnosticFrame(value)) return true;
  if (typeof value !== "string") return false;
  const module = normalizeKeikoFrame(value);
  return module !== undefined && MODULES.has(module);
}

function technicalOpaque(name: string, value: string, context: PrivacyContext): boolean {
  if (name === "method") return HTTP_METHODS.has(value);
  if (name === "recoveredInstanceId") return isActivityLogInstanceId(value);
  if (name === "incidentId") return value === context.incident.incidentId;
  if (name === "pinId") return value === context.incident.pin.pinId;
  return (
    SYMBOL_FIELDS.has(name) &&
    (TECHNICAL_TOKENS.has(value) || context.registry.operations.has(value))
  );
}

function projectErrorKind(name: string, value: string, context: PrivacyContext): string {
  if (ERROR_CLASSES.has(value) || TECHNICAL_TOKENS.has(value)) return value;
  context.loseDetail();
  return name === "causeChain" ? "Error" : "unknown";
}

function projectVersion(name: string, value: string, context: PrivacyContext): string {
  if (NUMERIC_VERSION.test(value) || (name === "expiresAt" && ISO_TIMESTAMP.test(value)))
    return value;
  context.loseDetail();
  return REDACTED_SHAPE;
}

function projectPlatform(value: string, context: PrivacyContext): string {
  if (TECHNICAL_TOKENS.has(value)) return value;
  context.loseDetail();
  return REDACTED_SHAPE;
}

function projectOpaqueReference(name: string, value: string, context: PrivacyContext): string {
  if (technicalOpaque(name, value, context)) return value;
  const reference = context.reference(value);
  // Report-private tool identity retains the existing qualified grammar for lifecycle analysis.
  // This is an equality reference only: it never resolves a runtime handler or grants authority.
  return name === "toolCanonicalId" && /^id\d{6}$/u.test(reference)
    ? `keiko.private.${reference}`
    : reference;
}

function projectString(
  name: string,
  value: string,
  contract: ActivityLogFieldContract,
  context: PrivacyContext,
): string {
  if (contract.values !== undefined) return value;
  switch (contract.dataClass) {
    case "opaque-id":
      return projectOpaqueReference(name, value, context);
    case "error-kind":
      return projectErrorKind(name, value, context);
    case "safe-version":
      return projectVersion(name, value, context);
    case "safe-platform-class":
      return projectPlatform(value, context);
    default:
      return value;
  }
}

function isOwnRegisteredFailure(
  record: Readonly<Record<string, unknown>>,
  context: PrivacyContext,
): boolean {
  const incident = context.incident;
  const own = incident.correlation.childCorrelationIds[0] ?? incident.correlation.rootCorrelationId;
  return (
    incident.trigger === "registered-failure" &&
    record.op === incident.op &&
    (own === undefined || record.correlationId === own)
  );
}

function projectField(
  name: string,
  value: unknown,
  contract: ActivityLogFieldContract | undefined,
  context: PrivacyContext,
): unknown {
  if (PROJECTED_MARKERS.has(name)) return value;
  if (name === "correlationId" || name === "parentCorrelationId")
    return typeof value === "string" ? context.reference(value) : value;
  if (contract === undefined) return value;
  if (typeof value === "string") return projectString(name, value, contract, context);
  if (Array.isArray(value))
    return value.map((entry: unknown) =>
      typeof entry === "string" ? projectString(name, entry, contract, context) : entry,
    );
  return value;
}

function projectEvent(
  event: SupportReportEvent,
  context: PrivacyContext,
): SupportReportEvent | undefined {
  const fields = context.registry.operations.get(String(event.record.op))?.fields;
  const frames = event.record.frames;
  const safeFrames = Array.isArray(frames) ? frames.filter(isCodeFrame) : undefined;
  if (Array.isArray(frames) && safeFrames !== undefined && safeFrames.length < frames.length) {
    context.loseDetail();
    // The immutable fingerprint must not be rewritten to make a reduced failure look original.
    if (isOwnRegisteredFailure(event.record, context)) return undefined;
  }
  const record = Object.fromEntries(
    Object.entries(event.record).flatMap(([name, value]) => {
      if (name === "frames")
        return safeFrames === undefined || safeFrames.length === 0 ? [] : [[name, safeFrames]];
      return [[name, projectField(name, value, fields?.[name], context)]];
    }),
  );
  return { ...event, record };
}

export function supportReportPrivacyProjection(
  incident: SupportIncidentPrivateProjection,
  registry: SupportReaderRegistry,
): SupportReportPrivacyProjection {
  const reference = referenceAllocator();
  let detailLost = false;
  const context = {
    incident,
    registry,
    reference,
    loseDetail: (): void => {
      detailLost = true;
    },
  };
  const { rootCorrelationId, childCorrelationIds } = incident.correlation;
  return {
    incident: {
      ...incident,
      correlation: {
        ...(rootCorrelationId === undefined
          ? {}
          : { rootCorrelationId: reference(rootCorrelationId) }),
        childCorrelationIds: childCorrelationIds.map(reference),
      },
    },
    event: (event): SupportReportEvent | undefined => projectEvent(event, context),
    reasons: (): readonly DiagnosticSufficiencyReason[] => (detailLost ? ["evidence-partial"] : []),
  };
}
