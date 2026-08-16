// Gateway Setup audit record (KEIKO-0497, issue #2901).
//
// Configuring the model gateway points the product at an outbound endpoint and may enable an
// SSRF/private-network override. That is a governance-relevant act, and it left no evidence: the
// setup route returned 200 and wrote nothing an operator could later audit. This is the record it
// now emits, on the same content-free footing as the other audit records in this package.
//
// Body-free by construction. The raw base URL is NEVER a field — only its host *classification*,
// so an audit trail can answer "did setup ever point at a metadata or private-network address, and
// was the override on when it happened?" without retaining an endpoint, credential, tenant name, or
// anything else that would make the evidence itself sensitive. The classification enum mirrors the
// gateway's own outbound target classes; contracts is the leaf (ADR-0019 direction 1) and cannot
// import from `keiko-model-gateway`, so the closed set is restated here and the server maps onto it.
//
// Pure data + pure functions: no IO, no clock read, no randomness.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export const GATEWAY_SETUP_AUDIT_SCHEMA_VERSION = "1" as const;

/**
 * Host classification of the configured base URL. `public` covers a resolvable name that is not a
 * literal IP — the gateway's classifier returns nothing for those, and an unclassified host is
 * recorded as public rather than dropped, so no successful setup is ever missing from the trail.
 */
export type GatewaySetupTargetClass =
  | "public"
  | "loopback"
  | "private"
  | "link-local"
  | "metadata"
  | "multicast";

export const GATEWAY_SETUP_TARGET_CLASSES: readonly GatewaySetupTargetClass[] = Object.freeze([
  "public",
  "loopback",
  "private",
  "link-local",
  "metadata",
  "multicast",
]);

export function isGatewaySetupTargetClass(value: unknown): value is GatewaySetupTargetClass {
  return (
    typeof value === "string" && (GATEWAY_SETUP_TARGET_CLASSES as readonly string[]).includes(value)
  );
}

/** Which setup path produced the record: a freshly probed candidate, or an update of a saved one. */
export type GatewaySetupOutcomeKind = "candidate-accepted" | "existing-config-updated";

export const GATEWAY_SETUP_OUTCOME_KINDS: readonly GatewaySetupOutcomeKind[] = Object.freeze([
  "candidate-accepted",
  "existing-config-updated",
]);

export function isGatewaySetupOutcomeKind(value: unknown): value is GatewaySetupOutcomeKind {
  return (
    typeof value === "string" && (GATEWAY_SETUP_OUTCOME_KINDS as readonly string[]).includes(value)
  );
}

export interface GatewaySetupAuditRecord {
  readonly schemaVersion: typeof GATEWAY_SETUP_AUDIT_SCHEMA_VERSION;
  readonly outcome: GatewaySetupOutcomeKind;
  /** ISO-8601 timestamp of the completed setup. */
  readonly timestamp: string;
  /** Ties the record to the request's redacted operator diagnostics. */
  readonly correlationId: string;
  /** Classification of the configured base URL's host. Never the base URL itself. */
  readonly targetClass: GatewaySetupTargetClass;
  /** Whether the private-network / SSRF override was active for this configuration. */
  readonly privateNetworkOverrideActive: boolean;
  readonly providerCount: number;
}

function isIsoTimestamp(value: unknown): boolean {
  // A parseable instant AND canonical ISO form: `new Date("x").toISOString()` round-trips only for
  // a well-formed timestamp, so this rejects the loose formats `Date.parse` otherwise accepts.
  if (typeof value !== "string" || value.length === 0) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export function validateGatewaySetupAuditRecord(
  value: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: "audit: must be an object" };
  if (value.schemaVersion !== GATEWAY_SETUP_AUDIT_SCHEMA_VERSION) {
    return { ok: false, reason: "schemaVersion: unsupported" };
  }
  if (!isGatewaySetupOutcomeKind(value.outcome)) {
    return { ok: false, reason: "outcome: unknown setup outcome" };
  }
  if (!isIsoTimestamp(value.timestamp)) {
    return { ok: false, reason: "timestamp: must be an ISO-8601 instant" };
  }
  if (typeof value.correlationId !== "string" || value.correlationId.length === 0) {
    return { ok: false, reason: "correlationId: must be a non-empty string" };
  }
  if (!isGatewaySetupTargetClass(value.targetClass)) {
    return { ok: false, reason: "targetClass: unknown target classification" };
  }
  if (typeof value.privateNetworkOverrideActive !== "boolean") {
    return { ok: false, reason: "privateNetworkOverrideActive: must be a boolean" };
  }
  if (!isNonNegativeInteger(value.providerCount)) {
    return { ok: false, reason: "providerCount: must be a non-negative integer" };
  }
  // Fail closed on anything that could carry an endpoint or credential into the evidence store: the
  // record's value is that it is provably content-free, so an unknown field is a rejection, not a
  // passthrough. Without this an added `baseUrl` would validate and persist.
  const allowed = new Set([
    "schemaVersion",
    "outcome",
    "timestamp",
    "correlationId",
    "targetClass",
    "privateNetworkOverrideActive",
    "providerCount",
  ]);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected !== undefined) {
    return { ok: false, reason: `${unexpected}: unexpected field in a content-free audit record` };
  }
  return { ok: true };
}
