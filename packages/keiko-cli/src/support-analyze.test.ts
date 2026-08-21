import { describe, expect, it } from "vitest";

import {
  analyzeLogText,
  detectSourceKind,
  findTimeline,
  renderHumanAllTimelines,
  renderHumanTimeline,
  type LogTimeline,
} from "./support-analyze.js";

function line(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

const T0 = "2026-08-21T00:00:00.000Z";
const T1 = "2026-08-21T00:00:01.000Z";
const T2 = "2026-08-21T00:00:02.000Z";
const T3 = "2026-08-21T00:00:03.000Z";

describe("detectSourceKind", () => {
  it("recognises a bundle's manifest first line", () => {
    expect(detectSourceKind(line({ $section: "manifest", schemaVersion: 2 }))).toBe("bundle");
  });

  it("treats a raw log's first line (ts+category+op, no $section) as raw-log", () => {
    expect(detectSourceKind(line({ ts: T0, category: "http", op: "a" }))).toBe("raw-log");
  });

  it("falls back to raw-log for an empty file or unparsable first line", () => {
    expect(detectSourceKind(undefined)).toBe("raw-log");
    expect(detectSourceKind("not json at all")).toBe("raw-log");
  });
});

// Interleaved-pid ordering fixture (spec: "analyzer ordering with interleaved pids"):
//   file order: L4 (pre-v2, no pid/instanceId/seq) < L2 (pid 1111, seq 1) < L1 (pid 1111, seq 2)
//               < L3 (pid 2222, seq 1)
// Expected reconstruction order: L4 (a pre-v2 line ranks by its own file position), then the
// lifetime pid 1111 (first seen at L2) with L2 before L1 by seq, then the lifetime pid 2222 (first
// seen later, at L3).
const L4_PRE_V2 = line({ ts: T0, category: "job", op: "job.spawned", correlationId: "req-1" });
const L2 = line({
  ts: T1,
  category: "http",
  op: "op.a",
  correlationId: "req-1",
  pid: 1111,
  instanceId: "aaaaaaaa",
  seq: 1,
});
const L1 = line({
  ts: T2,
  category: "http",
  op: "op.b",
  correlationId: "req-1",
  pid: 1111,
  instanceId: "aaaaaaaa",
  seq: 2,
  errorKind: "GATEWAY_TIMEOUT",
});
const L3 = line({
  ts: T3,
  category: "http",
  op: "op.c",
  correlationId: "req-1",
  pid: 2222,
  instanceId: "bbbbbbbb",
  seq: 1,
  errorKind: "GATEWAY_5XX",
});
const OTHER_CORRELATION = line({
  ts: "2026-08-21T00:00:04.000Z",
  category: "http",
  op: "op.d",
  correlationId: "req-2",
  pid: 3333,
  instanceId: "cccccccc",
  seq: 1,
});
const NO_CORRELATION_ID = line({
  ts: "2026-08-21T00:00:05.000Z",
  category: "process",
  op: "process.started",
});
const MISSING_CATEGORY = JSON.stringify({ ts: "2026-08-21T00:00:06.000Z", op: "x" });
const GARBAGE = "not-json-at-all{{{";

const FIXTURE_TEXT =
  [L4_PRE_V2, L2, L1, L3, OTHER_CORRELATION, NO_CORRELATION_ID, MISSING_CATEGORY, GARBAGE].join(
    "\n",
  ) + "\n";

describe("analyzeLogText — raw log", () => {
  const result = analyzeLogText(FIXTURE_TEXT);

  it("ranks process lifetimes by first appearance and orders each lifetime by seq; a pre-v2 line ranks by its own file position", () => {
    const req1 = result.timelines.find((t) => t.correlationId === "req-1");
    expect(req1?.lines.map((l) => l.op)).toEqual(["job.spawned", "op.a", "op.b", "op.c"]);
  });

  it("ranks a lifetime that started later AFTER an earlier one even when its pid is numerically smaller", () => {
    // The OS hands out pids in no order an agent may rely on; the file records which lifetime
    // wrote first. Numeric pid order would put pid 100 ahead of pid 900 here, inverting history.
    const first = line({
      ts: T0,
      category: "http",
      op: "first.a",
      correlationId: "r",
      pid: 900,
      instanceId: "e1e1e1e1",
      seq: 1,
    });
    const second = line({
      ts: T1,
      category: "http",
      op: "second.a",
      correlationId: "r",
      pid: 100,
      instanceId: "f2f2f2f2",
      seq: 1,
    });
    const firstAgain = line({
      ts: T2,
      category: "http",
      op: "first.b",
      correlationId: "r",
      pid: 900,
      instanceId: "e1e1e1e1",
      seq: 2,
    });
    const timeline = analyzeLogText([first, second, firstAgain].join("\n") + "\n").timelines[0];
    expect(timeline?.lines.map((l) => l.op)).toEqual(["first.a", "first.b", "second.a"]);
  });

  it("stays a total order when a pre-v2 line sits between two v2 lines of one lifetime", () => {
    // A per-pair rule switch (identity for v2/v2, file order otherwise) is not transitive: v2#2 <
    // pre-v2 < v2#1 by file order while v2#1 < v2#2 by seq, which hands `sort` a cycle and an
    // engine-dependent result. One rank per lifetime makes the outcome deterministic.
    const later = line({
      ts: T0,
      category: "http",
      op: "v2.second",
      correlationId: "r",
      pid: 1,
      instanceId: "a1a1a1a1",
      seq: 2,
    });
    const preV2 = line({ ts: T1, category: "http", op: "pre-v2", correlationId: "r" });
    const earlier = line({
      ts: T2,
      category: "http",
      op: "v2.first",
      correlationId: "r",
      pid: 1,
      instanceId: "a1a1a1a1",
      seq: 1,
    });
    const timeline = analyzeLogText([later, preV2, earlier].join("\n") + "\n").timelines[0];
    expect(timeline?.lines.map((l) => l.op)).toEqual(["v2.first", "v2.second", "pre-v2"]);
  });

  it("counts malformed lines (invalid JSON and JSON missing ts/category/op) without silently skipping them", () => {
    expect(result.malformedLineCount).toBe(2);
  });

  it("groups by correlationId, in first-occurrence order, excluding lines with no correlationId", () => {
    expect(result.timelines.map((t) => t.correlationId)).toEqual(["req-1", "req-2"]);
  });

  it("computes firstTs/lastTs/durationMs across the whole group", () => {
    const req1 = result.timelines.find((t) => t.correlationId === "req-1");
    expect(req1?.firstTs).toBe(T0);
    expect(req1?.lastTs).toBe(T3);
    expect(req1?.durationMs).toBe(3000);
  });

  it("collects distinct errorKinds in (post-sort) first-occurrence order", () => {
    const req1 = result.timelines.find((t) => t.correlationId === "req-1");
    expect(req1?.errorKinds).toEqual(["GATEWAY_TIMEOUT", "GATEWAY_5XX"]);
  });
});

describe("analyzeLogText — bundle auto-detect", () => {
  it("skips the manifest line without counting it as malformed, and analyzes the rest identically", () => {
    const manifestLine = line({ $section: "manifest", schemaVersion: 2 });
    const bundleText = `${manifestLine}\n${FIXTURE_TEXT}`;

    const result = analyzeLogText(bundleText);

    expect(result.malformedLineCount).toBe(2);
    expect(result.timelines.map((t) => t.correlationId)).toEqual(["req-1", "req-2"]);
  });
});

describe("analyzeLogText — extra fields and frames", () => {
  it("buckets unknown top-level keys under extra, and passes a frames array through typed", () => {
    const withExtras = line({
      ts: T0,
      category: "client",
      op: "client.diagnostic",
      correlationId: "req-extra",
      clientNote: "connection dropped",
      frames: ["packages/keiko-server/dist/observability/server-log.js:128:18"],
    });

    const result = analyzeLogText(`${withExtras}\n`);

    const timeline = findTimeline(result, "req-extra");
    expect(timeline?.lines[0]?.extra).toEqual({ clientNote: "connection dropped" });
    expect(timeline?.lines[0]?.frames).toEqual([
      "packages/keiko-server/dist/observability/server-log.js:128:18",
    ]);
  });

  it("omits extra entirely when no unknown key survives (never emits an empty object)", () => {
    const plain = line({ ts: T0, category: "http", op: "a", correlationId: "req-plain" });

    const result = analyzeLogText(`${plain}\n`);

    expect(findTimeline(result, "req-plain")?.lines[0]?.extra).toBeUndefined();
  });
});

describe("findTimeline", () => {
  it("returns undefined for a correlation id that is not present", () => {
    const result = analyzeLogText(FIXTURE_TEXT);
    expect(findTimeline(result, "does-not-exist")).toBeUndefined();
  });
});

describe("human-readable rendering", () => {
  const timeline: LogTimeline = {
    correlationId: "req-1",
    lines: [
      { ts: T0, seq: 1, category: "http", op: "op.a", level: "info" },
      {
        ts: T1,
        seq: 2,
        category: "http",
        op: "op.b",
        level: "error",
        errorKind: "TIMEOUT",
        durationMs: 42,
      },
    ],
    firstTs: T0,
    lastTs: T1,
    durationMs: 1000,
    errorKinds: ["TIMEOUT"],
  };

  it("renders one line per event with seq, level, category, op, and bracketed errorKind/durationMs", () => {
    const rendered = renderHumanTimeline(timeline);
    expect(rendered).toContain("correlationId=req-1");
    expect(rendered).toContain(`${T0} 1 info http op.a`);
    expect(rendered).toContain(`${T1} 2 error http op.b [TIMEOUT] [42ms]`);
  });

  it("renders a fallback line for zero timelines", () => {
    expect(renderHumanAllTimelines({ timelines: [], malformedLineCount: 0 })).toBe(
      "No correlated events found.\n",
    );
  });
});
