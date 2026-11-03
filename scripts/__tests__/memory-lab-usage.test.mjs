import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectUsage,
  renderUsage,
  summarizeUsage,
  usageOfEvents,
} from "../testing/memory-lab/usage.mjs";

function completed(op, correlationId, extra = {}) {
  return {
    op,
    correlationId,
    modelId: "m",
    promptTokens: 100,
    completionTokens: 10,
    durationMs: 1000,
    ...extra,
  };
}

// One conversation turn and its learner call, then two probe questions, each with its own learner
// call (the product also learns from the questions the lab asks), and a call that never ended.
const EVENTS = [
  { op: "gateway.chat.started", correlationId: "startup", requestId: "r0" },
  completed("gateway.chat.completed", "startup", { requestId: "r0" }),
  { op: "chat.turn.started", correlationId: "turn-1" },
  { op: "gateway.chat.started", correlationId: "turn-1", requestId: "r1" },
  completed("gateway.chat.completed", "turn-1", { requestId: "r1", promptTokens: 100 }),
  { op: "gateway.chat.started", correlationId: "learn-1", requestId: "r2" },
  completed("gateway.stream.completed", "learn-1", { requestId: "r2", promptTokens: 400 }),
  { op: "chat.turn.started", correlationId: "probe-1" },
  { op: "gateway.chat.started", correlationId: "probe-1", requestId: "r3" },
  completed("gateway.chat.completed", "probe-1", { requestId: "r3", promptTokens: 150 }),
  { op: "gateway.chat.started", correlationId: "learn-p1", requestId: "r4" },
  completed("gateway.chat.completed", "learn-p1", { requestId: "r4", promptTokens: 300 }),
  { op: "chat.turn.started", correlationId: "probe-2" },
  { op: "gateway.chat.started", correlationId: "probe-2", requestId: "r5" },
  completed("gateway.chat.completed", "probe-2", { requestId: "r5", promptTokens: 160 }),
  { op: "gateway.chat.started", correlationId: "learn-p2", requestId: "r6" },
  { op: "gateway.chat.failed", correlationId: "learn-p2", requestId: "r6" },
  { op: "gateway.chat.started", correlationId: "learn-p3", requestId: "r7" },
];

describe("memory lab usage", () => {
  it("splits calls into answering, conversation learning, probe-phase learning and start-up", () => {
    const usage = usageOfEvents(EVENTS, 1);
    expect(usage.answering).toEqual({
      calls: 3,
      promptTokens: 410,
      completionTokens: 30,
      durationMs: 3000,
    });
    expect(usage.learning).toEqual({
      calls: 1,
      promptTokens: 400,
      completionTokens: 10,
      durationMs: 1000,
    });
    // The learner calls the probe questions caused are not what learning from the conversation cost.
    expect(usage.probing).toEqual({
      calls: 1,
      promptTokens: 300,
      completionTokens: 10,
      durationMs: 1000,
    });
    expect(usage.other).toEqual({
      calls: 1,
      promptTokens: 100,
      completionTokens: 10,
      durationMs: 1000,
    });
    expect(usage.models).toEqual(["m"]);
  });

  it("counts a failed call as failed, not as unfinished, and a call without an end as unfinished", () => {
    const usage = usageOfEvents(EVENTS, 1);
    expect(usage.failed).toBe(1);
    expect(usage.unfinished).toBe(1);
  });

  it("counts every call after the first turn as learning when the number of turns is unknown", () => {
    const usage = usageOfEvents(EVENTS);
    expect(usage.learning.calls).toBe(2);
    expect(usage.probing.calls).toBe(0);
  });

  it("puts every learner call of an arm without conversation turns into the probe phase", () => {
    // The oracle arm learns nothing from a conversation: its learner calls answer the questions.
    const usage = usageOfEvents(EVENTS, 0);
    expect(usage.learning.calls).toBe(0);
    expect(usage.probing.calls).toBe(2);
  });

  it("tells two calls of one correlation apart by their request ids", () => {
    const usage = usageOfEvents([
      { op: "gateway.chat.started", correlationId: "same", requestId: "a" },
      { op: "gateway.chat.started", correlationId: "same", requestId: "b" },
      completed("gateway.chat.completed", "same", { requestId: "a" }),
    ]);
    expect(usage.unfinished).toBe(1);
  });

  it("summarizes per arm with tokens per live memory and renders a table", () => {
    const unit = { scenario: "s", arm: "product", repetition: 0, ...usageOfEvents(EVENTS, 1) };
    const rows = summarizeUsage(
      [unit, { ...unit, scenario: "t" }],
      new Map([
        ["s:product:r0", 2],
        ["t:product:r0", 0],
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].instances).toBe(2);
    expect(rows[0].liveMemories).toBe(2);
    expect(rows[0].learningTokensPerLiveMemory).toBe(410);
    expect(rows[0].meanCallMs).toBe(1000);
    expect(rows[0].failed).toBe(2);
    expect(rows[0].unfinished).toBe(2);
    expect(renderUsage(rows)).toContain(
      "| product | 2 | m | 2 | 800+20 | 6 | 820+60 | 2 | 600+20 | 2 | 1000 | 2 | 2 | 2 | 410 |",
    );
  });

  it("reports no cost per memory when nothing was learned", () => {
    const rows = summarizeUsage(
      [{ scenario: "s", arm: "off", repetition: 0, ...usageOfEvents([]) }],
      new Map(),
    );
    expect(rows[0].learningTokensPerLiveMemory).toBeNull();
    expect(rows[0].meanCallMs).toBeNull();
  });
});

const LOG_FILE = "activity-20261103T211455207Z-46397-6fa9c7a4-000001.jsonl";

describe("memory lab usage of a kept run", () => {
  let runDir;
  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), "memory-lab-usage-run-"));
  });
  afterEach(() => rmSync(runDir, { recursive: true, force: true }));

  // A kept unit: its state directory with a log, and the run file the runner wrote for it.
  function keepUnit(directoryName, runFile, result, events) {
    const logs = join(runDir, "state", directoryName, "state", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(logs, LOG_FILE),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    mkdirSync(join(runDir, "runs"), { recursive: true });
    writeFileSync(join(runDir, "runs", runFile), JSON.stringify(result));
  }

  function unitResult(repetition, live, turns = 1) {
    return {
      scenario: "pref-tables",
      arm: "product",
      repetition,
      store: { live },
      turns: Array.from({ length: turns }, () => ({})),
    };
  }

  it("counts the live memories of each repetition once, not once per kept directory", () => {
    // The failure this pins: the figure was keyed by scenario and arm, and added once for every
    // state directory, so three repetitions of 2 memories read as 3 x 6 = 18.
    for (const repetition of [0, 1, 2])
      keepUnit(
        `pref-tables-product-r${String(repetition)}-AbC12${String(repetition)}`,
        `pref-tables.product.r${String(repetition)}.json`,
        unitResult(repetition, 2),
        EVENTS,
      );
    return collectUsage(runDir).then((usage) => {
      expect(usage.units.map((unit) => unit.repetition)).toEqual([0, 1, 2]);
      expect(usage.byArm).toHaveLength(1);
      expect(usage.byArm[0].instances).toBe(3);
      expect(usage.byArm[0].liveMemories).toBe(6);
      expect(usage.skipped).toEqual([]);
    });
  });

  it("splits learning from probing with the number of turns the run file records", async () => {
    keepUnit(
      "pref-tables-product-r0-AbC120",
      "pref-tables.product.r0.json",
      unitResult(0, 1),
      EVENTS,
    );
    const usage = await collectUsage(runDir);
    expect(usage.byArm[0].learning.calls).toBe(1);
    expect(usage.byArm[0].probing.calls).toBe(1);
  });

  it("does not trust the turn count of a unit that failed", async () => {
    keepUnit(
      "pref-tables-product-r0-AbC120",
      "pref-tables.product.r0.json",
      { ...unitResult(0, 0, 0), error: { name: "Error", message: "" } },
      EVENTS,
    );
    const usage = await collectUsage(runDir);
    // Zero recorded turns would have put the learner call of the conversation into the probe phase.
    expect(usage.byArm[0].learning.calls).toBe(2);
    expect(usage.byArm[0].probing.calls).toBe(0);
  });

  it("lists a state directory of the older layout as skipped instead of misreading it", async () => {
    keepUnit("pref-tables-product-AbC120", "pref-tables.product.r0.json", unitResult(0, 1), EVENTS);
    const usage = await collectUsage(runDir);
    expect(usage.units).toEqual([]);
    expect(usage.skipped).toEqual(["pref-tables-product-AbC120"]);
  });
});
