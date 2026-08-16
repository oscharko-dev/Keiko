// KEIKO-0497 (#2901). The record's whole value is that it is provably content-free, so the
// validator is the guard: it must reject anything that could carry an endpoint or credential into
// the evidence store, not merely check the fields it expects.

import { describe, expect, it } from "vitest";
import {
  GATEWAY_SETUP_AUDIT_SCHEMA_VERSION,
  GATEWAY_SETUP_OUTCOME_KINDS,
  GATEWAY_SETUP_TARGET_CLASSES,
  isGatewaySetupOutcomeKind,
  isGatewaySetupTargetClass,
  validateGatewaySetupAuditRecord,
  type GatewaySetupAuditRecord,
} from "./gateway-setup-audit.js";

function record(overrides: Record<string, unknown> = {}): unknown {
  const base: GatewaySetupAuditRecord = {
    schemaVersion: GATEWAY_SETUP_AUDIT_SCHEMA_VERSION,
    outcome: "candidate-accepted",
    timestamp: "2026-08-16T12:00:00.000Z",
    correlationId: "corr-1",
    targetClass: "public",
    privateNetworkOverrideActive: false,
    providerCount: 2,
  };
  return { ...base, ...overrides };
}

describe("validateGatewaySetupAuditRecord", () => {
  it("accepts a well-formed record", () => {
    expect(validateGatewaySetupAuditRecord(record())).toEqual({ ok: true });
  });

  it("rejects an unexpected field that could smuggle content into the evidence store", () => {
    // The failure this exists to prevent: someone adds `baseUrl` to the record and the audit trail
    // silently becomes a store of endpoints.
    const result = validateGatewaySetupAuditRecord(
      record({ baseUrl: "https://llm-gateway.example.com" }),
    );
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("baseUrl") });
  });

  it.each([
    ["a non-object", 42, "audit"],
    ["an unsupported schema version", record({ schemaVersion: "2" }), "schemaVersion"],
    ["an unknown outcome", record({ outcome: "probed" }), "outcome"],
    ["an empty correlation id", record({ correlationId: "" }), "correlationId"],
    ["an unknown target class", record({ targetClass: "internal" }), "targetClass"],
    ["a non-boolean override flag", record({ privateNetworkOverrideActive: "yes" }), "private"],
    ["a negative provider count", record({ providerCount: -1 }), "providerCount"],
    ["a fractional provider count", record({ providerCount: 1.5 }), "providerCount"],
  ])("rejects %s", (_label, value, field) => {
    const result = validateGatewaySetupAuditRecord(value);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain(field);
  });

  it.each([
    ["a loose date string", "2026-08-16"],
    ["a non-canonical instant", "2026-08-16T12:00:00Z"],
    ["an unparseable value", "not-a-date"],
    ["an empty string", ""],
    ["a number", 1_755_000_000_000],
  ])("rejects %s as a timestamp", (_label, timestamp) => {
    // `Date.parse` accepts far more than ISO-8601; requiring the canonical round-trip keeps every
    // record directly comparable without a parsing convention on the reading side.
    const result = validateGatewaySetupAuditRecord(record({ timestamp }));
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("timestamp") });
  });

  it("keeps its guards aligned with the exported enums", () => {
    for (const value of GATEWAY_SETUP_TARGET_CLASSES) {
      expect(isGatewaySetupTargetClass(value)).toBe(true);
      expect(validateGatewaySetupAuditRecord(record({ targetClass: value }))).toEqual({ ok: true });
    }
    for (const value of GATEWAY_SETUP_OUTCOME_KINDS) {
      expect(isGatewaySetupOutcomeKind(value)).toBe(true);
      expect(validateGatewaySetupAuditRecord(record({ outcome: value }))).toEqual({ ok: true });
    }
    expect(isGatewaySetupTargetClass("public ")).toBe(false);
    expect(isGatewaySetupOutcomeKind(undefined)).toBe(false);
  });
});
