import { describe, expect, it } from "vitest";
import type {
  AvailableCodingSafeActivityFeed,
  CodingSafeActivityTool,
  CodingWorkbenchRuntimePendingPermission,
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeSseEvent,
  CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";
import { translateCodingWorkbench, type CodingWorkbenchTranslate } from "./coding-workbench-i18n";
import { formatRunDuration, runPhase, runSettledAt, runStartedAt } from "./codingWorkbenchRunFacts";

const STARTED = "2026-10-06T10:00:00.000Z";
const t: CodingWorkbenchTranslate = (key, values) => translateCodingWorkbench("en", key, values);

function snapshot(
  overrides: Partial<CodingWorkbenchRuntimeSnapshot> = {},
): CodingWorkbenchRuntimeSnapshot {
  return {
    schemaVersion: "1",
    state: "running",
    revision: 4,
    updatedAt: STARTED,
    runId: "run-1",
    ...overrides,
  } as CodingWorkbenchRuntimeSnapshot;
}

function tool(name: string, state: CodingSafeActivityTool["state"]): CodingSafeActivityTool {
  return { callId: `${name}-${state}`, tool: name, state, occurredAt: STARTED };
}

function feed(
  turns: readonly (readonly CodingSafeActivityTool[])[],
  runId = "run-1",
): AvailableCodingSafeActivityFeed {
  return {
    schemaVersion: "1",
    availability: "available",
    runId,
    updatedAt: STARTED,
    turns: turns.map((tools, index) => ({
      turnId: `turn-${String(index)}`,
      messages: [],
      tools,
      truncated: false,
    })),
    truncated: false,
    droppedEventCount: 0,
  } as AvailableCodingSafeActivityFeed;
}

function status(
  sequence: number,
  state: CodingWorkbenchRuntimeStateName,
  occurredAt: string,
  runId = "run-1",
): CodingWorkbenchRuntimeSseEvent {
  return {
    schemaVersion: "1",
    cursor: `${runId}:${String(sequence)}`,
    sequence,
    occurredAt,
    kind: "status",
    runId,
    state,
    revision: sequence + 1,
  };
}

describe("runPhase", () => {
  it("waits for the model while a running run has no unsettled tool", () => {
    const input = { snapshot: snapshot(), pendingDecision: false };
    expect(runPhase({ ...input, feed: null })).toBe("model");
    expect(runPhase({ ...input, feed: feed([[tool("keiko_git_status", "succeeded")]]) })).toBe(
      "model",
    );
  });

  it("names a running verifier apart from any other running tool", () => {
    const input = { snapshot: snapshot(), pendingDecision: false };
    expect(runPhase({ ...input, feed: feed([[tool("keiko_verification", "running")]]) })).toBe(
      "verifier",
    );
    expect(runPhase({ ...input, feed: feed([[tool("keiko_workspace_read", "pending")]]) })).toBe(
      "tool",
    );
  });

  it("reads only the newest turn and only the run's own feed", () => {
    const input = { snapshot: snapshot(), pendingDecision: false };
    const stale = feed([[tool("keiko_verification", "running")], []]);
    expect(runPhase({ ...input, feed: stale })).toBe("model");
    const foreign = feed([[tool("keiko_verification", "running")]], "run-0");
    expect(runPhase({ ...input, feed: foreign })).toBe("model");
  });

  it.each([
    ["an approval", snapshot({ state: "awaiting-approval" }), false],
    [
      "a pending permission",
      snapshot({ pendingPermission: {} as CodingWorkbenchRuntimePendingPermission }),
      false,
    ],
    [
      "a script-trust pause",
      snapshot({ state: "paused", pauseReason: "workspace-script-trust" }),
      false,
    ],
    ["a question or changeset review", snapshot(), true],
  ] as const)("waits for a decision on %s", (_label, run, pendingDecision) => {
    expect(runPhase({ snapshot: run, feed: null, pendingDecision })).toBe("decision");
  });

  it.each(["idle", "paused", "succeeded", "failed", "starting"] as const)(
    "has no phase for a %s run without a pending decision",
    (state) => {
      expect(runPhase({ snapshot: snapshot({ state }), feed: null, pendingDecision: false })).toBe(
        null,
      );
    },
  );

  it("has no phase without a run", () => {
    expect(runPhase({ snapshot: null, feed: null, pendingDecision: true })).toBeNull();
  });
});

describe("runStartedAt", () => {
  it("is the run's first published event or its starting status", () => {
    expect(runStartedAt([status(0, "starting", STARTED)], "run-1")).toBe(Date.parse(STARTED));
    expect(runStartedAt([status(3, "starting", STARTED)], "run-1")).toBe(Date.parse(STARTED));
  });

  it("never stands a later event in for an unknown start", () => {
    const later = status(7, "running", "2026-10-06T10:05:00.000Z");
    expect(runStartedAt([later], "run-1")).toBeNull();
    expect(runStartedAt([status(0, "starting", STARTED, "run-0")], "run-1")).toBeNull();
    expect(runStartedAt([status(0, "starting", "not a time")], "run-1")).toBeNull();
  });
});

describe("runSettledAt", () => {
  const settled = "2026-10-06T10:12:05.000Z";

  it("is the terminal status event of a settled run", () => {
    const events = [status(0, "starting", STARTED), status(9, "failed", settled)];
    expect(runSettledAt(snapshot({ state: "failed" }), events)).toBe(Date.parse(settled));
  });

  it("falls back to the settled snapshot when the terminal event is not held", () => {
    expect(runSettledAt(snapshot({ state: "succeeded", updatedAt: settled }), [])).toBe(
      Date.parse(settled),
    );
  });

  it("is null while the run is live or there is no run", () => {
    expect(runSettledAt(snapshot(), [status(9, "failed", settled)])).toBeNull();
    expect(runSettledAt(null, [])).toBeNull();
  });
});

describe("formatRunDuration", () => {
  it.each([
    [0, "0 s"],
    [45_900, "45 s"],
    [134_000, "2 min 14 s"],
    [3_780_000, "1 h 3 min"],
    [-5_000, "0 s"],
  ] as const)("formats %i ms as %s", (milliseconds, text) => {
    expect(formatRunDuration(milliseconds, t)).toBe(text);
  });
});
