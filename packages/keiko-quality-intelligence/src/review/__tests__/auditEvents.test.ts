// Audit-event builder tests (Issue #282).

import { describe, expect, it } from "vitest";

import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

import {
  buildReviewAuditEvent,
  QUALITY_INTELLIGENCE_REVIEW_AUDIT_EVENT_KINDS,
  QUALITY_INTELLIGENCE_REVIEW_AUDIT_EVENT_SCHEMA_VERSION,
  transitionedPayloadFromNext,
  type QualityIntelligenceReviewAuditEvent,
  type QualityIntelligenceReviewAuditEventPayload,
} from "../auditEvents.js";
import { applyReviewTransition } from "../stateMachine.js";

const RUN_ID = QualityIntelligence.asQualityIntelligenceRunId("qi-run-audit-0001");
const RECORD_ID = QualityIntelligence.asQualityIntelligenceReviewRecordId("qi-review-audit-0001");
const PAIRED_ID = QualityIntelligence.asQualityIntelligenceReviewRecordId("qi-review-audit-0002");

const buildOne = (
  sequence: number,
  payload: QualityIntelligenceReviewAuditEventPayload,
): QualityIntelligenceReviewAuditEvent =>
  buildReviewAuditEvent({
    runId: RUN_ID,
    recordId: RECORD_ID,
    sequence,
    timestamp: "2026-06-05T12:00:00.000Z",
    by: "actor:test",
    payload,
  });

describe("audit event kinds", () => {
  it("exports exactly four kinds in stable order", () => {
    expect(QUALITY_INTELLIGENCE_REVIEW_AUDIT_EVENT_KINDS).toEqual([
      "qi:review:opened",
      "qi:review:transitioned",
      "qi:review:four-eyes-paired",
      "qi:review:terminated",
    ]);
  });
});

describe("buildReviewAuditEvent", () => {
  it("produces a frozen envelope with schema version 1", () => {
    const event = buildOne(0, { kind: "qi:review:opened", reviewerKind: "human-author" });
    expect(event.eventSchemaVersion).toBe(QUALITY_INTELLIGENCE_REVIEW_AUDIT_EVENT_SCHEMA_VERSION);
    expect(event.eventSchemaVersion).toBe(1);
    expect(event.runId).toBe(RUN_ID);
    expect(event.recordId).toBe(RECORD_ID);
    expect(event.sequence).toBe(0);
    expect(event.timestamp).toBe("2026-06-05T12:00:00.000Z");
    expect(event.by).toBe("actor:test");
    expect(event.payload).toEqual({ kind: "qi:review:opened", reviewerKind: "human-author" });
    expect(Object.isFrozen(event)).toBe(true);
  });

  it("emits each of the four audit-event payload shapes", () => {
    const opened = buildOne(0, { kind: "qi:review:opened", reviewerKind: "human-reviewer" });
    expect(opened.payload.kind).toBe("qi:review:opened");

    const transitioned = buildOne(1, {
      kind: "qi:review:transitioned",
      from: "open",
      to: "approved",
      event: "approve",
    });
    expect(transitioned.payload.kind).toBe("qi:review:transitioned");

    const paired = buildOne(2, { kind: "qi:review:four-eyes-paired", pairedRecordId: PAIRED_ID });
    expect(paired.payload.kind).toBe("qi:review:four-eyes-paired");

    const terminated = buildOne(3, { kind: "qi:review:terminated", terminalState: "approved" });
    expect(terminated.payload.kind).toBe("qi:review:terminated");
  });

  it("preserves a monotonic sequence across builder calls", () => {
    const events: readonly QualityIntelligenceReviewAuditEvent[] = [
      buildOne(0, { kind: "qi:review:opened", reviewerKind: "human-author" }),
      buildOne(1, {
        kind: "qi:review:transitioned",
        from: "open",
        to: "changes-requested",
        event: "request-changes",
      }),
      buildOne(2, {
        kind: "qi:review:transitioned",
        from: "changes-requested",
        to: "open",
        event: "revise",
      }),
      buildOne(3, { kind: "qi:review:terminated", terminalState: "approved" }),
    ];
    for (let index = 1; index < events.length; index += 1) {
      const current = events[index];
      const previous = events[index - 1];
      expect(current).toBeDefined();
      expect(previous).toBeDefined();
      if (current === undefined || previous === undefined) {
        throw new Error("unreachable");
      }
      expect(current.sequence).toBeGreaterThan(previous.sequence);
    }
  });

  it("rejects a negative sequence", () => {
    expect(() => buildOne(-1, { kind: "qi:review:opened", reviewerKind: "judge" })).toThrow(
      RangeError,
    );
  });

  it("rejects a non-integer sequence", () => {
    expect(() => buildOne(1.5, { kind: "qi:review:opened", reviewerKind: "judge" })).toThrow(
      RangeError,
    );
  });
});

describe("transitionedPayloadFromNext", () => {
  it("derives a transitioned payload from a NextReviewState", () => {
    const next = applyReviewTransition("open", "approve", "actor:test", "2026-06-05T12:00:00.000Z");
    const payload = transitionedPayloadFromNext(next);
    expect(payload).toEqual({
      kind: "qi:review:transitioned",
      from: "open",
      to: "approved",
      event: "approve",
    });
    expect(Object.isFrozen(payload)).toBe(true);
  });
});
