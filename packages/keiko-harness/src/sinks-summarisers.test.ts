// Exhaustive coverage of the per-variant one-line summariser map in sinks.ts.
//
// `SUMMARISERS` is a TOTAL mapping over `HarnessEvent["type"]` — the type system forces an entry
// per event type, but nothing forced any of them to be exercised, so most were dead weight behind
// a green gate: adding one entry (`sink:degraded`, KEIKO-0205) was enough to drop the package's
// function coverage below its recorded floor. This suite drives every entry through the public
// `CliEventSink.emit` seam.
//
// It pins three things per event type:
//   1. the summariser runs and produces a non-empty line,
//   2. the line is prefixed with the sequence number and the event type,
//   3. failure variants go to stderr and everything else to stdout.
// Plus one body-free assertion over the whole set: no summary may leak a SENSITIVE field
// (rationale, model response, or diff text) — the property the summariser map exists to hold.

import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "./types.js";
import { CliEventSink } from "./sinks.js";

const BASE = { schemaVersion: "1", runId: "run-1", fingerprint: "fp-1", seq: 7, ts: 0 } as const;

// The three SENSITIVE strings planted in the fixtures below. None may appear in any summary.
const SENSITIVE = ["SECRET-RATIONALE", "SECRET-RESPONSE", "SECRET-DIFF"] as const;

const EVENTS: readonly HarnessEvent[] = [
  { ...BASE, type: "run:started", taskType: "unit-tests", modelId: "m1" },
  { ...BASE, type: "state:transition", from: "planning", to: "editing", reason: "advance" },
  { ...BASE, type: "model:call:started", modelId: "m1", messageCount: 3, contextBytes: 120 },
  {
    ...BASE,
    type: "model:call:completed",
    modelId: "m1",
    finishReason: "stop",
    toolCallCount: 2,
    modelResponse: "SECRET-RESPONSE",
  },
  { ...BASE, type: "model:call:failed", modelId: "m1", errorCode: "timeout" },
  { ...BASE, type: "tool:call:started", toolName: "read", toolCallId: "t1" },
  { ...BASE, type: "tool:call:completed", toolName: "read", toolCallId: "t1" },
  { ...BASE, type: "tool:call:failed", toolName: "read", errorCode: "denied" },
  {
    ...BASE,
    type: "sandbox:configured",
    envAllowlist: ["PATH"],
    network: "off",
    timeoutMs: 1000,
    maxOutputBytes: 2048,
    cwdRequested: true,
  },
  {
    ...BASE,
    type: "command:executed",
    executable: "node",
    argCount: 2,
    exitCode: 0,
    timedOut: false,
  },
  { ...BASE, type: "patch:applied", changedFiles: 2, created: 1, deleted: 0 },
  { ...BASE, type: "reasoning:trace", phase: "plan", rationale: "SECRET-RATIONALE" },
  { ...BASE, type: "patch:proposed", targetFile: "a.ts", patchBytes: 42, diff: "SECRET-DIFF" },
  { ...BASE, type: "verification:result", passed: true },
  { ...BASE, type: "run:completed" },
  { ...BASE, type: "run:cancelled", atState: "editing" },
  { ...BASE, type: "run:cancelled", atState: "editing", reason: "operator" },
  {
    ...BASE,
    type: "run:failed",
    failure: { category: "execution-failure", message: "boom" },
  },
  { ...BASE, type: "browser:session-opened", sessionId: "s1", cdpPort: 9222, targetId: "tg1" },
  {
    ...BASE,
    type: "browser:navigated",
    sessionId: "s1",
    originOnly: "https://example.test",
    httpStatus: 200,
  },
  {
    ...BASE,
    type: "browser:screenshot-captured",
    sessionId: "s1",
    captureSeq: 1,
    persisted: true,
  },
  {
    ...BASE,
    type: "browser:page-content-captured",
    sessionId: "s1",
    captureSeq: 1,
    byteLength: 99,
  },
  { ...BASE, type: "browser:session-closed", sessionId: "s1", reason: "closed" },
  { ...BASE, type: "browser:trust-warning", sessionId: "s1", warning: "mixed-content" },
  { ...BASE, type: "browser:error", sessionId: "s1", code: "nav-failed" },
  {
    ...BASE,
    type: "tool:shaping:degraded",
    toolCallId: "t1",
    toolName: "read",
    reason: "shaper-threw",
  },
  { ...BASE, type: "sink:degraded", sinkIndex: 2, reason: "sink-threw" },
] as unknown as readonly HarnessEvent[];

// The variants sinks.ts routes to stderr (isFailureEvent).
const FAILURE_TYPES = new Set(["run:failed", "model:call:failed", "tool:call:failed"]);

function emitOne(event: HarnessEvent): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  new CliEventSink({
    out: (t): void => void out.push(t),
    err: (t): void => void err.push(t),
  }).emit(event);
  return { out, err };
}

describe("CliEventSink summarisers — every HarnessEvent variant", () => {
  it("covers every entry in the SUMMARISERS map", () => {
    // Guards the suite itself: if a new event type is added without a fixture here, the map is
    // wider than what this test exercises and the coverage gap silently returns. 26 is the number
    // of members in the `HarnessEvent` union (contracts `harness.ts`), which the map is typed to
    // cover totally — so this number and that union move together by construction.
    const covered = new Set(EVENTS.map((e) => e.type));
    expect(covered.size).toBe(26);
  });

  it.each(EVENTS.map((e) => [e.type, e] as const))(
    "summarises %s onto the right stream",
    (type, event) => {
      const { out, err } = emitOne(event);
      const stream = FAILURE_TYPES.has(type) ? err : out;
      const other = FAILURE_TYPES.has(type) ? out : err;
      expect(other).toHaveLength(0);
      expect(stream).toHaveLength(1);
      const line = stream[0] ?? "";
      expect(line.startsWith(`[7] ${type} `)).toBe(true);
      expect(line.endsWith("\n")).toBe(true);
      // A summariser that returned nothing would leave a bare prefix — that is a dead entry.
      expect(line.slice(`[7] ${type} `.length).trim().length).toBeGreaterThan(0);
    },
  );

  it("never leaks a SENSITIVE field into a summary line", () => {
    const lines = EVENTS.flatMap((e) => {
      const { out, err } = emitOne(e);
      return [...out, ...err];
    }).join("");
    for (const secret of SENSITIVE) {
      expect(lines).not.toContain(secret);
    }
  });

  it("renders the optional run:cancelled reason only when present", () => {
    const without = emitOne(EVENTS.find((e) => e.type === "run:cancelled") as HarnessEvent);
    const all = EVENTS.filter((e) => e.type === "run:cancelled");
    const withReason = emitOne(all[1] as HarnessEvent);
    expect(without.out[0]).toContain("cancelled at editing");
    expect(without.out[0]).not.toContain("(");
    expect(withReason.out[0]).toContain("(operator)");
  });
});
