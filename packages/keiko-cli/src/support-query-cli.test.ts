import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
  activityLogOperationSchema,
  attachActivityLogEventRegistration,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  closeFileServerLogSinks,
  recordRegisteredFailureIncident,
  recordUserReportedIncident,
} from "@oscharko-dev/keiko-server";
import { createFileServerLogSink } from "@oscharko-dev/keiko-activity-log";
import type { CliIo } from "./runner.js";
import { loadActivityLog } from "./lazy-modules.js";
import { parseSupportArgs, runSupportCli, type SupportCliDeps } from "./support.js";
import { analyzeSupportReport, parseSupportReport } from "@oscharko-dev/keiko-activity-log/reader";
import {
  fixtureEvent,
  fixtureLine,
  fixtureProcess,
  segmentIdentity,
  writeFixtureSegment,
} from "../../../tests/support/activity-log-segments.js";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";

const REAL_TMPDIR = realpathSync(tmpdir());
const roots: string[] = [];
const T0 = Date.UTC(2026, 8, 18, 7, 0, 0);
const ROOT_ID = "corr-cli-root-000001";
const CHILD_ID = "corr-cli-child-00001";
const OTHER_ID = "corr-cli-other-00001";

afterEach(() => {
  closeFileServerLogSinks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(REAL_TMPDIR, prefix));
  roots.push(root);
  return root;
}

function makeIo(): { readonly io: CliIo; readonly out: () => string; readonly err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (text): void => void out.push(text), err: (text): void => void err.push(text) },
    out: (): string => out.join(""),
    err: (): string => err.join(""),
  };
}

// Returns the persisted source lines, in order, so export assertions compare bytes, not shapes.
function stateWithHistory(): { readonly stateDir: string; readonly lines: readonly string[] } {
  const stateDir = makeRoot("keiko-query-cli-state-");
  const a = fixtureProcess(7101, "0badc0de");
  const lines = [
    fixtureLine(a, T0, { op: "client.diagnostic", correlationId: ROOT_ID }),
    fixtureLine(a, T0 + 5, {
      op: "client.diagnostic",
      correlationId: CHILD_ID,
      parentCorrelationId: ROOT_ID,
    }),
    fixtureLine(a, T0 + 7, { op: "client.diagnostic", correlationId: OTHER_ID }),
  ];
  writeFixtureSegment(stateDir, segmentIdentity(a, T0, 1), lines);
  return { stateDir, lines };
}

function exportDeps(cwd: string): SupportCliDeps {
  return { cwd };
}

const AUDIT_ENV = { KEIKO_LOCAL_STATE_AUDITOR: "/opt/keiko/scripts/lib/local-state-audit.mjs" };

// Query and manifest commands reach the Activity Log through `loadActivityLog()`, its isolated graph
// imported lazily. That first import is the slowest step of this suite and, under coverage or on a
// slow filesystem, can alone exceed the per-test budget of whichever test runs first. Pay it once
// here, bounded on the hook as in portable-macos-activation.test.ts, so a real hang still fails.
beforeAll(async () => {
  await loadActivityLog();
}, 60_000);
describe("keiko support query/manifest argument parsing (#3531)", () => {
  it.each([
    [["query"], "needs a selector"],
    [["query", "--correlation-id", "x"], "--correlation-id is not valid"],
    [["query", "--correlation-id"], "--correlation-id is missing its value"],
    [["query", "--correlation-id", ROOT_ID, "--op", "client.diagnostic"], "cannot be combined"],
    [["query", "--correlation-id", ROOT_ID, "--incident", "0".repeat(32)], "are exclusive"],
    [["query", "--error-kind", "not-a-kind"], "--error-kind is not valid"],
    [["query", "--op", "not.registered"], "--op is not valid"],
    [["query", "--failure-class", "not-a-class"], "--failure-class is not valid"],
    [["query", "--from", "yesterday"], "--from must be an ISO 8601 timestamp"],
    [
      ["query", "--from", "2026-09-18T10:00:00Z", "--to", "2026-09-18T09:00:00Z"],
      "--from must not be after --to",
    ],
    [["query", "--correlation-id", ROOT_ID, "--max-bytes", "0"], "--max-bytes must be an integer"],
    [["manifest", "compact"], "unknown manifest action"],
    [["export", "--op", "client.diagnostic"], "export selects by"],
  ])("rejects %j with a usage error", (args, message) => {
    const parsed = parseSupportArgs(args);
    expect(parsed.kind).toBe("usage");
    expect(parsed.kind === "usage" ? parsed.message : "").toContain(message);
  });

  it("prints the query usage for query --help and manifest without an action", async () => {
    for (const args of [["query", "--help"], ["manifest"]]) {
      const { io, out } = makeIo();
      await expect(runSupportCli(args, io, {})).resolves.toBe(0);
      expect(out()).toContain("keiko support query");
    }
  });
});

describe("keiko support query (#3531)", () => {
  it("prints the versioned machine result with each event's persisted record", async () => {
    const { stateDir, lines } = stateWithHistory();
    const { io, out } = makeIo();

    const code = await runSupportCli(
      ["query", "--state-dir", stateDir, "--correlation-id", ROOT_ID, "--json"],
      io,
      {},
    );

    expect(code).toBe(0);
    const result = JSON.parse(out()) as {
      readonly kind: string;
      readonly schemaVersion: number;
      readonly diagnosticSufficiency: { readonly status: string };
      readonly events: readonly { readonly role: string; readonly record: unknown }[];
    };
    expect(result).toMatchObject({ kind: "keiko.support.query", schemaVersion: 1 });
    expect(result.events.map((event) => event.record)).toEqual(
      lines.slice(0, 2).map((line) => JSON.parse(line) as unknown),
    );
    expect(result.events.every((event) => event.role === "closure")).toBe(true);
    expect(out()).not.toContain(stateDir);
  });

  it("derives the human report from the same result", async () => {
    const { stateDir } = stateWithHistory();
    const { io, out } = makeIo();

    await expect(
      runSupportCli(["query", "--state-dir", stateDir, "--correlation-id", ROOT_ID], io, {}),
    ).resolves.toBe(0);
    expect(out()).toContain("Query: correlation (keiko.support.query v1)");
    expect(out()).toContain("Closure: 2 correlation(s), 0 without retained events");
  });

  it("resolves a user-reported incident through its descriptor window and correlation", async () => {
    const stateDir = makeRoot("keiko-query-cli-incident-");
    const reportCorrelation = "corr-cli-report-0001";
    const created = recordUserReportedIncident(stateDir, { correlationId: reportCorrelation });
    if (created.status === "rejected") throw new Error(`incident rejected: ${created.reason}`);
    const { io, out } = makeIo();

    const code = await runSupportCli(
      ["query", "--state-dir", stateDir, "--incident", created.incidentId, "--json"],
      io,
      {},
    );

    expect(code).toBe(0);
    const result = JSON.parse(out()) as {
      readonly query: { readonly class: string };
      readonly diagnosticSufficiency: { readonly reasons: readonly string[] };
      readonly events: readonly { readonly record: { readonly op: string } }[];
    };
    expect(result.query.class).toBe("incident");
    expect(result.diagnosticSufficiency.reasons).not.toContain("evidence-not-retained");
    expect(result.events.map((event) => event.record.op)).toContain("support.incident.created");
  });

  it("answers an unknown incident with insufficient evidence-not-retained", async () => {
    const { stateDir } = stateWithHistory();
    const { io, out } = makeIo();

    await expect(
      runSupportCli(
        ["query", "--state-dir", stateDir, "--incident", "f".repeat(32), "--json"],
        io,
        {},
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(out())).toMatchObject({
      diagnosticSufficiency: { status: "insufficient", reasons: ["evidence-not-retained"] },
      events: [],
    });
  });

  // Regression: a registered failure with no correlation of its own (a bare diagnostic op, no
  // request in flight) has no root to walk a closure from. Before this fix, incidentPart only fell
  // back to the incident's own pinned window for a user-reported trigger, so a correlation-less
  // registered-failure incident's own segments were pinned but never queryable again: its query
  // resolved to `insufficient`/`evidence-not-retained` even though its evidence was right there.
  it("resolves a correlation-less registered-failure incident through its own pinned window", async () => {
    const stateDir = makeRoot("keiko-query-cli-no-correlation-");
    const registration = activityLogOperationSchema("cli.support.export.failed");
    if (registration === undefined) throw new Error("fixture operation is not registered");
    createFileServerLogSink(stateDir).write(
      attachActivityLogEventRegistration(
        {
          level: "error",
          category: "diagnostic",
          op: "cli.support.export.failed",
          // The sentinel a real bare diagnostic write persists when no request is in flight
          // (verified against a real scenario's actual output) — never a real correlation id.
          correlationId: ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
          errorKind: "unavailable",
          extra: {
            reason: "activity-log-unavailable",
            targetSha256: "a".repeat(64),
            failureKind: "SupportActivityLogUnavailableError",
            completeness: "complete",
            loss: "none",
          },
        },
        registration,
      ),
    );
    const created = recordRegisteredFailureIncident(stateDir, {
      op: "cli.support.export.failed",
      errorKind: "unavailable",
      // No correlationId at all: exactly the bare-diagnostic-op case.
    });
    if (created?.status !== "created") {
      throw new Error(`expected a created incident, got ${JSON.stringify(created)}`);
    }
    const { io, out } = makeIo();

    const code = await runSupportCli(
      ["query", "--state-dir", stateDir, "--incident", created.incidentId, "--json"],
      io,
      {},
    );

    expect(code).toBe(0);
    const result = JSON.parse(out()) as {
      readonly diagnosticSufficiency: { readonly status: string; readonly reasons: string[] };
      readonly events: readonly { readonly record: { readonly op: string } }[];
    };
    expect(result.diagnosticSufficiency.reasons).not.toContain("evidence-not-retained");
    expect(result.events.map((event) => event.record.op)).toContain("cli.support.export.failed");
  });
});

describe("keiko support manifest (#3531)", () => {
  it("rebuilds every manifest and verifies them, reporting a missing one", async () => {
    const { stateDir } = stateWithHistory();
    const rebuild = makeIo();
    await expect(
      runSupportCli(["manifest", "rebuild", "--state-dir", stateDir, "--json"], rebuild.io, {}),
    ).resolves.toBe(0);
    expect(JSON.parse(rebuild.out())).toMatchObject({
      kind: "keiko.support.manifest",
      schemaVersion: 1,
      trigger: "rebuild",
      segmentCount: 1,
      builtCount: 1,
    });

    const verified = makeIo();
    await expect(
      runSupportCli(["manifest", "verify", "--state-dir", stateDir], verified.io, {}),
    ).resolves.toBe(0);
    expect(verified.out()).toContain("1 verified, 0 different");

    // A segment sealed after the rebuild (the command's own evidence) is "not yet built", never an
    // error; a stored manifest that no longer matches its segment is.
    const directory = join(stateDir, "activity-log-manifests");
    const [stored = ""] = readdirSync(directory);
    chmodSync(join(directory, stored), 0o600);
    writeFileSync(join(directory, stored), "{}\n");
    const corrupt = makeIo();
    await expect(
      runSupportCli(["manifest", "verify", "--state-dir", stateDir, "--json"], corrupt.io, {}),
    ).resolves.toBe(1);
    expect(JSON.parse(corrupt.out())).toMatchObject({ verifiedCount: 0, mismatchCount: 1 });
  });
});

function readExportedReport(directory: string): string {
  const reports = readdirSync(directory).filter((name) => name.startsWith("keiko-support-v1-"));
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatch(/^keiko-support-v1-[a-f0-9]{12}-\d{4}-\d{2}-\d{2}\.json$/u);
  return readFileSync(join(directory, reports[0] ?? ""), "utf8");
}

describe("keiko support export with a selector (#3531)", () => {
  // Review #3679: the report of a long-running process keeps the runtime its start recorded.
  it("keeps a long-running process's runtime in the exported report", async () => {
    const stateDir = makeRoot("keiko-query-cli-runtime-");
    const a = fixtureProcess(7103, "0badc0d3");
    writeFixtureSegment(stateDir, segmentIdentity(a, T0, 1), [
      fixtureLine(a, T0, { op: "process.started" }),
      fixtureLine(a, T0 + 600_000, { op: "client.diagnostic", correlationId: ROOT_ID }),
    ]);
    const outDir = makeRoot("keiko-query-cli-out-");
    const { io, err } = makeIo();

    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--correlation-id", ROOT_ID, "--out", outDir],
      io,
      AUDIT_ENV,
      exportDeps(outDir),
    );

    expect(code, err()).toBe(0);
    const report = parseSupportReport(readExportedReport(outDir));
    const decoded = JSON.parse(
      inflateSync(Buffer.from(report.evidence.payload, "base64")).toString("utf8"),
    ) as readonly { readonly record: Readonly<Record<string, unknown>> }[];
    expect(decoded.map((event) => event.record)).toContainEqual(
      expect.objectContaining({
        op: "process.started",
        nodeVersion: "v24.18.0",
        platform: "linux",
      }),
    );
  });

  // Review #3679: retention removed the startup segment of a long-running process, before or after
  // its first heartbeat. Export and analyze state the loss, and so do the lines they persist: the
  // log alone must explain the missing runtime.
  it.each([
    ["after its first heartbeat", true],
    ["before its first heartbeat", false],
  ])("states a long-running process's start that retention removed %s", async (_label, beat) => {
    const stateDir = makeRoot("keiko-query-cli-retention-");
    const controlStateDir = makeRoot("keiko-query-cli-control-");
    const a = fixtureProcess(7104, "0badc0d4");
    const startup = writeFixtureSegment(stateDir, segmentIdentity(a, T0, 1), [
      fixtureLine(a, T0, { op: "process.started" }),
      ...(beat ? [fixtureLine(a, T0 + 60_000, { op: "process.heartbeat" })] : []),
    ]);
    // In write order: each line takes the next seq.
    const later = beat
      ? fixtureLine(a, T0 + 120_000, { op: "process.heartbeat" })
      : fixtureLine(a, T0 + 120_000, { op: "client.diagnostic", correlationId: OTHER_ID });
    const failure = fixtureLine(a, T0 + 600_000, {
      op: "client.diagnostic",
      correlationId: ROOT_ID,
    });
    writeFixtureSegment(stateDir, segmentIdentity(a, T0 + 120_000, 2), [later, failure]);
    rmSync(startup);
    const outDir = makeRoot("keiko-query-cli-out-");
    const deps = { cwd: outDir, controlActivityStateDir: controlStateDir };
    const { io, err } = makeIo();

    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--correlation-id", ROOT_ID, "--out", outDir],
      io,
      AUDIT_ENV,
      deps,
    );

    expect(code, err()).toBe(0);
    const text = readExportedReport(outDir);
    const report = parseSupportReport(text);
    expect(report.selection).toMatchObject({
      status: "insufficient",
      reasons: expect.arrayContaining(["evidence-not-retained"]) as unknown,
    });
    const exportLog = readPersistedActivityLog(stateDir);
    const [queried] = persistedActivityLogLines(exportLog, "support.query.completed");
    const [exported] = persistedActivityLogLines(exportLog, "support.report.completed");
    const query = expectActivityLogProof("support.query.completed.query-evidence", queried ?? "");
    const completed = expectActivityLogProof(
      "support.report.completed.report-lifecycle",
      exported ?? "",
    );
    // A retained heartbeat travels as the proof a receiver recomputes the lost start from.
    const selected = beat ? [later, failure] : [failure];
    const selectedBytes = selected.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
    expect(query).toMatchObject({
      surface: "export",
      queryClass: "correlation",
      resultEventCount: selected.length,
      selectedBytes,
      requiredBytes: selectedBytes,
      truncation: "none",
      sufficiency: "insufficient",
      sufficiencyReasons: ["evidence-not-retained"],
    });
    expect(completed).toMatchObject({
      surface: "export",
      recordCount: selected.length,
      reportBytes: Buffer.byteLength(text),
      sufficiency: "insufficient",
      sufficiencyReasons: ["evidence-not-retained"],
    });
    expect(completed.correlationId).toBe(query.correlationId);

    const analysis = makeIo();
    const analyzed = await runSupportCli(
      ["analyze", join(outDir, readdirSync(outDir)[0] ?? ""), "--json"],
      analysis.io,
      {},
      deps,
    );
    expect(analyzed, analysis.err()).toBe(0);
    expect(JSON.parse(analysis.out())).toMatchObject({
      selection: { status: "insufficient", reasons: ["evidence-not-retained"] },
    });
    const [analyzedLine] = persistedActivityLogLines(
      readPersistedActivityLog(controlStateDir),
      "support.report.completed",
    );
    expect(
      expectActivityLogProof("support.report.completed.report-lifecycle", analyzedLine ?? ""),
    ).toMatchObject({
      surface: "analyze",
      recordCount: selected.length,
      sufficiency: "insufficient",
      sufficiencyReasons: ["evidence-not-retained"],
    });
  });

  // Review #3679: a writer's confirmed drop degrades the report, and every line export and analyze
  // complete with must say why: without the reason on them, the loss behind the verdict could not be
  // reconstructed from the log. The real writer produces the evidence — a gateway event the registry
  // rejects, the seal that counts the drop, then the failure — so no fixture restates its formula.
  it("states a writer's confirmed drop on every completion export and analyze persist", async () => {
    const stateDir = makeRoot("keiko-query-cli-drop-");
    const controlStateDir = makeRoot("keiko-query-cli-control-");
    const chat = { modelId: "test-model", streaming: false };
    const started = { costClass: "low", timeoutMs: 100, maxRetries: 0, requestBudgetMs: 100 };
    // The rejected write announces its drop on the independent stderr channel.
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const writer = createFileServerLogSink(stateDir);
    writer.write(fixtureEvent({ op: "process.started" }));
    writer.write(
      fixtureEvent({
        op: "gateway.chat.started",
        correlationId: ROOT_ID,
        fields: { ...chat, ...started, upstreamStreaming: false },
      }),
    );
    writer.write(
      fixtureEvent({
        op: "gateway.chat.started",
        correlationId: ROOT_ID,
        fields: { ...chat, ...started, costClass: "unbounded", upstreamStreaming: false },
      }),
    );
    writer.close?.();
    createFileServerLogSink(stateDir).write(
      fixtureEvent({
        op: "gateway.chat.failed",
        correlationId: ROOT_ID,
        errorKind: "timeout",
        level: "error",
        fields: chat,
      }),
    );
    closeFileServerLogSinks();
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
    const sources = readPersistedActivityLog(stateDir);
    expect(
      persistedActivityLogLines(sources, "activity-log.segment.sealed").map(
        (line) => JSON.parse(line) as Readonly<Record<string, unknown>>,
      ),
    ).toContainEqual(
      expect.objectContaining({
        droppedEventCount: 1,
        completeness: "partial",
        loss: "event-dropped",
      }),
    );
    const outDir = makeRoot("keiko-query-cli-out-");
    const deps = { cwd: outDir, controlActivityStateDir: controlStateDir };
    const { io, err } = makeIo();

    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--correlation-id", ROOT_ID, "--out", outDir],
      io,
      AUDIT_ENV,
      deps,
    );

    expect(code, err()).toBe(0);
    const text = readExportedReport(outDir);
    const report = parseSupportReport(text);
    // The seal that counts the drop also declares its own segment partial.
    const reasons = ["activity-log-loss", "evidence-partial"];
    expect(report.selection).toMatchObject({ status: "degraded", reasons });
    const exportLog = readPersistedActivityLog(stateDir);
    const [queried] = persistedActivityLogLines(exportLog, "support.query.completed");
    const [exported] = persistedActivityLogLines(exportLog, "support.report.completed");
    const query = expectActivityLogProof("support.query.completed.query-evidence", queried ?? "");
    const completed = expectActivityLogProof(
      "support.report.completed.report-lifecycle",
      exported ?? "",
    );
    expect(query).toMatchObject({
      surface: "export",
      queryClass: "correlation",
      resultEventCount: report.evidence.recordCount,
      truncation: "none",
      sufficiency: "degraded",
      sufficiencyReasons: reasons,
    });
    expect(completed).toMatchObject({
      surface: "export",
      recordCount: report.evidence.recordCount,
      reportBytes: Buffer.byteLength(text),
      sufficiency: "degraded",
      sufficiencyReasons: reasons,
    });
    expect(completed.correlationId).toBe(query.correlationId);

    const analysis = makeIo();
    const analyzed = await runSupportCli(
      ["analyze", join(outDir, readdirSync(outDir)[0] ?? ""), "--json"],
      analysis.io,
      {},
      deps,
    );
    expect(analyzed, analysis.err()).toBe(0);
    expect(JSON.parse(analysis.out())).toMatchObject({
      selection: { status: "degraded", reasons },
    });
    const [analyzedLine] = persistedActivityLogLines(
      readPersistedActivityLog(controlStateDir),
      "support.report.completed",
    );
    const analyzedRecord = expectActivityLogProof(
      "support.report.completed.report-lifecycle",
      analyzedLine ?? "",
    );
    expect(analyzedRecord).toMatchObject({
      surface: "analyze",
      analysisView: "analysis",
      recordCount: report.evidence.recordCount,
      reportBytes: Buffer.byteLength(text),
      reportDigest: completed.reportDigest,
      sufficiency: "degraded",
      sufficiencyReasons: reasons,
    });
    expect(analyzedRecord.correlationId).not.toBe(query.correlationId);
  });

  // #3534: a report over a crashed writer's torn tail says truncated, never corrupt, so the intact
  // evidence before the crash is degraded rather than refused as insufficient.
  it("reports a torn segment tail as truncated evidence, never corrupt", async () => {
    const stateDir = makeRoot("keiko-query-cli-torn-");
    const a = fixtureProcess(7102, "0badc0d2");
    writeFixtureSegment(
      stateDir,
      segmentIdentity(a, T0, 1),
      [fixtureLine(a, T0, { op: "client.diagnostic", correlationId: ROOT_ID })],
      { state: "active", tail: '{"ts":"2026-09-18T12:00:01.000Z","op":"client.d' },
    );
    const outDir = makeRoot("keiko-query-cli-out-");
    const { io, err } = makeIo();

    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--correlation-id", ROOT_ID, "--out", outDir],
      io,
      AUDIT_ENV,
      exportDeps(outDir),
    );

    expect(code, err()).toBe(0);
    const text = readExportedReport(outDir);
    const { reasons } = parseSupportReport(text).selection;
    expect(reasons).toContain("truncated-evidence");
    expect(reasons).not.toContain("corrupt-evidence");
    expect(analyzeSupportReport(text).selection.reasons).not.toContain("corrupt-evidence");
  });

  it("exports only the causal closure, preserving technical fields and private reference joins", async () => {
    const { stateDir, lines } = stateWithHistory();
    const outDir = makeRoot("keiko-query-cli-out-");
    const { io } = makeIo();

    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--correlation-id", ROOT_ID, "--out", outDir],
      io,
      AUDIT_ENV,
      exportDeps(outDir),
    );

    expect(code).toBe(0);
    const text = readExportedReport(outDir);
    const report = parseSupportReport(text);
    // The exported header owns the private references. Every other technical field still matches
    // the retained records, in order; customer correlation labels never enter the artifact.
    const decoded = JSON.parse(
      inflateSync(Buffer.from(report.evidence.payload, "base64")).toString("utf8"),
    ) as readonly { readonly record: unknown }[];
    const root = report.incident.correlation.rootCorrelationId;
    const analysis = analyzeSupportReport(text).analysis;
    const child = analysis.timelines.find(
      (timeline) => timeline.correlationId !== root,
    )?.correlationId;
    expect(root).toBeDefined();
    expect(child).toBeDefined();
    expect(child).not.toBe(root);
    expect(decoded.map((event) => event.record)).toEqual(
      lines.slice(0, 2).map((line, index) => ({
        ...(JSON.parse(line) as Record<string, unknown>),
        correlationId: index === 0 ? root : child,
        ...(index === 0 ? {} : { parentCorrelationId: root }),
      })),
    );
    expect(JSON.stringify(decoded)).not.toContain(ROOT_ID);
    expect(JSON.stringify(decoded)).not.toContain(CHILD_ID);
    expect(JSON.stringify(decoded)).not.toContain(OTHER_ID);
    expect(report.selection.status).toBe("complete");
    expect(analysis.evidence).toMatchObject({
      classification: "supported",
      supportedLineCount: 2,
      corruptLineCount: 0,
    });
  });

  it("writes nothing and exits 1 when the closure does not fit the budget", async () => {
    const { stateDir } = stateWithHistory();
    const outDir = makeRoot("keiko-query-cli-out-");
    const { io, err } = makeIo();

    const code = await runSupportCli(
      [
        "export",
        "--state-dir",
        stateDir,
        "--correlation-id",
        ROOT_ID,
        "--out",
        outDir,
        "--max-bytes",
        "100",
      ],
      io,
      AUDIT_ENV,
      exportDeps(outDir),
    );

    expect(code).toBe(1);
    expect(readdirSync(outDir)).toEqual([]);
    expect(err()).toContain("report-budget-exceeded");
  });

  it("records nothing and writes nothing for a correlation without retained evidence", async () => {
    const { stateDir } = stateWithHistory();
    const outDir = makeRoot("keiko-query-cli-out-");
    const { io, err } = makeIo();

    const code = await runSupportCli(
      [
        "export",
        "--state-dir",
        stateDir,
        "--correlation-id",
        "corr-cli-absent-0001",
        "--out",
        outDir,
      ],
      io,
      AUDIT_ENV,
      exportDeps(outDir),
    );

    expect(code).toBe(1);
    expect(err()).toContain("keiko support: selection-unavailable");
    expect(readdirSync(outDir)).toEqual([]);
    // A mistyped correlation never pins a fourteen-day incident window.
    expect(existsSync(join(stateDir, "support-incidents"))).toBe(false);
  });

  // Audit (#3531/#3533): a user-reported incident's window is never empty — it always captures at
  // least its own support.incident.created line — but when the window holds no REGISTERED FAILURE,
  // the selection is `insufficient` with the closed instrumentation-gap reason `no-registered-failure`
  // (support-analyze-sufficiency.ts). That reason was never asserted end-to-end through export.
  it("never claims complete for a user-reported incident with no registered failure", async () => {
    const stateDir = makeRoot("keiko-query-cli-no-failure-");
    const created = recordUserReportedIncident(stateDir, {
      correlationId: "corr-cli-no-failure-01",
    });
    if (created.status === "rejected") throw new Error(`incident rejected: ${created.reason}`);
    const outDir = makeRoot("keiko-query-cli-out-");
    const { io } = makeIo();

    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--incident", created.incidentId, "--out", outDir],
      io,
      AUDIT_ENV,
      exportDeps(outDir),
    );

    expect(code).toBe(0);
    const report = parseSupportReport(readExportedReport(outDir));
    expect(report.selection.status).toBe("insufficient");
    expect(report.selection.reasons).toContain("no-registered-failure");
    expect(analyzeSupportReport(readExportedReport(outDir)).selection.status).toBe("insufficient");
  });
});
