import { describe, expect, it } from "vitest";
import {
  EDITOR_VERIFICATION_EVENT_KINDS,
  EDITOR_VERIFICATION_KINDS,
  EDITOR_VERIFICATION_MAX_KINDS,
  EDITOR_VERIFICATION_RUN_STATES,
  EDITOR_VERIFICATION_SCHEMA_VERSION,
  isEditorVerificationEvent,
  isEditorVerificationEventKind,
  isEditorVerificationRun,
  isEditorVerificationRunState,
  isVerificationKind,
  parseEditorVerificationRunRequest,
} from "./editor-verification.js";
import type { EditorVerificationEvent } from "./editor-verification.js";
import type { VerificationReport } from "./verification.js";

const V = EDITOR_VERIFICATION_SCHEMA_VERSION;

function report(): VerificationReport {
  return {
    workspaceRoot: "/ws",
    results: [],
    overallStatus: "passed",
    startedAtMs: 1,
    durationMs: 2,
    counts: {
      passed: 0,
      failed: 0,
      skipped: 0,
      denied: 0,
      "timed-out": 0,
      cancelled: 0,
      "resource-exceeded": 0,
    },
  };
}

describe("parseEditorVerificationRunRequest", () => {
  it("accepts a valid multi-kind request and canonicalizes it", () => {
    const parsed = parseEditorVerificationRunRequest({
      kinds: ["typecheck", "lint"],
      requestId: "req-1",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.kinds).toEqual(["typecheck", "lint"]);
      expect(parsed.value.requestId).toBe("req-1");
      expect(parsed.value.targetPath).toBeUndefined();
    }
  });

  it("accepts a targeted-test request with a contained targetPath", () => {
    const parsed = parseEditorVerificationRunRequest({
      kinds: ["targeted-test"],
      targetPath: "src/a.test.ts",
    });
    expect(parsed.ok).toBe(true);
  });

  it("rejects a non-object, empty kinds, or duplicate kinds", () => {
    expect(parseEditorVerificationRunRequest(null).ok).toBe(false);
    expect(parseEditorVerificationRunRequest({ kinds: [] }).ok).toBe(false);
    expect(parseEditorVerificationRunRequest({ kinds: ["lint", "lint"] }).ok).toBe(false);
    expect(parseEditorVerificationRunRequest({ kinds: ["not-a-kind"] }).ok).toBe(false);
  });

  it("rejects more kinds than the closed set allows", () => {
    const tooMany = Array.from({ length: EDITOR_VERIFICATION_MAX_KINDS + 1 }, () => "test");
    expect(parseEditorVerificationRunRequest({ kinds: tooMany }).ok).toBe(false);
  });

  it("rejects an escaping targetPath and an invalid requestId", () => {
    expect(
      parseEditorVerificationRunRequest({ kinds: ["targeted-test"], targetPath: "../escape.ts" })
        .ok,
    ).toBe(false);
    expect(
      parseEditorVerificationRunRequest({ kinds: ["test"], requestId: "bad id with spaces" }).ok,
    ).toBe(false);
  });
});

describe("editor-verification enum guards", () => {
  it("recognizes every kind, run state, and event kind", () => {
    for (const kind of EDITOR_VERIFICATION_KINDS) expect(isVerificationKind(kind)).toBe(true);
    for (const state of EDITOR_VERIFICATION_RUN_STATES) {
      expect(isEditorVerificationRunState(state)).toBe(true);
    }
    for (const eventKind of EDITOR_VERIFICATION_EVENT_KINDS) {
      expect(isEditorVerificationEventKind(eventKind)).toBe(true);
    }
    expect(isVerificationKind("nope")).toBe(false);
    expect(isEditorVerificationRunState("running-fast")).toBe(false);
    expect(isEditorVerificationEventKind("run-exploded")).toBe(false);
  });
});

describe("isEditorVerificationRun", () => {
  it("accepts a valid run and rejects a bad state or missing runId", () => {
    expect(
      isEditorVerificationRun({
        runId: "r1",
        kinds: ["test"],
        state: "running",
        startedAtMs: 10,
      }),
    ).toBe(true);
    expect(
      isEditorVerificationRun({ runId: "", kinds: ["test"], state: "running", startedAtMs: 10 }),
    ).toBe(false);
    expect(
      isEditorVerificationRun({ runId: "r", kinds: ["test"], state: "boom", startedAtMs: 10 }),
    ).toBe(false);
  });
});

describe("isEditorVerificationEvent", () => {
  it("accepts every lifecycle event variant", () => {
    const events: EditorVerificationEvent[] = [
      { schemaVersion: V, kind: "run-started", runId: "r", kinds: ["test"], startedAtMs: 1 },
      { schemaVersion: V, kind: "step-started", runId: "r", stepKind: "test" },
      {
        schemaVersion: V,
        kind: "step-completed",
        runId: "r",
        stepKind: "test",
        status: "failed",
        durationMs: 5,
      },
      { schemaVersion: V, kind: "run-completed", runId: "r", report: report() },
      { schemaVersion: V, kind: "run-cancelled", runId: "r" },
      { schemaVersion: V, kind: "run-failed", runId: "r", reason: "backend-unavailable" },
    ];
    for (const event of events) expect(isEditorVerificationEvent(event)).toBe(true);
  });

  it("rejects a wrong schema version, unknown kind, or malformed payload", () => {
    expect(
      isEditorVerificationEvent({ schemaVersion: "9", kind: "run-cancelled", runId: "r" }),
    ).toBe(false);
    expect(isEditorVerificationEvent({ schemaVersion: V, kind: "explode", runId: "r" })).toBe(
      false,
    );
    expect(
      isEditorVerificationEvent({
        schemaVersion: V,
        kind: "step-completed",
        runId: "r",
        stepKind: "test",
      }),
    ).toBe(false); // missing status/durationMs
    expect(isEditorVerificationEvent({ schemaVersion: V, kind: "run-completed", runId: "r" })).toBe(
      false,
    ); // missing report
  });

  it("keeps non-terminal step-completed events free of the full result payload (content-free)", () => {
    const stepCompleted = {
      schemaVersion: V,
      kind: "step-completed" as const,
      runId: "r",
      stepKind: "test" as const,
      status: "failed" as const,
      durationMs: 5,
    };
    expect(isEditorVerificationEvent(stepCompleted)).toBe(true);
    expect(Object.keys(stepCompleted).sort()).toEqual([
      "durationMs",
      "kind",
      "runId",
      "schemaVersion",
      "status",
      "stepKind",
    ]);
    expect("outputSummary" in stepCompleted).toBe(false);
    expect("report" in stepCompleted).toBe(false);
  });
});
