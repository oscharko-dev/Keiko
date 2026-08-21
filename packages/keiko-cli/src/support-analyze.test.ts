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

  // Regression: `JSON.parse` defines a `"__proto__"` key as an ordinary OWN property (via
  // `[[DefineOwnProperty]]`), never as a prototype link — but assigning that key onto a plain
  // `{}` accumulator via `extra[key] = value` invokes `Object.prototype`'s inherited `__proto__`
  // setter instead of defining an own property. Before the fix, the setter silently replaces
  // `extra`'s own prototype (for an object value) instead of recording the field, so
  // `JSON.stringify(extra)` comes back `"{}"` even though a hostile line's `__proto__` key was
  // present — the exact silent skip this module must never perform. Constructed as a raw JSON
  // string (not an object literal): `{ __proto__: {...} }` as literal syntax sets the new
  // object's prototype directly and would never reach this code path at all.
  it("keeps a __proto__ key from a log line as its own field under extra, not as a prototype change", () => {
    const raw = `{"ts":"${T0}","category":"http","op":"a","correlationId":"req-evil","__proto__":{"polluted":true}}`;

    const result = analyzeLogText(`${raw}\n`);

    const extra = findTimeline(result, "req-evil")?.lines[0]?.extra;
    expect(extra).toBeDefined();
    expect(JSON.stringify(extra)).toBe('{"__proto__":{"polluted":true}}');
  });
});

const PROC_STARTED = line({
  ts: T0,
  category: "process",
  op: "process.started",
  pid: 4242,
  instanceId: "dddddddd",
  seq: 1,
  nodeVersion: "v24.18.0",
  port: 1983,
});
const PROC_HEARTBEAT = line({
  ts: T1,
  category: "process",
  op: "process.heartbeat",
  pid: 4242,
  instanceId: "dddddddd",
  seq: 2,
});
const PROC_EXITING = line({
  ts: T2,
  category: "process",
  op: "process.exiting",
  pid: 4242,
  instanceId: "dddddddd",
  seq: 3,
  reason: "SIGTERM",
});

describe("analyzeLogText — process lifetimes", () => {
  it("summarises a process lifetime across lifecycle lines that carry no correlationId", () => {
    const text = `${[PROC_STARTED, PROC_HEARTBEAT, PROC_EXITING].join("\n")}\n`;

    const result = analyzeLogText(text);

    expect(result.processes).toHaveLength(1);
    const summary = result.processes[0];
    expect(summary?.pid).toBe(4242);
    expect(summary?.instanceId).toBe("dddddddd");
    expect(summary?.firstSeq).toBe(1);
    expect(summary?.lastSeq).toBe(3);
    expect(summary?.lineCount).toBe(3);
    expect(summary?.firstTs).toBe(T0);
    expect(summary?.lastTs).toBe(T2);
    expect(summary?.started).toEqual({ nodeVersion: "v24.18.0", port: 1983 });
    expect(summary?.exitReason).toBe("SIGTERM");
  });

  it("ranks processes by first file appearance, the same rule timelines use", () => {
    const writtenFirst = line({
      ts: T0,
      category: "process",
      op: "process.started",
      pid: 900,
      instanceId: "e1e1e1e1",
      seq: 1,
    });
    const writtenSecond = line({
      ts: T1,
      category: "process",
      op: "process.started",
      pid: 100,
      instanceId: "f2f2f2f2",
      seq: 1,
    });
    // Written in this order — the numerically smaller pid must NOT jump ahead of it.
    const result = analyzeLogText(`${writtenFirst}\n${writtenSecond}\n`);

    expect(result.processes.map((p) => p.pid)).toEqual([900, 100]);
  });

  it("never summarises a lifecycle line missing the full v2 identity triple", () => {
    const result = analyzeLogText(`${NO_CORRELATION_ID}\n`);

    expect(result.processes).toEqual([]);
  });
});

describe("analyzeLogText — legacy line accounting and warnings", () => {
  it("reports zero legacy lines and no warning when every parsed line carries the full v2 identity triple", () => {
    const result = analyzeLogText(`${L2}\n`);

    expect(result.legacyLineCount).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it("counts lines lacking the full identity triple as legacy and emits exactly one named warning", () => {
    const result = analyzeLogText(FIXTURE_TEXT);

    // FIXTURE_TEXT's legacy lines: L4_PRE_V2 (no pid/instanceId/seq) and NO_CORRELATION_ID
    // (a process.started line with no identity triple either).
    expect(result.legacyLineCount).toBe(2);
    expect(result.warnings).toEqual([
      "2 line(s) predate the v2 envelope and were ordered by file position",
    ]);
  });
});

describe("human-readable rendering — processes and warnings", () => {
  it("renders a warning line naming the legacy line count", () => {
    const rendered = renderHumanAllTimelines(analyzeLogText(FIXTURE_TEXT));
    expect(rendered).toContain(
      "warning: 2 line(s) predate the v2 envelope and were ordered by file position",
    );
  });

  it("renders a process summary section with pid, instanceId, seq range, and exitReason", () => {
    const text = `${PROC_STARTED}\n${PROC_EXITING}\n`;
    const rendered = renderHumanAllTimelines(analyzeLogText(text));
    expect(rendered).toContain("Processes: 1");
    expect(rendered).toContain("pid=4242 instanceId=dddddddd");
    expect(rendered).toContain("seq=1-3");
    expect(rendered).toContain("exitReason=SIGTERM");
  });

  it("omits both sections when there are no lines at all", () => {
    const rendered = renderHumanAllTimelines(analyzeLogText(""));
    expect(rendered).not.toContain("Processes:");
    expect(rendered).not.toContain("warning:");
  });
});

describe("findTimeline", () => {
  it("returns undefined for a correlation id that is not present", () => {
    const result = analyzeLogText(FIXTURE_TEXT);
    expect(findTimeline(result, "does-not-exist")).toBeUndefined();
  });
});

describe("analyzeLogText — line-splitting and value-shape edge cases", () => {
  it("keeps the last line when the text has no trailing newline", () => {
    // splitLines only pops the single empty artifact a TRAILING newline produces; text that
    // already ends on real content must not lose that last line.
    const result = analyzeLogText(L2);

    expect(findTimeline(result, "req-1")?.lines).toHaveLength(1);
  });

  it("counts a line that parses as JSON but is not a plain object as malformed", () => {
    // `JSON.parse` succeeds for "42" (a bare number), but classifyLine needs an object shaped
    // like a log record — distinct from GARBAGE above, which fails JSON.parse itself.
    const result = analyzeLogText("42\n");

    expect(result.malformedLineCount).toBe(1);
    expect(result.timelines).toEqual([]);
  });

  it("buckets level and durationMs onto the view when the line carries them", () => {
    const withLevelAndDuration = line({
      ts: T0,
      category: "http",
      op: "req.a",
      correlationId: "req-level",
      level: "warn",
      durationMs: 42,
    });

    const result = analyzeLogText(`${withLevelAndDuration}\n`);

    const view = findTimeline(result, "req-level")?.lines[0];
    expect(view?.level).toBe("warn");
    expect(view?.durationMs).toBe(42);
  });

  it("skips a non-manifest $section line as bundle metadata, not as malformed", () => {
    // Wave 1 only ever sees the manifest's own `$section: "manifest"` at index 0 (already
    // stripped before classifyLine runs), but classifyLine's own check covers ANY `$section`
    // value so a future interstitial section marker is skipped, not counted as corruption.
    const result = analyzeLogText('{"$section":"notes"}\n');

    expect(result.malformedLineCount).toBe(0);
    expect(result.timelines).toEqual([]);
    expect(result.processes).toEqual([]);
  });

  it("deduplicates a repeated errorKind within one timeline", () => {
    const first = line({
      ts: T0,
      category: "http",
      op: "req.a",
      correlationId: "req-dup",
      errorKind: "TIMEOUT",
    });
    const second = line({
      ts: T1,
      category: "http",
      op: "req.b",
      correlationId: "req-dup",
      errorKind: "TIMEOUT",
    });

    const result = analyzeLogText(`${first}\n${second}\n`);

    expect(findTimeline(result, "req-dup")?.errorKinds).toEqual(["TIMEOUT"]);
  });

  it("falls back to a zero durationMs when the group's timestamps do not parse as dates", () => {
    const first = line({
      ts: "garbage-ts",
      category: "http",
      op: "req.a",
      correlationId: "req-garbage-ts",
    });
    const second = line({
      ts: "zzzzzzzz",
      category: "http",
      op: "req.b",
      correlationId: "req-garbage-ts",
    });

    const result = analyzeLogText(`${first}\n${second}\n`);

    expect(findTimeline(result, "req-garbage-ts")?.durationMs).toBe(0);
  });
});

describe("analyzeLogText — process lifetimes: first line is process.exiting", () => {
  it("omits exitReason and still summarises the lifetime when its only line is a reason-less process.exiting", () => {
    // The first (and here only) line seen for a lifetime is not always process.started — a
    // truncated/rotated log can open directly on a later lifecycle line. exitReasonOf must also
    // fall back to undefined when the `reason` field is absent, not just when it is the wrong type.
    const exitingFirst = line({
      ts: T0,
      category: "process",
      op: "process.exiting",
      pid: 6161,
      instanceId: "ffffffff",
      seq: 1,
    });

    const result = analyzeLogText(`${exitingFirst}\n`);

    expect(result.processes).toHaveLength(1);
    const summary = result.processes[0];
    expect(summary?.pid).toBe(6161);
    expect(summary?.started).toBeUndefined();
    expect(summary?.exitReason).toBeUndefined();
  });
});

describe("analyzeLogText — process lifetimes: out-of-order merge", () => {
  it("widens firstTs backward, leaves lastTs unchanged, updates started, and leaves exitReason unset on an out-of-order, reason-less merge", () => {
    // Three lines for one lifetime, processed in file order: a process.started (establishes the
    // lifetime), a SECOND process.started with an EARLIER ts and its own extra payload (must pull
    // firstTs backward, must NOT move lastTs, and must overwrite `started`), and a process.exiting
    // with no `reason` field (must leave exitReason unset even though the lifetime already exists).
    const startedFirst = line({
      ts: T1,
      category: "process",
      op: "process.started",
      pid: 5555,
      instanceId: "eeeeeeee",
      seq: 1,
      nodeVersion: "v1",
    });
    const startedAgainEarlier = line({
      ts: T0,
      category: "process",
      op: "process.started",
      pid: 5555,
      instanceId: "eeeeeeee",
      seq: 2,
      nodeVersion: "v2",
    });
    const exitingNoReason = line({
      ts: T2,
      category: "process",
      op: "process.exiting",
      pid: 5555,
      instanceId: "eeeeeeee",
      seq: 3,
    });

    const result = analyzeLogText(`${startedFirst}\n${startedAgainEarlier}\n${exitingNoReason}\n`);

    expect(result.processes).toHaveLength(1);
    const summary = result.processes[0];
    expect(summary?.lineCount).toBe(3);
    expect(summary?.firstSeq).toBe(1);
    expect(summary?.lastSeq).toBe(3);
    expect(summary?.firstTs).toBe(T0);
    expect(summary?.lastTs).toBe(T2);
    expect(summary?.started).toEqual({ nodeVersion: "v2" });
    expect(summary?.exitReason).toBeUndefined();
  });
});

describe("renderHumanTimeline — no lines", () => {
  it("renders only the header when a timeline has no lines", () => {
    const empty: LogTimeline = {
      correlationId: "req-empty",
      lines: [],
      firstTs: T0,
      lastTs: T0,
      durationMs: 0,
      errorKinds: [],
    };

    expect(renderHumanTimeline(empty)).toBe(`correlationId=req-empty lines=0 durationMs=0\n`);
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
    expect(
      renderHumanAllTimelines({
        timelines: [],
        malformedLineCount: 0,
        processes: [],
        legacyLineCount: 0,
        warnings: [],
      }),
    ).toBe("No correlated events found.\n");
  });
});
