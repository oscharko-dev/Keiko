// The activity-log seam inside openKnowledgeStore's catch blocks.
//
// Both log sites sit inside a catch whose contract is that it introduces NO new failure: the
// quarantine path is mid-recovery from a corrupt database, and the encryption path is about to
// rethrow the cause the caller must see. An injected sink is foreign code — the server's file sink
// can hit a full disk or a revoked directory, and a test double can throw outright — so an
// unguarded `write` there would replace a diagnosable store failure with a logging failure, which
// is the one thing instrumentation must never do.
//
// The other half of that rule is tested here too: not surfacing is not the same as discarding.
// Quarantine is the one DATA-LOSING decision this file makes, so a dropped line about it that
// nobody can see reproduces the silence this whole activity log was built to end. The seam in
// `knowledge-log.ts` reports the drop through the sink itself, and through the process warning
// channel when the sink is dead for every shape.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { KnowledgeStoreError } from "./errors.js";
import type { KnowledgeLogEvent, KnowledgeLogSink } from "./knowledge-log.js";
import { openKnowledgeStore } from "./store.js";

function throwingLogSink(): KnowledgeLogSink {
  return {
    write(_event: KnowledgeLogEvent): void {
      throw new Error("the activity log sink is down");
    },
  };
}

function recordingLogSink(events: KnowledgeLogEvent[]): KnowledgeLogSink {
  return {
    write(event: KnowledgeLogEvent): void {
      events.push(event);
    },
  };
}

function sinkFailingOn(failingOp: string, events: KnowledgeLogEvent[]): KnowledgeLogSink {
  return {
    write(event: KnowledgeLogEvent): void {
      if (event.op === failingOp)
        throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      events.push(event);
    },
  };
}

describe("openKnowledgeStore — a failing log sink never becomes the failure", () => {
  let tmp: string;
  // The dead-sink specs below report through `process.emitWarning`; the spy is what keeps that
  // report out of the suite's stderr and makes it assertable.
  // `vi.spyOn`'s generic constraint does not admit an overloaded member such as
  // `process.emitWarning`, so the spy is typed by what it IS rather than by that lookup.
  let warn: MockInstance;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "keiko-store-log-sink-"));
    warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("still recovers a corrupt store when the sink throws", () => {
    const dbPath = join(tmp, "capsules.db");
    writeFileSync(dbPath, "not a sqlite database — partial write");

    const store = openKnowledgeStore({ dbPath, logSink: throwingLogSink() });
    try {
      // The recovery completed: the quarantine happened and a usable empty store came back,
      // exactly as it does with no sink wired at all.
      const row = store._internal.db.prepare("SELECT COUNT(*) AS n FROM capsules").get() as
        { readonly n: number } | undefined;
      expect(row?.n).toBe(0);
    } finally {
      store.close();
    }
  });

  // Failure-first: with the drop discarded outright, `events` stays empty and the operator has no
  // evidence that the store threw away a database.
  it("reports the dropped quarantine line through the sink that took the next write", () => {
    const dbPath = join(tmp, "reported.db");
    writeFileSync(dbPath, "not a sqlite database — partial write");
    const events: KnowledgeLogEvent[] = [];

    openKnowledgeStore({
      dbPath,
      logSink: sinkFailingOn("knowledge.store.quarantined", events),
    }).close();

    expect(events).toStrictEqual([
      {
        level: "error",
        category: "diagnostic",
        op: "knowledge.log.sink-failed",
        errorKind: "ENOSPC",
        extra: { droppedOp: "knowledge.store.quarantined" },
      },
    ]);
  });

  it("reports a wholly dead sink on the process warning channel instead of dropping it", () => {
    const dbPath = join(tmp, "dead-sink.db");
    writeFileSync(dbPath, "not a sqlite database — partial write");

    openKnowledgeStore({ dbPath, logSink: throwingLogSink() }).close();

    expect(warn).toHaveBeenCalledTimes(1);
    const calls: readonly (readonly unknown[])[] = warn.mock.calls;
    expect(calls[0]?.[1]).toMatchObject({
      code: "KEIKO_LOG_SINK_FAILED",
      detail: "op=knowledge.store.quarantined errorKind=Error",
    });
    // The sink's own message is a body like any other and never reaches the report.
    expect(JSON.stringify(calls)).not.toContain("the activity log sink is down");
  });

  it("rethrows the encryption cause, not the sink's error", () => {
    const dbPath = join(tmp, "encrypted.db");
    let thrown: unknown;
    try {
      openKnowledgeStore({
        dbPath,
        // Encryption requested with no key provider: resolveContentCipher fails closed.
        protection: { mode: "encrypted-key-provider" },
        logSink: throwingLogSink(),
      });
    } catch (error) {
      thrown = error;
    }

    // The caller must see the store's own fail-closed cause. Unguarded, the sink's error replaced
    // it and the operator was told the log was down instead of that the key was missing.
    expect(thrown).toBeInstanceOf(KnowledgeStoreError);
    expect((thrown as Error).message).not.toContain("activity log sink");
  });

  it("still emits both events to a sink that works", () => {
    const quarantineEvents: KnowledgeLogEvent[] = [];
    const corruptPath = join(tmp, "corrupt.db");
    writeFileSync(corruptPath, "not a sqlite database — partial write");
    openKnowledgeStore({
      dbPath: corruptPath,
      logSink: recordingLogSink(quarantineEvents),
    }).close();
    expect(quarantineEvents.map((event) => event.op)).toStrictEqual([
      "knowledge.store.quarantined",
    ]);
    expect(quarantineEvents[0]).toMatchObject({ level: "error", extra: { reopened: true } });

    const encryptionEvents: KnowledgeLogEvent[] = [];
    expect(() => {
      openKnowledgeStore({
        dbPath: join(tmp, "encrypted.db"),
        protection: { mode: "encrypted-key-provider" },
        logSink: recordingLogSink(encryptionEvents),
      });
    }).toThrow(KnowledgeStoreError);
    expect(encryptionEvents.map((event) => event.op)).toStrictEqual([
      "knowledge.store.encryption-rejected",
    ]);
  });
});
