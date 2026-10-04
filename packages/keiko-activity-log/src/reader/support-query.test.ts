import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSafeArtifactFile } from "@oscharko-dev/keiko-security/fs-hardening";
import {
  DEFAULT_SUPPORT_QUERY_LIMITS,
  renderSupportQuery,
  runSupportQuery,
  supportQueryJson,
  type SupportQueryLimits,
  type SupportQueryResult,
  type SupportQuerySelection,
} from "./support-query.js";
import {
  ActivityLogScanner,
  ensureSegmentManifests,
  listActivityLogStoreFiles,
  type ActivityLogStoreFile,
} from "./support-segment-scan.js";
import {
  SEGMENT_MANIFEST_SCHEMA_VERSION,
  type SegmentManifestSequenceAnomalies,
} from "./support-segment-manifest.js";
import {
  fixtureLine,
  fixtureProcess,
  segmentIdentity,
  writeFixtureSegment,
  type FixtureProcess,
} from "../../../../tests/support/activity-log-segments.js";

// A deterministic causal graph across two processes and several segments:
//
//   grandparent ─▶ parent ─▶ ROOT ─▶ child ─▶ grandchild     (the closure of ROOT)
//                     └─▶ sibling                             (a sibling: never selected)
//   unrelated, filler-*                                       (unrelated: never selected)
//
// plus uncorrelated process signals of both processes near the closure and far away from it.
const T0 = Date.UTC(2026, 8, 18, 12, 0, 0);
const IDS = {
  grandparent: "corr-grandparent-01",
  parent: "corr-parent-000001",
  root: "corr-root-00000001",
  child: "corr-child-0000001",
  grandchild: "corr-grandchild-01",
  sibling: "corr-sibling-00001",
  unrelated: "corr-unrelated-001",
  orphan: "corr-orphan-000001",
  missingParent: "corr-missing-parent",
} as const;

const DIAGNOSTIC = "client.diagnostic";
const SIGNAL = "cli.lifecycle.stop-requested";

interface GraphFixture {
  readonly stateDir: string;
  readonly fillerSegments: readonly string[];
}

function diagnostic(
  process: FixtureProcess,
  atMs: number,
  correlationId: string,
  parentCorrelationId?: string,
): string {
  return fixtureLine(process, atMs, { op: DIAGNOSTIC, correlationId, parentCorrelationId });
}

function signal(process: FixtureProcess, atMs: number): string {
  return fixtureLine(process, atMs, { op: SIGNAL });
}

function requestLine(
  process: FixtureProcess,
  correlationId: string,
  parentCorrelationId?: string,
  status = 200,
): string {
  return fixtureLine(process, T0 + 100, {
    op: "request",
    correlationId,
    parentCorrelationId,
    status,
    fields: {
      method: "GET",
      path: "/api/health",
      queryParamNames: [],
      responseBytes: 0,
      aborted: false,
    },
  });
}

function manualSelection(): SupportQuerySelection {
  return {
    kind: "closure",
    queryClass: "incident",
    roots: [],
    windows: [{ fromMs: T0, toMs: T0 + 1000 }],
    requiredClasses: { kind: "observed-failures" },
    unresolved: false,
  };
}

function writeGraph(stateDir: string): GraphFixture {
  const a = fixtureProcess(4101, "aaaaaaa1");
  const b = fixtureProcess(4202, "bbbbbbb2");
  writeFixtureSegment(stateDir, segmentIdentity(a, T0, 1), [
    signal(a, T0), // far before the closure: outside the context window
    diagnostic(a, T0 + 60_000, IDS.grandparent),
    diagnostic(a, T0 + 61_000, IDS.parent, IDS.grandparent),
    signal(a, T0 + 61_500), // inside the context window, before the closure
    diagnostic(a, T0 + 62_000, IDS.root, IDS.parent),
    diagnostic(a, T0 + 62_100, IDS.sibling, IDS.parent),
    diagnostic(a, T0 + 62_200, IDS.unrelated),
    diagnostic(a, T0 + 62_300, IDS.root, IDS.parent),
  ]);
  const fillerSegments: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const filler = fixtureProcess(5000 + index, `ccccccc${String(index)}`);
    const startMs = T0 + 100_000 + index * 1000;
    fillerSegments.push(
      writeFixtureSegment(stateDir, segmentIdentity(filler, startMs, 1), [
        diagnostic(filler, startMs, `corr-filler-${String(index).padStart(6, "0")}`),
        signal(filler, startMs + 1),
      ]),
    );
  }
  writeFixtureSegment(stateDir, segmentIdentity(b, T0 + 63_000, 1), [
    diagnostic(b, T0 + 63_000, IDS.child, IDS.root),
    signal(b, T0 + 63_100), // inside the context window, from a closure process
    diagnostic(b, T0 + 64_000, IDS.grandchild, IDS.child),
  ]);
  writeFixtureSegment(stateDir, segmentIdentity(b, T0 + 70_000, 2), [
    signal(b, T0 + 70_000), // after the closure: outside a 5 s context window
    diagnostic(b, T0 + 71_000, IDS.orphan, IDS.missingParent),
  ]);
  return { stateDir, fillerSegments: fillerSegments.map((path) => path.split("/").at(-1) ?? "") };
}

interface QueryRun {
  readonly result: SupportQueryResult;
  readonly opened: ReadonlySet<string>;
}

function query(
  stateDir: string,
  selection: SupportQuerySelection,
  limits: Partial<SupportQueryLimits> = {},
  openFile?: (file: ActivityLogStoreFile, stateDir: string) => number,
): QueryRun {
  const files = listActivityLogStoreFiles(stateDir);
  const pass = ensureSegmentManifests(stateDir, files, new ActivityLogScanner(stateDir), {
    trigger: "query",
    persist: true,
    rebuild: false,
  });
  const scanner = new ActivityLogScanner(stateDir, openFile === undefined ? {} : { openFile });
  const result = runSupportQuery({
    files,
    manifests: pass.manifests,
    manifestStats: pass.stats,
    scanner,
    selection,
    limits: { ...DEFAULT_SUPPORT_QUERY_LIMITS, ...limits },
  });
  return { result, opened: scanner.opened };
}

function correlationSelection(root: string): SupportQuerySelection {
  return {
    kind: "closure",
    queryClass: "correlation",
    roots: [root],
    windows: [],
    requiredClasses: { kind: "observed" },
    unresolved: false,
  };
}

function eventCorrelations(result: SupportQueryResult): ReadonlySet<string> {
  return new Set(
    result.events.flatMap((event) =>
      event.parsed.correlationId === undefined ? [] : [event.parsed.correlationId],
    ),
  );
}

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "keiko-support-query-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("support query causal closure (#3531)", () => {
  it("selects every reachable ancestor and descendant and no unrelated or sibling correlation", () => {
    writeGraph(stateDir);
    const { result } = query(stateDir, correlationSelection(IDS.root));

    expect(result.kind).toBe("keiko.support.query");
    expect(result.schemaVersion).toBe(1);
    expect(eventCorrelations(result)).toEqual(
      new Set([IDS.grandparent, IDS.parent, IDS.root, IDS.child, IDS.grandchild]),
    );
    expect(result.closure).toMatchObject({
      correlationCount: 5,
      rootCount: 1,
      ancestorCount: 2,
      descendantCount: 2,
      missingCorrelationCount: 0,
    });
    expect(result.closure?.edges).toEqual(
      [
        { parentCorrelationId: IDS.child, correlationId: IDS.grandchild },
        { parentCorrelationId: IDS.grandparent, correlationId: IDS.parent },
        { parentCorrelationId: IDS.parent, correlationId: IDS.root },
        { parentCorrelationId: IDS.root, correlationId: IDS.child },
      ].sort((left, right) =>
        `${left.parentCorrelationId}\u0000${left.correlationId}` <
        `${right.parentCorrelationId}\u0000${right.correlationId}`
          ? -1
          : 1,
      ),
    );
  });

  it("includes only closure-process signals inside the configured pre/post context window", () => {
    writeGraph(stateDir);
    const contextMs = 5000;
    const { result } = query(stateDir, correlationSelection(IDS.root), { contextMs });
    const closureTimes = result.events
      .filter((event) => event.role === "closure")
      .map((event) => Date.parse(event.parsed.view.ts));
    const from = Math.min(...closureTimes) - contextMs;
    const to = Math.max(...closureTimes) + contextMs;
    const context = result.events.filter((event) => event.role === "context");

    expect(context.map((event) => Date.parse(event.parsed.view.ts))).toEqual([
      T0 + 61_500,
      T0 + 63_100,
    ]);
    for (const event of result.events) {
      expect(["closure", "context"]).toContain(event.role);
      const ms = Date.parse(event.parsed.view.ts);
      expect(ms).toBeGreaterThanOrEqual(from);
      expect(ms).toBeLessThanOrEqual(to);
    }
    expect(context.every((event) => event.parsed.correlationId === undefined)).toBe(true);
  });

  it("orders events deterministically by logical-log position", () => {
    writeGraph(stateDir);
    const first = query(stateDir, correlationSelection(IDS.root)).result;
    const second = query(stateDir, correlationSelection(IDS.root)).result;
    const positions = first.events.map((event) => [event.file.order, event.index]);

    expect(positions).toEqual(
      [...positions].sort(
        (left, right) => (left[0] ?? 0) - (right[0] ?? 0) || (left[1] ?? 0) - (right[1] ?? 0),
      ),
    );
    // Only the manifest maintenance counters differ: the first run built, the second reused.
    const { segments: firstSegments, ...firstRest } = supportQueryJson(first) as Record<
      string,
      unknown
    >;
    const { segments: secondSegments, ...secondRest } = supportQueryJson(second) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(secondRest)).toBe(JSON.stringify(firstRest));
    expect(firstSegments).toMatchObject({ manifestsBuilt: 9, manifestsReused: 0 });
    expect(secondSegments).toMatchObject({ manifestsBuilt: 0, manifestsReused: 9 });
  });

  it("never opens a segment body its manifest prunes", () => {
    const fixture = writeGraph(stateDir);
    const { result, opened } = query(stateDir, correlationSelection(IDS.root));

    for (const filler of fixture.fillerSegments) expect(opened.has(filler)).toBe(false);
    expect(result.segments.pruned).toBeGreaterThanOrEqual(fixture.fillerSegments.length);
    expect(result.segments.candidate + result.segments.pruned).toBe(result.segments.total);
  });

  it("declares a missing ancestor as parent-correlation-missing", () => {
    writeGraph(stateDir);
    const { result } = query(stateDir, correlationSelection(IDS.orphan));

    expect(result.closure?.missingCorrelationCount).toBe(1);
    expect(result.diagnosticSufficiency.status).toBe("insufficient");
    expect(result.diagnosticSufficiency.reasons).toContain("parent-correlation-missing");
  });

  it("returns insufficient with evidence-not-retained when the log holds nothing for the root", () => {
    writeGraph(stateDir);
    const { result } = query(stateDir, correlationSelection("corr-never-logged-01"));

    expect(result.events).toEqual([]);
    expect(result.diagnosticSufficiency).toMatchObject({
      status: "insufficient",
      reasons: ["evidence-not-retained"],
    });
  });

  it("returns no events and report-budget-exceeded instead of a partial closure", () => {
    writeGraph(stateDir);
    const { result } = query(stateDir, correlationSelection(IDS.root), { maxResultBytes: 1500 });

    expect(result.events).toEqual([]);
    expect(result.truncation.state).toBe("budget-exceeded");
    expect(result.truncation.requiredBytes).toBeGreaterThan(1500);
    expect(result.diagnosticSufficiency).toMatchObject({
      status: "insufficient",
      reasons: ["report-budget-exceeded"],
    });
  });

  // Regression (review 4050607039): a closure that fully resolved and streamed every one of its
  // correlations, but whose event bodies exceeded --max-bytes, must keep reporting the real closure
  // it found — not "nothing observed", which is indistinguishable from genuine evidence loss
  // (`parent-correlation-missing` / `evidence-not-retained`).
  it("keeps the real closure and candidate metrics when the resolved closure exceeds the byte budget", () => {
    writeGraph(stateDir);
    const full = query(stateDir, correlationSelection(IDS.root)).result;
    const { result } = query(stateDir, correlationSelection(IDS.root), { maxResultBytes: 1500 });

    expect(result.events).toEqual([]);
    expect(result.truncation.state).toBe("budget-exceeded");
    expect(result.diagnosticSufficiency).toMatchObject({
      status: "insufficient",
      reasons: ["report-budget-exceeded"],
    });
    // Same closure the unbounded run found: every member was actually observed while streaming.
    expect(result.closure).toMatchObject({
      correlationCount: full.closure?.correlationCount,
      rootCount: full.closure?.rootCount,
      ancestorCount: full.closure?.ancestorCount,
      descendantCount: full.closure?.descendantCount,
      missingCorrelationCount: 0,
    });
    expect(result.closure?.edges).toEqual(full.closure?.edges);
    // The sibling path (runEventSelection) always preserves collector.candidateCount; the closure
    // path must too, instead of hardcoding 0.
    expect(result.metrics.candidateEventCount).toBeGreaterThan(0);
  });

  it("returns report-budget-exceeded when the closure exceeds the correlation bound", () => {
    writeGraph(stateDir);
    const { result } = query(stateDir, correlationSelection(IDS.root), {
      maxClosureCorrelations: 3,
    });

    expect(result.events).toEqual([]);
    expect(result.diagnosticSufficiency.reasons).toEqual(["report-budget-exceeded"]);
  });

  it("drops only optional context to fit and declares it as context-truncated", () => {
    writeGraph(stateDir);
    const { result } = query(stateDir, correlationSelection(IDS.root), { maxContextEvents: 1 });

    expect(result.truncation).toMatchObject({
      state: "context-truncated",
      omittedContextEventCount: 1,
    });
    expect(result.diagnosticSufficiency.reasons).toContain("context-truncated");
    expect(result.metrics.closureEventCount).toBe(6);
  });

  it("declares an unreadable candidate segment instead of omitting it silently", () => {
    writeGraph(stateDir);
    const { result } = query(stateDir, correlationSelection(IDS.root), {}, (file, root) => {
      if (file.name.includes("-4202-")) throw new Error("simulated unreadable segment");
      return openSafeArtifactFile(file.path, {
        artifactClass: "activity-log",
        mode: "read",
        trustedRoot: root,
      });
    });

    expect(result.segments.unreadable).toBeGreaterThan(0);
    expect(result.diagnosticSufficiency.status).toBe("insufficient");
    expect(result.diagnosticSufficiency.reasons).toContain("segment-unreadable");
  });

  // Review #3679: a long-running process's start names its runtime; it stays in the closure's
  // context however far before the failure it lies, even without any context window.
  it("keeps each closure lifetime's process start wherever it lies", () => {
    const a = fixtureProcess(4101, "aaaaaaa1");
    writeFixtureSegment(stateDir, segmentIdentity(a, T0, 1), [
      fixtureLine(a, T0, { op: "process.started" }),
      signal(a, T0 + 60_000),
      diagnostic(a, T0 + 600_000, IDS.root),
    ]);
    for (const contextMs of [DEFAULT_SUPPORT_QUERY_LIMITS.contextMs, 0]) {
      const { result } = query(stateDir, correlationSelection(IDS.root), { contextMs });
      const context = result.events.filter((event) => event.role === "context");
      expect(context.map((event) => event.parsed.view.op)).toEqual(["process.started"]);
      expect(context[0]?.parsed.view.extra).toMatchObject({ nodeVersion: "v24.18.0" });
      expect(result.truncation.state).toBe("none");
    }
  });

  // Review #3679: the runtime anchor is required evidence. It never consumes the optional context
  // cap, and a budget that cannot hold it beside the closure states the bytes both need.
  it("never counts a lifetime anchor against the optional context cap", () => {
    const a = fixtureProcess(4101, "aaaaaaa1");
    writeFixtureSegment(stateDir, segmentIdentity(a, T0, 1), [
      fixtureLine(a, T0, { op: "process.started" }),
      signal(a, T0 + 600_000),
      diagnostic(a, T0 + 600_001, IDS.root),
    ]);
    const { result } = query(stateDir, correlationSelection(IDS.root), { maxContextEvents: 1 });
    expect(
      result.events
        .filter((event) => event.role === "context")
        .map((event) => event.parsed.view.op),
    ).toEqual(["process.started", SIGNAL]);
    expect(result.truncation.state).toBe("none");
    expect(result.diagnosticSufficiency.reasons).not.toContain("context-truncated");
  });

  // Review #3679: the requirement names the closure and its anchors on both sides of the budget,
  // including when the closure alone already overflows it, so the stated size is one that fits.
  it("states the closure and anchor bytes when the budget cannot hold the runtime", () => {
    const a = fixtureProcess(4101, "aaaaaaa1");
    const start = fixtureLine(a, T0, { op: "process.started" });
    const failure = diagnostic(a, T0 + 600_000, IDS.root);
    writeFixtureSegment(stateDir, segmentIdentity(a, T0, 1), [start, failure]);
    const closureBytes = Buffer.byteLength(failure) + 1;
    const bothBytes = closureBytes + Buffer.byteLength(start) + 1;
    for (const maxResultBytes of [closureBytes - 1, closureBytes, bothBytes - 1]) {
      const { result } = query(stateDir, correlationSelection(IDS.root), {
        contextMs: 0,
        maxResultBytes,
      });
      expect(result.events).toEqual([]);
      expect(result.diagnosticSufficiency.status).toBe("insufficient");
      expect(result.diagnosticSufficiency.reasons).toContain("report-budget-exceeded");
      expect(result.truncation).toMatchObject({
        state: "budget-exceeded",
        requiredBytes: bothBytes,
      });
    }
    const { result } = query(stateDir, correlationSelection(IDS.root), {
      contextMs: 0,
      maxResultBytes: bothBytes,
    });
    expect(result.diagnosticSufficiency.status).toBe("complete");
    expect(result.metrics.selectedBytes).toBe(bothBytes);
  });

  // Review #3679: only `keiko ui` writes a start, and retention prunes a lifetime's oldest segment
  // first. A start that went with the first segment is stated whether or not a heartbeat followed it,
  // and a retained heartbeat travels as the proof a receiver recomputes the loss from.
  it.each([
    ["after its first heartbeat", true],
    ["before its first heartbeat", false],
  ])("states a lifetime start that retention removed %s", (_label, heartbeats) => {
    const a = fixtureProcess(4101, "aaaaaaa1");
    const startup = writeFixtureSegment(stateDir, segmentIdentity(a, T0, 1), [
      fixtureLine(a, T0, { op: "process.started" }),
      ...(heartbeats ? [fixtureLine(a, T0 + 60_000, { op: "process.heartbeat" })] : []),
    ]);
    const later = heartbeats
      ? [fixtureLine(a, T0 + 120_000, { op: "process.heartbeat" })]
      : [diagnostic(a, T0 + 120_000, IDS.unrelated)];
    const failure = diagnostic(a, T0 + 600_000, IDS.root);
    writeFixtureSegment(stateDir, segmentIdentity(a, T0 + 120_000, 2), [...later, failure]);
    const retained = query(stateDir, correlationSelection(IDS.root), { contextMs: 0 }).result;
    expect(retained.diagnosticSufficiency.status).toBe("complete");
    expect(retained.events.map((event) => event.parsed.view.op)).toEqual([
      "process.started",
      DIAGNOSTIC,
    ]);

    rmSync(startup);
    const { result } = query(stateDir, correlationSelection(IDS.root), { contextMs: 0 });
    expect(result.diagnosticSufficiency.status).toBe("insufficient");
    expect(result.diagnosticSufficiency.reasons).toContain("evidence-not-retained");
    const required = heartbeats ? [...later, failure] : [failure];
    expect(result.events.map((event) => event.text)).toEqual(required);
    const overflow = query(stateDir, correlationSelection(IDS.root), {
      contextMs: 0,
      maxResultBytes: Buffer.byteLength(failure),
    }).result;
    expect(overflow.truncation).toMatchObject({
      state: "budget-exceeded",
      requiredBytes: required.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0),
    });
  });

  // A one-shot command writes no start (its fatal and exit lines come without one). With all of its
  // segments retained from the first, it never wrote one, so nothing is missing; the first line of
  // its first segment travels along so a receiver can see that beginning too.
  it("never asks a start of a lifetime whose segments run unbroken from its first", () => {
    const a = fixtureProcess(4101, "aaaaaaa1");
    const beginning = signal(a, T0);
    writeFixtureSegment(stateDir, segmentIdentity(a, T0, 1), [beginning]);
    const later = signal(a, T0 + 1);
    const failure = diagnostic(a, T0 + 2, IDS.root);
    writeFixtureSegment(stateDir, segmentIdentity(a, T0 + 1, 2), [later, failure]);
    const { result } = query(stateDir, correlationSelection(IDS.root), { contextMs: 0 });
    expect(result.diagnosticSufficiency.status).toBe("complete");
    expect(result.diagnosticSufficiency.reasons).toEqual([]);
    expect(result.events.map((event) => event.text)).toEqual([beginning, failure]);
  });

  // Review #3679: a segment name proves nothing when its contents are unusable. A damaged line in
  // a start-less lifetime's segments could be the start itself, so its beginning is not proven.
  it.each([
    ["a corrupt start", (line: string): string => line.replace('"v24.18.0"', "24")],
    [
      "an incomplete start",
      (line: string): string => line.replace(',"nodeVersion":"v24.18.0"', ""),
    ],
  ])("states a missing start behind %s in the first segment", (_label, damage) => {
    const a = fixtureProcess(4101, "aaaaaaa1");
    const start = fixtureLine(a, T0, { op: "process.started" });
    expect(damage(start)).not.toBe(start);
    writeFixtureSegment(stateDir, segmentIdentity(a, T0, 1), [damage(start)]);
    writeFixtureSegment(stateDir, segmentIdentity(a, T0 + 600_000, 2), [
      diagnostic(a, T0 + 600_000, IDS.root),
    ]);
    const { result } = query(stateDir, correlationSelection(IDS.root), { contextMs: 0 });
    expect(result.diagnosticSufficiency.status).toBe("insufficient");
    expect(result.diagnosticSufficiency.reasons).toContain("evidence-not-retained");
  });

  // Review #3679: an unsupported line, or an event the process recorded losing, in a start-less
  // lifetime's segments could be its start, so neither leaves the beginning proven. A seal's confirmed
  // drop counts before any loss summary is written, even when the rejected event's claimed seq went
  // to the sink's own line and no gap remains.
  it.each([
    [
      "an unsupported start",
      (a: FixtureProcess): readonly string[] => [
        fixtureLine(a, T0 + 1, { op: "process.started" }).replace(
          '"schemaVersion":2',
          '"schemaVersion":3',
        ),
      ],
    ],
    [
      "a recorded loss",
      (a: FixtureProcess): readonly string[] => [
        fixtureLine(a, T0 + 1, {
          op: "activity-log.loss",
          fields: {
            completeness: "partial",
            loss: "event-dropped",
            trigger: "heartbeat",
            totalLost: 1,
            schemaRejected: 1,
          },
        }),
      ],
    ],
    [
      "a seal's confirmed drop",
      (a: FixtureProcess): readonly string[] => {
        const before = signal(a, T0 + 1);
        const seal = fixtureLine(a, T0 + 2, {
          op: "activity-log.segment.sealed",
          correlationId: "unknown-correlation-id",
          fields: {
            completeness: "partial",
            loss: "event-dropped",
            sealReason: "close",
            segmentIndex: 2,
            segmentFirstSeq: 2,
            segmentLastSeq: 3,
            segmentLineCount: 2,
            segmentBytes: 512,
            segmentDurationMs: 1,
            droppedEventCount: 1,
            segmentByteLimit: 1_048_576,
            segmentSecondsLimit: 3600,
          },
        });
        return [before, seal];
      },
    ],
  ])("states a missing start behind %s in its beginning", (_label, damaged) => {
    const a = fixtureProcess(4101, "aaaaaaa1");
    writeFixtureSegment(stateDir, segmentIdentity(a, T0, 1), [signal(a, T0)]);
    writeFixtureSegment(stateDir, segmentIdentity(a, T0 + 1, 2), damaged(a));
    writeFixtureSegment(stateDir, segmentIdentity(a, T0 + 600_000, 3), [
      diagnostic(a, T0 + 600_000, IDS.root),
    ]);
    const { result } = query(stateDir, correlationSelection(IDS.root), { contextMs: 0 });
    expect(result.diagnosticSufficiency.status).toBe("insufficient");
    expect(result.diagnosticSufficiency.reasons).toContain("evidence-not-retained");
    expect(result.lifetimes).toEqual([{ pid: 4101, instanceId: "aaaaaaa1", start: "lost" }]);
  });

  // Review #3679: only the process losing its own evidence leaves a start unaccounted for. A summary
  // that lost nothing, or counted only browser reports the server refused, loses no line of it.
  it.each([
    ["nothing lost", { totalLost: 0 }],
    ["a refused browser report", { totalLost: 1, clientRejected: 1 }],
    ["a failed browser post", { totalLost: 1, clientPostFailed: 1 }],
  ])("keeps a beginning proven beside a loss summary of %s", (_label, counters) => {
    const a = fixtureProcess(4101, "aaaaaaa1");
    writeFixtureSegment(stateDir, segmentIdentity(a, T0, 1), [
      signal(a, T0),
      fixtureLine(a, T0 + 1, {
        op: "activity-log.loss",
        fields: { trigger: "exit", ...counters },
      }),
    ]);
    writeFixtureSegment(stateDir, segmentIdentity(a, T0 + 600_000, 2), [
      diagnostic(a, T0 + 600_000, IDS.root),
    ]);
    const { result } = query(stateDir, correlationSelection(IDS.root), { contextMs: 0 });
    expect(result.diagnosticSufficiency.status).toBe("complete");
    expect(result.lifetimes).toEqual([{ pid: 4101, instanceId: "aaaaaaa1", start: "absent" }]);
  });

  // Review #3679: proving a long start-less lifetime lossless reads only the segments whose manifests
  // could record a loss (a loss summary, a sequence break); every other body stays unopened.
  it("proves a start-less beginning without opening a segment that cannot record a loss", () => {
    const a = fixtureProcess(4101, "aaaaaaa1");
    writeFixtureSegment(stateDir, segmentIdentity(a, T0, 1), [diagnostic(a, T0, IDS.root)]);
    const quiet = writeFixtureSegment(stateDir, segmentIdentity(a, T0 + 1, 2), [signal(a, T0 + 1)]);
    writeFixtureSegment(stateDir, segmentIdentity(a, T0 + 2, 3), [
      diagnostic(a, T0 + 600_000, IDS.root),
    ]);
    const { result, opened } = query(stateDir, correlationSelection(IDS.root), { contextMs: 0 });
    expect(result.diagnosticSufficiency.status).toBe("complete");
    expect(result.lifetimes).toEqual([{ pid: 4101, instanceId: "aaaaaaa1", start: "absent" }]);
    expect([...opened]).not.toContain(quiet.split("/").at(-1));
  });

  // Review #3679: a torn tail ends only a lifetime's last segment, where a crash stops it; a torn
  // first segment followed by another cannot prove that its beginning held no start.
  it("states a missing start behind a torn first segment", () => {
    const a = fixtureProcess(4101, "aaaaaaa1");
    const torn = '{"ts":"2026-09-18T12:00:00.000Z","op":"process.st';
    writeFixtureSegment(stateDir, segmentIdentity(a, T0, 1), [signal(a, T0)], { tail: torn });
    writeFixtureSegment(stateDir, segmentIdentity(a, T0 + 600_000, 2), [
      diagnostic(a, T0 + 600_000, IDS.root),
    ]);
    const { result } = query(stateDir, correlationSelection(IDS.root), { contextMs: 0 });
    expect(result.diagnosticSufficiency.status).toBe("insufficient");
    expect(result.diagnosticSufficiency.reasons).toContain("evidence-not-retained");
  });

  // A lifetime whose segments no longer run unbroken from its first may have lost its start with the
  // missing segment, so the start is unaccounted for even though the first segment survived.
  it("states a missing start when a lifetime's segments no longer run unbroken", () => {
    const a = fixtureProcess(4101, "aaaaaaa1");
    writeFixtureSegment(stateDir, segmentIdentity(a, T0, 1), [signal(a, T0)]);
    const gap = writeFixtureSegment(stateDir, segmentIdentity(a, T0 + 1, 2), [signal(a, T0 + 1)]);
    writeFixtureSegment(stateDir, segmentIdentity(a, T0 + 2, 3), [diagnostic(a, T0 + 2, IDS.root)]);
    expect(
      query(stateDir, correlationSelection(IDS.root)).result.diagnosticSufficiency.status,
    ).toBe("complete");
    rmSync(gap);
    const { result } = query(stateDir, correlationSelection(IDS.root));
    expect(result.diagnosticSufficiency.status).toBe("insufficient");
    expect(result.diagnosticSufficiency.reasons).toContain("evidence-not-retained");
  });

  // Review #3679: the lifetimes whose starts are measured are bounded like the closure itself.
  it("never partially selects a closure whose lifetimes exceed the closure bound", () => {
    const processes = [
      fixtureProcess(4101, "aaaaaaa1"),
      fixtureProcess(4202, "bbbbbbb2"),
      fixtureProcess(4303, "ccccccc3"),
    ];
    for (const [index, process] of processes.entries()) {
      writeFixtureSegment(stateDir, segmentIdentity(process, T0 + index, 1), [
        diagnostic(process, T0 + index, IDS.root),
      ]);
    }
    const { result } = query(stateDir, correlationSelection(IDS.root), {
      maxClosureCorrelations: 1,
    });
    expect(result.events).toEqual([]);
    expect(result.diagnosticSufficiency.reasons).toContain("report-budget-exceeded");
    expect(result.truncation).toMatchObject({ state: "budget-exceeded", requiredBytes: 0 });
    expect(result.closure).toMatchObject({ correlationCount: 1, missingCorrelationCount: 0 });
    expect(
      query(stateDir, correlationSelection(IDS.root), { maxClosureCorrelations: 3 }).result
        .diagnosticSufficiency.status,
    ).toBe("complete");
  });

  // #3534: a crashed writer's torn tail is truncated evidence, never a corrupt record, and the
  // fragment never becomes a selected event.
  it("declares a torn segment tail as truncated evidence and never selects the fragment", () => {
    const a = fixtureProcess(4101, "aaaaaaa1");
    writeFixtureSegment(
      stateDir,
      segmentIdentity(a, T0, 1),
      [diagnostic(a, T0, IDS.root), diagnostic(a, T0 + 100, IDS.root)],
      { state: "active", tail: '{"ts":"2026-09-18T12:00:01.000Z","op":"client.d' },
    );
    const { result } = query(stateDir, correlationSelection(IDS.root));

    expect(result.integrity).toMatchObject({ truncatedLineCount: 1, corruptLineCount: 0 });
    expect(result.diagnosticSufficiency.reasons).toContain("truncated-evidence");
    expect(result.diagnosticSufficiency.reasons).not.toContain("corrupt-evidence");
    // A crash tears only the last segment of a lifetime, so its beginning still holds (review #3679).
    expect(result.diagnosticSufficiency).toMatchObject({ status: "degraded" });
    expect(result.diagnosticSufficiency.reasons).not.toContain("evidence-not-retained");
    expect(result.events.map((event) => event.parsed.correlationId)).toEqual([IDS.root, IDS.root]);
  });

  it("keeps useful manual evidence despite more than 8036 independent successful requests", () => {
    const process = fixtureProcess(4101, "aaaaaaa1");
    const noise = Array.from({ length: 8100 }, (_, index) =>
      requestLine(process, `routine-request-${String(index)}`),
    );
    writeFixtureSegment(stateDir, segmentIdentity(process, T0, 1), [
      ...noise,
      diagnostic(process, T0 + 101, IDS.root),
      requestLine(process, "causal-request", IDS.root),
      requestLine(process, "failed-request", undefined, 500),
      fixtureLine(process, T0 + 102, {
        op: "search.connected-context.completed",
        correlationId: IDS.child,
        parentCorrelationId: IDS.root,
        fields: {
          scopeIdentitySha256: "a".repeat(64),
          queryIdentitySha256: "b".repeat(64),
          activityDetailStatus: "complete",
        },
      }),
    ]);
    const { result } = query(stateDir, manualSelection());
    expect(DEFAULT_SUPPORT_QUERY_LIMITS.maxClosureCorrelations).toBe(4096);
    expect(result.truncation.state).not.toBe("budget-exceeded");
    expect(result.events.length).toBeGreaterThan(4);
    expect(result.events.length).toBeLessThanOrEqual(261);
    for (const id of [IDS.root, IDS.child, "causal-request", "failed-request"])
      expect(eventCorrelations(result).has(id)).toBe(true);
    expect(result.truncation.omittedContextEventCount).toBeGreaterThan(7800);
    expect(result.diagnosticSufficiency.reasons).toContain("context-truncated");
  });

  it("still rejects an explicit causal closure exceeding 4096 request children", () => {
    const process = fixtureProcess(4101, "aaaaaaa1");
    writeFixtureSegment(stateDir, segmentIdentity(process, T0, 1), [
      diagnostic(process, T0, IDS.root),
      ...Array.from({ length: 4100 }, (_, index) =>
        requestLine(process, `causal-request-${String(index)}`, IDS.root),
      ),
    ]);
    const { result } = query(stateDir, correlationSelection(IDS.root));
    expect(result.events).toEqual([]);
    expect(result.diagnosticSufficiency.reasons).toContain("report-budget-exceeded");
  });

  it.each([
    { status: 500 },
    { status: 200, level: "warn" as const },
    { status: 200, level: "error" as const },
    { status: 200, errorKind: "internal" as const },
    { status: 200, fields: { aborted: true } },
    { status: undefined },
  ])("keeps failed or uncertain HTTP transport mandatory: %j", (overrides) => {
    const process = fixtureProcess(4101, "aaaaaaa1");
    writeFixtureSegment(stateDir, segmentIdentity(process, T0, 1), [
      fixtureLine(process, T0 + 100, {
        op: "request",
        correlationId: "important-transport",
        ...overrides,
        fields: {
          method: "GET",
          path: "/api/health",
          queryParamNames: [],
          responseBytes: 0,
          aborted: false,
          ...overrides.fields,
        },
      }),
    ]);
    const { result } = query(stateDir, manualSelection());
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.role).toBe("closure");
  });

  it("keeps successful transport ancestors of a selected failure mandatory", () => {
    const process = fixtureProcess(4101, "aaaaaaa1");
    writeFixtureSegment(stateDir, segmentIdentity(process, T0, 1), [
      requestLine(process, IDS.parent),
      diagnostic(process, T0 + 101, IDS.root, IDS.parent),
    ]);
    const { result } = query(stateDir, manualSelection());
    expect(result.events.map((event) => event.role)).toEqual(["closure", "closure"]);
    expect(eventCorrelations(result)).toEqual(new Set([IDS.parent, IDS.root]));
  });

  it("keeps a linked successful request and its outside-window ancestor mandatory", () => {
    const process = fixtureProcess(4101, "aaaaaaa1");
    writeFixtureSegment(stateDir, segmentIdentity(process, T0, 1), [
      diagnostic(process, T0 - 1000, IDS.parent),
      requestLine(process, IDS.root, IDS.parent),
    ]);
    const { result } = query(stateDir, manualSelection());
    expect(result.events.map((event) => event.role)).toEqual(["closure", "closure"]);
    expect(eventCorrelations(result)).toEqual(new Set([IDS.parent, IDS.root]));
  });

  it("keeps a retained beginning beside historical pin protection failure", () => {
    const process = fixtureProcess(4101, "aaaaaaa1");
    writeFixtureSegment(stateDir, segmentIdentity(process, T0, 1), [
      signal(process, T0),
      fixtureLine(process, T0 + 1, {
        op: "activity-log.pin.created",
        correlationId: IDS.root,
        fields: {
          pinStatus: "created",
          pinKind: "window",
          pinReason: "incident",
          pinnedSegmentCount: 1,
          pinnedBytes: 512,
          expiresInSeconds: 3600,
          quotaStatus: "exceeded",
          completeness: "partial",
        },
      }),
      fixtureLine(process, T0 + 2, {
        op: "activity-log.pin.quota-exhausted",
        correlationId: IDS.root,
        fields: {
          pinQuotaBytes: 1,
          requestedPinnedBytes: 512,
          protectedPinnedBytes: 0,
          protectedSegmentCount: 0,
          unprotectedSegmentCount: 1,
          unprotectedBytes: 512,
          unprotectedSeqSpan: 1,
          unknownSpanSegmentCount: 0,
          activePinCount: 1,
          completeness: "partial",
          loss: "event-dropped",
        },
      }),
    ]);
    const { result } = query(stateDir, correlationSelection(IDS.root), { contextMs: 0 });
    expect(result.lifetimes).toEqual([
      { pid: process.pid, instanceId: process.instanceId, start: "absent" },
    ]);
    expect(result.diagnosticSufficiency).toMatchObject({
      status: "degraded",
      reasons: ["evidence-partial"],
    });
  });

  it("selects a user-reported window and the closure of every diagnostic correlation inside it", () => {
    writeGraph(stateDir);
    const files = listActivityLogStoreFiles(stateDir);
    const firstSegment = files.find((file) => file.name.includes("-4101-"));
    const { result } = query(stateDir, {
      kind: "closure",
      queryClass: "incident",
      roots: [],
      windows: [
        {
          fromMs: T0 + 62_050,
          toMs: T0 + 62_150,
          segmentIds: new Set([firstSegment?.segmentId ?? ""]),
        },
      ],
      requiredClasses: { kind: "observed-failures" },
      unresolved: false,
    });

    // The window holds only the sibling line: its closure is sibling + parent + grandparent.
    expect(eventCorrelations(result)).toEqual(new Set([IDS.sibling, IDS.parent, IDS.grandparent]));
    expect(result.closure?.rootCount).toBe(1);
  });

  it("reports an unresolved incident as insufficient evidence-not-retained", () => {
    writeGraph(stateDir);
    const { result } = query(stateDir, {
      kind: "closure",
      queryClass: "incident",
      roots: [],
      windows: [],
      requiredClasses: { kind: "observed" },
      unresolved: true,
    });

    expect(result.diagnosticSufficiency).toMatchObject({
      status: "insufficient",
      reasons: ["evidence-not-retained"],
    });
  });
});

describe("support query event filters (#3531)", () => {
  it("streams events by operation and prunes segments whose manifest lacks it", () => {
    writeGraph(stateDir);
    const { result } = query(stateDir, {
      kind: "events",
      queryClass: "operation",
      filter: { op: SIGNAL },
    });

    expect(result.events).toHaveLength(10);
    expect(result.events.every((event) => event.parsed.view.op === SIGNAL)).toBe(true);
    expect(result.events.every((event) => event.role === "match")).toBe(true);
  });

  it("combines a parent correlation and a bounded time window with AND", () => {
    writeGraph(stateDir);
    const { result, opened } = query(stateDir, {
      kind: "events",
      queryClass: "parent-correlation",
      filter: { parentCorrelationId: IDS.parent, fromMs: T0 + 62_050, toMs: T0 + 70_000 },
    });

    expect(eventCorrelations(result)).toEqual(new Set([IDS.sibling, IDS.root]));
    expect(result.events.map((event) => Date.parse(event.parsed.view.ts))).toEqual([
      T0 + 62_100,
      T0 + 62_300,
    ]);
    expect([...opened].every((name) => name.includes("-4101-"))).toBe(true);
  });

  it("matches by error kind and failure class through the registry", () => {
    const a = fixtureProcess(4101, "aaaaaaa1");
    writeFixtureSegment(stateDir, segmentIdentity(a, T0, 1), [
      fixtureLine(a, T0, {
        op: DIAGNOSTIC,
        correlationId: IDS.root,
        level: "error",
        errorKind: "timeout",
      }),
      fixtureLine(a, T0 + 1, { op: DIAGNOSTIC, correlationId: IDS.child }),
      fixtureLine(a, T0 + 2, { op: SIGNAL }),
    ]);
    const byKind = query(stateDir, {
      kind: "events",
      queryClass: "error-kind",
      filter: { errorKind: "timeout" },
    }).result;
    const byClass = query(stateDir, {
      kind: "events",
      queryClass: "failure-class",
      filter: { failureClass: "client-diagnostic" },
    }).result;

    expect(byKind.events.map((event) => event.parsed.correlationId)).toEqual([IDS.root]);
    expect(byClass.events.map((event) => event.parsed.correlationId)).toEqual([
      IDS.root,
      IDS.child,
    ]);
  });

  it("reports an empty match as insufficient no-registered-evidence", () => {
    writeGraph(stateDir);
    const { result } = query(stateDir, {
      kind: "events",
      queryClass: "time-window",
      filter: { fromMs: T0 - 10_000, toMs: T0 - 1 },
    });

    expect(result.events).toEqual([]);
    expect(result.diagnosticSufficiency.reasons).toEqual(["no-registered-evidence"]);
  });
});

describe("support query result projections (#3531)", () => {
  it("states provenance, integrity, coverage, loss, truncation and exactly one status", () => {
    writeGraph(stateDir);
    const { result } = query(stateDir, correlationSelection(IDS.root));

    expect(result.provenance).toMatchObject({
      manifestSchemaVersion: SEGMENT_MANIFEST_SCHEMA_VERSION,
    });
    expect(result.integrity).toMatchObject({
      classification: "supported",
      completeness: "complete",
      loss: "none",
    });
    expect(["complete", "degraded", "insufficient"]).toContain(result.diagnosticSufficiency.status);
    expect(result.coverage.presentClassCount).toBeGreaterThan(0);
    expect(result.loss).toEqual({ state: "none", lossEventCount: 0 });
    expect(result.truncation.state).toBe("none");
  });

  it("derives the human report from the machine result", () => {
    writeGraph(stateDir);
    const { result } = query(stateDir, correlationSelection(IDS.root));
    const human = renderSupportQuery(result);

    expect(human).toContain(`Diagnostic sufficiency: ${result.diagnosticSufficiency.status}`);
    expect(human).toContain(`Closure: ${String(result.closure?.correlationCount)} correlation(s)`);
    expect(human.trimEnd().split("\n")).toHaveLength(6 + result.events.length);
  });

  it("emits each event as its persisted record and never an absolute path", () => {
    writeGraph(stateDir);
    const { result } = query(stateDir, correlationSelection(IDS.root));
    const json = JSON.stringify(supportQueryJson(result));

    expect(json).not.toContain(stateDir);
    const parsed = JSON.parse(json) as { events: { record: { op: string } }[] };
    expect(parsed.events.map((event) => event.record.op)).toEqual(
      result.events.map((event) => event.parsed.view.op),
    );
  });
});

// Audit (#3531): a segment manifest is self-contained by construction (rebuildable from its own
// sealed segment alone), so a duplicate/decreasing/reset `seq` for one (pid, instanceId) that lands
// exactly across two segments — the segment that observed the process last ends, the next one that
// continues its lifetime begins — was invisible to both manifests and to every query aggregate: each
// manifest's own `sequenceAnomalies` only ever sees its own segment. A gap at a boundary stays
// tolerated, exactly as within one segment's own scan.
describe("support query sequence anomalies at a segment boundary (#3531 audit)", () => {
  const BOUNDARY_T0 = Date.UTC(2026, 8, 19, 9, 0, 0);
  const eventFilter: SupportQuerySelection = {
    kind: "events",
    queryClass: "operation",
    filter: { op: DIAGNOSTIC },
  };

  // Writes one process's first segment (seq 1..3, via three real lines) and lets the caller mutate
  // the fixture's own seq counter before the second segment's first line — exactly how a real
  // writer's counter would misbehave (a crash-and-restart reset, a corrupted counter going
  // backwards, or two writers sharing an identity) without needing a second, made-up process.
  function writeBoundaryFixture(
    boundaryStateDir: string,
    beforeSecondSegment: (process: FixtureProcess) => void,
  ): FixtureProcess {
    const process = fixtureProcess(9301, "b0ad0001");
    writeFixtureSegment(boundaryStateDir, segmentIdentity(process, BOUNDARY_T0, 1), [
      diagnostic(process, BOUNDARY_T0, "corr-boundary-01"),
      diagnostic(process, BOUNDARY_T0 + 1, "corr-boundary-02"),
      diagnostic(process, BOUNDARY_T0 + 2, "corr-boundary-03"),
    ]);
    beforeSecondSegment(process);
    writeFixtureSegment(boundaryStateDir, segmentIdentity(process, BOUNDARY_T0 + 10_000, 2), [
      diagnostic(process, BOUNDARY_T0 + 10_000, "corr-boundary-04"),
      diagnostic(process, BOUNDARY_T0 + 10_001, "corr-boundary-05"),
    ]);
    return process;
  }

  function segmentManifestEvidence(
    boundaryStateDir: string,
    segmentIndex: 1 | 2,
  ): SegmentManifestSequenceAnomalies {
    const files = listActivityLogStoreFiles(boundaryStateDir);
    const pass = ensureSegmentManifests(
      boundaryStateDir,
      files,
      new ActivityLogScanner(boundaryStateDir),
      { trigger: "query", persist: false, rebuild: false },
    );
    // Segment 1 is written first, so it is the store's first (order 0) file; segment 2 the second.
    const target = files.find((entry) => entry.order === segmentIndex - 1);
    const manifest = target === undefined ? undefined : pass.manifests.get(target.name)?.manifest;
    if (manifest === undefined) throw new Error("expected a manifest for the fixture segment");
    return manifest.evidence.sequenceAnomalies;
  }

  function sumAnomalies(anomalies: SegmentManifestSequenceAnomalies): number {
    return anomalies.gap + anomalies.duplicate + anomalies.decreasing + anomalies.reset;
  }

  // A segment's OWN manifest builder always starts from `previous: 0` (it never knows what the
  // prior segment last saw), so a second segment's first real line almost always looks like a
  // "gap" from `previous` — even on a perfectly healthy handoff. That per-segment gap is pre-existing,
  // tolerated behavior (unaffected by this audit's fix) and every test below accounts for it
  // explicitly, so the boundary-specific assertions are never contaminated by it.

  it("adds no boundary anomaly when a process's seq continues cleanly across the boundary", () => {
    writeBoundaryFixture(stateDir, () => {
      // No mutation: the fixture's own counter just keeps incrementing (3 -> 4 -> 5), exactly as a
      // healthy writer moving from one sealed segment into the next behaves.
    });
    const ownGapTotal =
      sumAnomalies(segmentManifestEvidence(stateDir, 1)) +
      sumAnomalies(segmentManifestEvidence(stateDir, 2));
    expect(ownGapTotal).toBe(1); // segment 2's own "seq 4 after its own previous 0" gap.

    const { result } = query(stateDir, eventFilter);

    expect(result.events).toHaveLength(5);
    expect(result.integrity.classification).toBe("supported");
    // The boundary reconciliation adds nothing beyond what each segment's own manifest already
    // reported: no false positive from a clean handoff.
    expect(result.integrity.sequenceAnomalyCount).toBe(ownGapTotal);
  });

  it("detects a decreasing seq across a segment boundary that neither manifest alone can see", () => {
    writeBoundaryFixture(stateDir, (proc) => {
      proc.seq = 1; // the next line becomes seq 2: less than segment 1's lastSeq (3), not a reset.
    });

    // Neither manifest, built from its own segment alone, sees anything but a plain gap: segment 1
    // ends cleanly at 3, and segment 2 only knows its own first line looks like a gap from ITS OWN
    // previous (0) — never that 2 is actually LESS than segment 1's last value.
    expect(segmentManifestEvidence(stateDir, 1)).toMatchObject({
      gap: 0,
      decreasing: 0,
      duplicate: 0,
      reset: 0,
    });
    expect(segmentManifestEvidence(stateDir, 2)).toMatchObject({
      gap: 1,
      decreasing: 0,
      duplicate: 0,
      reset: 0,
    });

    const { result } = query(stateDir, eventFilter);

    // 1 pre-existing per-segment gap (segment 2's own) + 1 new boundary "decreasing", found only by
    // reconciling segment 1's lastSeq (3) against segment 2's firstSeq (2) across the two manifests.
    expect(result.integrity).toMatchObject({
      classification: "incomplete",
      sequenceAnomalyCount: 2,
    });
    expect(result.diagnosticSufficiency.status).not.toBe("complete");
  });

  it("detects a duplicate seq across a segment boundary", () => {
    writeBoundaryFixture(stateDir, (proc) => {
      proc.seq = 2; // the next line becomes seq 3: exactly segment 1's lastSeq.
    });

    expect(segmentManifestEvidence(stateDir, 2)).toMatchObject({
      gap: 1, // segment 2's own "seq 3 after its own previous 0" gap — never "duplicate" on its own.
      decreasing: 0,
      duplicate: 0,
      reset: 0,
    });

    const { result } = query(stateDir, eventFilter);

    // 1 pre-existing per-segment gap + 1 new boundary "duplicate" (segment 2's firstSeq exactly
    // repeats segment 1's lastSeq).
    expect(result.integrity).toMatchObject({
      classification: "incomplete",
      sequenceAnomalyCount: 2,
    });
  });

  it("detects a reset seq across a segment boundary", () => {
    writeBoundaryFixture(stateDir, (proc) => {
      proc.seq = 0; // the next line becomes seq 1: a reset (and, by the same values, decreasing).
    });

    // seq 1 is exactly what segment 2's OWN builder expects as its very first line (previous 0 + 1),
    // so this is the one case where segment 2 contributes no gap of its own: the entire finding
    // comes from the boundary reconciliation.
    expect(segmentManifestEvidence(stateDir, 2)).toMatchObject({
      gap: 0,
      decreasing: 0,
      duplicate: 0,
      reset: 0,
    });

    const { result } = query(stateDir, eventFilter);

    // seq 1 after lastSeq 3 satisfies both the reset and the decreasing condition, exactly as the
    // same single line would when analyzed whole (analyzeLogLines' lineSequenceAnomalies) — two
    // distinct anomaly kinds, one boundary transition, zero pre-existing per-segment gap this time.
    expect(result.integrity).toMatchObject({
      classification: "incomplete",
      sequenceAnomalyCount: 2,
    });
  });
});
