import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  updateLegacySnapshotImportedEvent,
  updateRuntimeActivityEvent,
  type UpdateRuntimeActivityFields,
} from "./update-runtime-activity.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

describe("update runtime activity event", () => {
  it("resolves the update.runtime.event Activity Log proof for a non-failed state", () => {
    const fields: UpdateRuntimeActivityFields = {
      eventId: "runtime-evt-preflight-0001",
      type: "preflight-result",
      occurredAt: "2026-09-18T10:00:00.000Z",
      status: "completed",
    };
    const event = updateRuntimeActivityEvent("runtime-preflight-0001", fields);
    expect(event).toMatchObject({
      op: "update.runtime.event",
      category: "diagnostic",
      level: "info",
      correlationId: "runtime-preflight-0001",
      extra: {
        eventId: fields.eventId,
        type: "preflight-result",
        status: "completed",
        completeness: "complete",
        loss: "none",
      },
    });
    expect(event).not.toHaveProperty("errorKind");
    const persisted = expectActivityLogProof(
      "update.runtime.event.body-free",
      formatActivityLogProofLine(event),
    );
    expect(persisted).toMatchObject({
      eventId: fields.eventId,
      type: "preflight-result",
      status: "completed",
    });
    expect(persisted).not.toHaveProperty("failureKind");
  });

  it("resolves the update.runtime.event Activity Log proof for a failed transition with stack evidence", () => {
    const fields: UpdateRuntimeActivityFields = {
      eventId: "runtime-evt-download-0002",
      type: "portable-download-result",
      occurredAt: "2026-09-18T10:05:00.000Z",
      status: "failed",
    };
    const failure = new Error("simulated portable download failure", {
      cause: new Error("network reset"),
    });
    const event = updateRuntimeActivityEvent("runtime-download-0002", fields, failure);
    expect(event).toMatchObject({
      op: "update.runtime.event",
      level: "warn",
      correlationId: "runtime-download-0002",
      errorKind: "unavailable",
      extra: {
        eventId: fields.eventId,
        status: "failed",
        failureKind: "portable-download-result-failed",
      },
    });
    const persisted = expectActivityLogProof(
      "update.runtime.event.body-free",
      formatActivityLogProofLine(event),
    );
    expect(persisted).toMatchObject({
      failureKind: "portable-download-result-failed",
      status: "failed",
    });
    expect(Array.isArray(persisted.causeChain)).toBe(true);
    expect(Array.isArray(persisted.frames)).toBe(true);
  });

  it("prioritizes the sidecar failure code over the event type when both signal failure", () => {
    const fields: UpdateRuntimeActivityFields = {
      eventId: "runtime-evt-sidecar-0003",
      type: "portable-sidecar-verification-result",
      occurredAt: "2026-09-18T10:10:00.000Z",
      portableSidecarStatus: "failed",
      portableSidecarFailureCode: "sidecar-payload-outside-root",
    };
    const event = updateRuntimeActivityEvent("runtime-sidecar-0003", fields);
    expect(event).toMatchObject({
      level: "warn",
      errorKind: "unsafe-target",
      extra: { failureKind: "sidecar-payload-outside-root" },
    });
  });

  it("classifies a warning-driven failure by its registered warning code", () => {
    const fields: UpdateRuntimeActivityFields = {
      eventId: "runtime-evt-remediation-0004",
      type: "remediation-failed",
      occurredAt: "2026-09-18T10:15:00.000Z",
      status: "failed",
      warningCode: "remediation-execution-failed",
    };
    const event = updateRuntimeActivityEvent("runtime-remediation-0004", fields);
    expect(event).toMatchObject({
      errorKind: "internal",
      extra: { failureKind: "remediation-execution-failed" },
    });
  });

  it("degrades to the unknown correlation marker when none is supplied", () => {
    const fields: UpdateRuntimeActivityFields = {
      eventId: "runtime-evt-offer-0005",
      type: "update-offered",
      occurredAt: "2026-09-18T10:20:00.000Z",
    };
    const event = updateRuntimeActivityEvent(undefined, fields);
    expect(event.correlationId).toBe("unknown-correlation-id");
  });
});

describe("update legacy snapshot imported activity", () => {
  it("resolves the update.runtime.legacy-snapshot-imported Activity Log proof", () => {
    const sourceDigest = createHash("sha256").update("legacy-audit-source").digest("hex");
    const importedIdSetDigest = createHash("sha256")
      .update("legacy-audit-imported-ids")
      .digest("hex");
    const event = updateLegacySnapshotImportedEvent({
      importId: "legacy-import-0001",
      sourceDigest,
      importedIdSetDigest,
      importedCount: 42,
    });
    expect(event).toMatchObject({
      op: "update.runtime.legacy-snapshot-imported",
      category: "diagnostic",
      level: "info",
      correlationId: "unknown-correlation-id",
      extra: {
        historical: true,
        sourceSchemaVersion: 1,
        importId: "legacy-import-0001",
        sourceDigest,
        importedIdSetDigest,
        importedCount: 42,
        completeness: "complete",
        loss: "none",
      },
    });
    const persisted = expectActivityLogProof(
      "update.runtime.legacy-snapshot-imported.count",
      formatActivityLogProofLine(event),
    );
    expect(persisted).toMatchObject({
      historical: true,
      sourceSchemaVersion: 1,
      importId: "legacy-import-0001",
      importedCount: 42,
    });
  });

  it("accepts a zero-count import at the boundary", () => {
    const sourceDigest = createHash("sha256").update("legacy-audit-empty").digest("hex");
    const importedIdSetDigest = createHash("sha256").update("legacy-audit-empty-ids").digest("hex");
    const event = updateLegacySnapshotImportedEvent({
      importId: "legacy-import-0002",
      sourceDigest,
      importedIdSetDigest,
      importedCount: 0,
    });
    expect(event.extra).toMatchObject({ importedCount: 0 });
  });
});
