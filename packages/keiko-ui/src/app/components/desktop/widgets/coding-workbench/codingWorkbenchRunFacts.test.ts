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
import {
  formatRunDuration,
  modelGatewayRetrying,
  nativeRunRetry,
  runPhase,
  runSettledAt,
  runStartedAt,
} from "./codingWorkbenchRunFacts";

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

// #3873 review: during a provider outage the run's gateway retries for minutes and the status line
// read "Waiting for the model" for the whole window. The gateway facts the sidecar route publishes
// to the run's event replay — `model-gateway-retrying`, `model-gateway-recovered` and
// `model-gateway-retry-stopped` — name the phase.
function gatewayFact(
  sequence: number,
  eventKind: "model-gateway-retrying" | "model-gateway-recovered" | "model-gateway-retry-stopped",
  runId = "run-1",
): CodingWorkbenchRuntimeSseEvent {
  return {
    schemaVersion: "1",
    cursor: `${runId}:${String(sequence)}`,
    sequence,
    occurredAt: STARTED,
    kind: "runtime-event",
    runId,
    state: "running",
    revision: 4,
    eventKind,
  };
}

describe("runPhase", () => {
  it("waits for the model while a running run has no unsettled tool", () => {
    const input = { snapshot: snapshot(), events: [], pendingDecision: false };
    expect(runPhase({ ...input, feed: null })).toBe("model");
    expect(runPhase({ ...input, feed: feed([[tool("keiko_git_status", "succeeded")]]) })).toBe(
      "model",
    );
  });

  it("names a running verifier apart from any other running tool", () => {
    const input = { snapshot: snapshot(), events: [], pendingDecision: false };
    expect(runPhase({ ...input, feed: feed([[tool("keiko_verification", "running")]]) })).toBe(
      "verifier",
    );
    expect(runPhase({ ...input, feed: feed([[tool("keiko_workspace_read", "pending")]]) })).toBe(
      "tool",
    );
  });

  it("reads only the newest turn and only the run's own feed", () => {
    const input = { snapshot: snapshot(), events: [], pendingDecision: false };
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
    expect(runPhase({ snapshot: run, feed: null, events: [], pendingDecision })).toBe("decision");
  });

  it.each(["idle", "paused", "succeeded", "failed", "starting"] as const)(
    "has no phase for a %s run without a pending decision",
    (state) => {
      expect(
        runPhase({ snapshot: snapshot({ state }), feed: null, events: [], pendingDecision: false }),
      ).toBeNull();
    },
  );

  it("has no phase without a run", () => {
    expect(runPhase({ snapshot: null, feed: null, events: [], pendingDecision: true })).toBeNull();
  });

  describe("a model gateway that is being retried", () => {
    const input = { snapshot: snapshot(), feed: null, pendingDecision: false } as const;

    it("names the gateway while the newest event of the run is the retrying fact", () => {
      const events = [status(0, "starting", STARTED), gatewayFact(1, "model-gateway-retrying")];
      expect(runPhase({ ...input, events })).toBe("gateway");
    });

    it("names the model again once the recovered fact follows", () => {
      const events = [
        gatewayFact(1, "model-gateway-retrying"),
        gatewayFact(2, "model-gateway-recovered"),
      ];
      expect(runPhase({ ...input, events })).toBe("model");
    });

    // A call the run cancelled while it was retried ends with no answer: the retry-stopped fact is
    // what stops the status from naming a gateway nobody retries any more, while the model of the
    // next call generates (PR #3876 review).
    it("names the model again once the retry was stopped, and the gateway again if it resumes", () => {
      const stopped = [
        gatewayFact(1, "model-gateway-retrying"),
        gatewayFact(2, "model-gateway-retry-stopped"),
      ];
      expect(runPhase({ ...input, events: stopped })).toBe("model");
      expect(modelGatewayRetrying(stopped, "run-1")).toBe(false);

      const resumed = [...stopped, gatewayFact(3, "model-gateway-retrying")];
      expect(runPhase({ ...input, events: resumed })).toBe("gateway");
    });

    // The server publishes the retrying fact again when a frame that follows it ended the phase while
    // the call kept retrying; the status follows it back.
    it("names the gateway again when the retrying fact is published after a frame that ended it", () => {
      const events = [
        gatewayFact(1, "model-gateway-retrying"),
        status(2, "running", STARTED),
        gatewayFact(3, "model-gateway-retrying"),
      ];
      expect(runPhase({ ...input, events: events.slice(0, 2) })).toBe("model");
      expect(runPhase({ ...input, events })).toBe("gateway");
    });

    // A lost recovery frame must not leave the status claiming an outage for good: any later event
    // of the run is newer than the retrying fact.
    it.each([
      ["a status frame", status(2, "running", STARTED)],
      [
        "a failed turn",
        {
          ...gatewayFact(2, "model-gateway-retrying"),
          eventKind: "failure-redacted",
          failureCode: "provider-failed",
        } as CodingWorkbenchRuntimeSseEvent,
      ],
      [
        "a task event",
        { ...gatewayFact(2, "model-gateway-retrying"), eventKind: "diff-summarized" } as const,
      ],
    ])("names the model again after %s that follows the retrying fact", (_label, later) => {
      const events = [gatewayFact(1, "model-gateway-retrying"), later];
      expect(runPhase({ ...input, events })).toBe("model");
    });

    it("keeps naming the gateway after repeated retrying facts of one outage", () => {
      const events = [
        gatewayFact(1, "model-gateway-retrying"),
        gatewayFact(2, "model-gateway-retrying"),
      ];
      expect(runPhase({ ...input, events })).toBe("gateway");
    });

    it("names the gateway ahead of a tool the run still lists as unsettled", () => {
      const events = [gatewayFact(1, "model-gateway-retrying")];
      const unsettled = feed([[tool("keiko_workspace_read", "running")]]);
      expect(runPhase({ ...input, feed: unsettled, events })).toBe("gateway");
    });

    it("reads only the run's own events", () => {
      const events = [gatewayFact(1, "model-gateway-retrying", "run-0")];
      expect(runPhase({ ...input, events })).toBe("model");
    });

    it("is not a phase of a run that waits for a decision, is paused or has settled", () => {
      const events = [gatewayFact(1, "model-gateway-retrying")];
      expect(
        runPhase({ ...input, snapshot: snapshot({ state: "awaiting-approval" }), events }),
      ).toBe("decision");
      for (const state of ["paused", "succeeded", "failed", "cancelled"] as const) {
        expect(runPhase({ ...input, snapshot: snapshot({ state }), events })).toBeNull();
      }
    });
  });
});

describe("modelGatewayRetrying", () => {
  it("is false without a run, without events and without a gateway fact", () => {
    expect(modelGatewayRetrying([gatewayFact(1, "model-gateway-retrying")], undefined)).toBe(false);
    expect(modelGatewayRetrying([], "run-1")).toBe(false);
    expect(modelGatewayRetrying([status(0, "running", STARTED)], "run-1")).toBe(false);
  });

  it("follows the newest event of the run, whatever other runs published since", () => {
    const events = [
      gatewayFact(1, "model-gateway-retrying"),
      status(5, "running", STARTED, "run-2"),
    ];
    expect(modelGatewayRetrying(events, "run-1")).toBe(true);
    expect(modelGatewayRetrying(events, "run-2")).toBe(false);
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

describe("native physical retry facts", () => {
  const fact: CodingWorkbenchRuntimeSseEvent = {
    schemaVersion: "1",
    cursor: "run-1:2",
    sequence: 2,
    occurredAt: STARTED,
    kind: "runtime-event",
    runId: "run-1",
    state: "running",
    revision: 4,
    eventKind: "native-retry-changed",
    nativeRetry: { attempt: 2, scheduledAt: "2026-10-06T10:00:02.000Z" },
  };
  it("keeps the source fact across gateway progress and never derives an attempt from it", () => {
    expect(nativeRunRetry(snapshot(), [gatewayFact(1, "model-gateway-retrying")])).toBeNull();
    expect(nativeRunRetry(snapshot(), [fact, gatewayFact(3, "model-gateway-retrying")])).toEqual(
      fact.nativeRetry,
    );
    expect(nativeRunRetry(snapshot({ runId: "run-other" }), [fact])).toBeNull();
    expect(nativeRunRetry(snapshot({ state: "succeeded" }), [fact])).toBeNull();
    expect(
      nativeRunRetry(snapshot(), [fact, { ...fact, nativeRetry: null, sequence: 3 }]),
    ).toBeNull();
  });
});
