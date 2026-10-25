import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
// The adapter every BFF composition site hands to a domain package. Two properties are
// load-bearing and both are invisible at the call sites that depend on them: the sink must reach
// whichever logger is installed AT WRITE TIME, and its level predicate must answer from that same
// logger rather than from a value frozen at import.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryId, MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";
import { createMemoryVault } from "@oscharko-dev/keiko-memory-vault";
import {
  expectRegisteredActivityLogLine,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import {
  activityLogEvent,
  activityLogEventRegistration,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import { createServerLogger, nullServerLogSink, setServerLogger } from "./observability/index.js";
import {
  consolidationLogSinkFor,
  logCommandTermination,
  processServerLogSink,
  processServerLogSinkFor,
} from "./process-log-sink.js";

const PROCESS_WRAPPER_FIXTURE = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "test.process-wrapper",
  category: "setup",
  owner: "keiko-server",
  emitter: "process-log-sink.test.process-wrapper",
  fields: {},
  causal: "none",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["test-fixture"],
  proofIds: ["test.process-wrapper.registration"],
  releaseImpact: "none",
});

const CONSOLIDATION_WRAPPER_FIXTURE = defineActivityLogOperation({
  ...PROCESS_WRAPPER_FIXTURE,
  op: "test.consolidation-wrapper",
  category: "consolidation",
  emitter: "process-log-sink.test.consolidation-wrapper",
  proofIds: ["test.consolidation-wrapper.registration"],
});

afterEach(() => {
  resetServerLogger();
});

describe("processServerLogSink", () => {
  it("delivers a written event to the logger installed at write time", () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));

    processServerLogSink().write({ category: "indexing", op: "indexing.job.started" });

    expect(sink.events).toEqual([
      {
        level: "info",
        category: "indexing",
        op: "indexing.job.started",
        correlationId: undefined,
        durationMs: undefined,
        status: undefined,
        errorKind: undefined,
        extra: undefined,
      },
    ]);
  });

  // The composition sites below call `processServerLogSink()` while the module graph is loading —
  // before the CLI has resolved the state directory and installed the real logger. A sink that
  // captured the logger at that moment would hold the null one forever and every line from a
  // six-minute indexing wall would be discarded with nothing to show for it.
  it("follows a logger replaced after the sink was already handed out", () => {
    setServerLogger(createServerLogger({ sink: nullServerLogSink(), level: "debug" }));
    const held = processServerLogSink();
    const later = createBufferedServerLogSink();

    setServerLogger(createServerLogger({ sink: later, level: "debug" }));
    held.write({ category: "embedding", op: "embedding.batch.grouped" });

    expect(later.events.map((event) => event.op)).toEqual(["embedding.batch.grouped"]);
  });

  it("carries the event's own level rather than defaulting every line to info", () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const held = processServerLogSink();

    held.write({ level: "warn", category: "gateway", op: "gateway.route.rejected" });
    held.write({ level: "debug", category: "http", op: "http.gateway.fetch.completed" });

    expect(sink.events.map((event) => event.level)).toEqual(["warn", "debug"]);
  });

  it("answers the level predicate from the live logger threshold", () => {
    setServerLogger(createServerLogger({ sink: nullServerLogSink(), level: "warn" }));
    const held = processServerLogSink();

    expect(held.enabled("debug")).toBe(false);
    expect(held.enabled("warn")).toBe(true);

    setServerLogger(createServerLogger({ sink: nullServerLogSink(), level: "debug" }));

    expect(held.enabled("debug")).toBe(true);
  });

  it("drops a below-threshold event instead of writing it", () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "warn" }));

    processServerLogSink().write({ level: "debug", category: "search", op: "search.noisy" });

    expect(sink.events).toEqual([]);
  });

  it("binds an absent correlation id without replacing producer-owned correlation", () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const bootstrap = processServerLogSinkFor("bootstrap-correlation-1");

    bootstrap.write({ category: "setup", op: "store.opened" });
    bootstrap.write({
      category: "setup",
      op: "store.opened",
      correlationId: "producer-correlation-1",
    });

    expect(sink.events.map((event) => event.correlationId)).toEqual([
      "bootstrap-correlation-1",
      "producer-correlation-1",
    ]);
  });

  it("preserves typed registration through correlation wrappers", () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const processEvent = activityLogEvent(PROCESS_WRAPPER_FIXTURE, {}, {});
    const consolidationEvent = activityLogEvent(CONSOLIDATION_WRAPPER_FIXTURE, {}, {});

    processServerLogSinkFor("process-correlation-1").write(processEvent);
    consolidationLogSinkFor("consolidation-correlation-1").write(consolidationEvent);

    expect(activityLogEventRegistration(sink.events[0] ?? {})).toBe(PROCESS_WRAPPER_FIXTURE);
    expect(activityLogEventRegistration(sink.events[1] ?? {})).toBe(CONSOLIDATION_WRAPPER_FIXTURE);
  });
});

// A single termination can emit TWO lines: the SIGTERM step, and — only when the child ignored it —
// the SIGKILL escalation. They must be distinguishable in the log, because the escalation is the
// step where a failed tree-kill actually matters (AGENTS.md §8: reconstructible from the log alone).
describe("logCommandTermination", () => {
  function write(evidence: Parameters<typeof logCommandTermination>[2]): Record<string, unknown> {
    const sink = createBufferedServerLogSink();
    logCommandTermination(sink, "corr-1", evidence);
    const event = sink.events[0];
    expect(event?.op).toBe("command.terminated");
    expect(event?.correlationId).toBe("unknown-correlation-id");
    return event?.extra ?? {};
  }

  it("omits the escalation key entirely on the SIGTERM line", () => {
    const extra = write({ reason: "timeout", childPid: 4242, windowsTreeKill: "succeeded" });
    expect(extra).toMatchObject({
      reason: "timeout",
      childPid: 4242,
      windowsTreeKill: "succeeded",
    });
    // Absent, not undefined: a present-but-empty key reads as "escalation happened, outcome unknown".
    expect(Object.hasOwn(extra, "escalation")).toBe(false);
  });

  it("carries the escalation's own disposition on the escalation line", () => {
    const extra = write({
      reason: "timeout",
      childPid: 4242,
      windowsTreeKill: "failed",
      escalation: "failed",
    });
    expect(extra.escalation).toBe("failed");
  });

  it("keeps the two lines distinguishable when only the escalation failed", () => {
    const first = write({ reason: "abort", childPid: 7, windowsTreeKill: "succeeded" });
    const second = write({
      reason: "abort",
      childPid: 7,
      windowsTreeKill: "failed",
      escalation: "failed",
    });
    expect(Object.hasOwn(first, "escalation")).toBe(false);
    expect(second.escalation).toBe("failed");
  });
});

it("supplies the canonical body-free failure reducers through process sinks", () => {
  const error = new TypeError("private-body", { cause: new RangeError("private-cause") });
  error.stack =
    "TypeError: private-body\n at admit (/private/install/packages/keiko-model-gateway/dist/prompt-admission.js:80:4)";
  for (const sink of [processServerLogSink(), processServerLogSinkFor("request")]) {
    const evidence = sink.errorEvidence(error);
    expect(evidence).toEqual({
      frames: ["packages/keiko-model-gateway/dist/prompt-admission.js:80:4"],
      causeChain: ["RangeError"],
    });
    expect(JSON.stringify(evidence)).not.toMatch(/private-/u);
  }
});

function processMemoryCaptureRecord(validity: { validFrom: number }): MemoryRecord {
  return {
    id: "process-memory-capture" as MemoryId,
    schemaVersion: "1",
    scope: { kind: "global" },
    type: "preference",
    body: "private-memory-provider-canary",
    status: "accepted",
    pinned: false,
    tags: [],
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: 100,
      confidence: 0.9,
      sensitivity: "public",
    },
    validity,
    createdAt: 100,
    updatedAt: 100,
  };
}

function processMemoryCaptureFixture(
  memoryDir: string,
  error: TypeError,
): {
  readonly vault: ReturnType<typeof createMemoryVault>;
  readonly record: MemoryRecord;
  readonly arm: () => void;
} {
  const validity = { validFrom: 100 };
  let armed = false;
  const vault = createMemoryVault({
    memoryDir,
    vaultKey: Buffer.alloc(32, 7),
    logSink: processServerLogSinkFor("bootstrap-memory"),
    redactString: (value) => {
      if (armed)
        Object.defineProperty(validity, "validUntil", {
          configurable: true,
          get: (): never => {
            throw error;
          },
        });
      return value;
    },
  });
  return {
    vault,
    record: processMemoryCaptureRecord(validity),
    arm: (): void => {
      armed = true;
    },
  };
}

it("supplies real process evidence to the Memory physical capture producer", () => {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  const error = new TypeError("private-memory-provider-canary");
  error.stack =
    "TypeError: private-memory-provider-canary\n at capture (/private/install/packages/keiko-memory-vault/dist/serialize.js:80:4)";
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-memory-process-evidence-"));
  let vault: ReturnType<typeof createMemoryVault> | undefined;
  try {
    const fixture = processMemoryCaptureFixture(dir, error);
    vault = fixture.vault;
    fixture.arm();
    let caught: unknown;
    try {
      vault.insertMemory(fixture.record, { correlationId: "memory-provider-request" });
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBe(error);
    const captureEvents = sink.events.filter(
      (event) => event.op === "memory-vault.write.capture-failed",
    );
    expect(captureEvents).toHaveLength(1);
    expect(captureEvents[0]).toMatchObject({
      op: "memory-vault.write.capture-failed",
      correlationId: "memory-provider-request",
      extra: {
        frames: ["packages/keiko-memory-vault/dist/serialize.js:80:4"],
        completeness: "complete",
        loss: "none",
      },
    });
    expect(
      expectRegisteredActivityLogLine(
        "memory-vault.write.capture-failed",
        formatActivityLogProofLine(captureEvents[0] ?? {}),
      ),
    ).toMatchObject({
      correlationId: "memory-provider-request",
      completeness: "complete",
      loss: "none",
    });
    expect(JSON.stringify(sink.events)).not.toContain("private-memory-provider-canary");
  } finally {
    vault?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
