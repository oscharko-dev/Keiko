import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync, gunzipSync, inflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  supportIncidentPrivateProjection,
  type SupportReport,
  type SupportIncidentPrivateProjection,
  MAX_SUPPORT_REPORT_CONTAINERS,
  MAX_SUPPORT_REPORT_DEPTH,
  MAX_SUPPORT_REPORT_EVENT_BYTES,
  MAX_SUPPORT_REPORT_BYTES,
  MAX_SUPPORT_REPORT_OBJECT_KEYS,
  MAX_SUPPORT_REPORT_RECORDS,
  MAX_SUPPORT_REPORT_VALUES,
  parseActivityLogFileName,
  type SupportLifetimeProvenance,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  prepareUnretainedUserReportDescriptor,
  recordRegisteredFailureIncident,
  recordUserReportedIncident,
  supportIncidentSegmentFiles,
} from "../support-incident.js";
import { resolveSupportIncident } from "../../../keiko-cli/src/support-incident.js";
import { executeLocalSupportQuery } from "./support-local-query.js";
import {
  fixtureLine,
  fixtureProcess,
  segmentIdentity,
  writeFixtureSegment,
  type FixtureProcess,
} from "../../../../tests/support/activity-log-segments.js";
import { analyzeLogText } from "./support-analyze.js";
import { DEFAULT_SUPPORT_QUERY_LIMITS, type SupportQueryResult } from "./support-query.js";
import {
  analyzeSupportReport,
  buildSupportReport,
  canonicalSupportJson,
  parseSupportReport,
  prepareSupportReportSeed,
  serializeSupportReport,
  SupportReportError,
  encodeSupportReportEvidence,
  sealSupportReport,
  supportReportDigest,
  supportReportTimeline,
} from "./support-report.js";
import { parseCanonicalSupportJson } from "./support-report-json.js";
import { resolveSelectedSupportIncident } from "./support-incident-resolution.js";
import { createClientOnlySupportReport } from "./support-desktop-report.js";

import { supportReportPrivacyProjection } from "./support-report-privacy.js";
import { findSupportRegistry } from "./support-registry.js";
import { SUPPORT_RELEASE_REGISTRY_SNAPSHOTS } from "./support-registry-history.generated.js";

const T0 = Date.UTC(2026, 8, 30, 12);
const CORRELATION = "support-report-fixture-0001";
let stateDir: string;

function fixture(
  count = 1,
  fields: Readonly<Record<string, unknown>> = {},
  parentAt?: (index: number) => string,
  lead: (process: FixtureProcess) => readonly string[] = () => [],
): {
  report: SupportReport;
  query: SupportQueryResult;
  incident: SupportIncidentPrivateProjection;
} {
  const process = fixtureProcess(4242, "aabbccdd");
  writeFixtureSegment(stateDir, segmentIdentity(process, T0, 1), [
    ...lead(process),
    ...Array.from({ length: count }, (_, index) =>
      fixtureLine(process, T0 + index, {
        op: "client.diagnostic",
        correlationId: CORRELATION,
        ...(parentAt === undefined ? {} : { parentCorrelationId: parentAt(index) }),
        fields,
      }),
    ),
  ]);
  const created = recordUserReportedIncident(stateDir, { nowMs: T0, correlationId: CORRELATION });
  if (created.status !== "created") throw new TypeError("incident fixture was not created");
  const record = created.record;
  const incident = supportIncidentPrivateProjection(
    resolveSupportIncident(record, supportIncidentSegmentFiles(stateDir, record), stateDir),
  );
  const { result: query } = executeLocalSupportQuery(
    stateDir,
    {
      kind: "closure",
      queryClass: "incident",
      roots: [CORRELATION],
      windows: [],
      requiredClasses: { kind: "observed-failures" },
      unresolved: false,
    },
    DEFAULT_SUPPORT_QUERY_LIMITS,
    { trigger: "export" },
  );
  return { report: buildSupportReport(incident, query), query, incident };
}

function countBoundedFixture(
  count: number,
  withContext = false,
): {
  report: SupportReport;
  query: SupportQueryResult;
} {
  const process = fixtureProcess(4242, "aabbccdd");
  const lines = withContext
    ? [
        fixtureLine(process, T0, { op: "process.started" }),
        fixtureLine(process, T0 + 1, { op: "cli.lifecycle.stop-requested" }),
        fixtureLine(process, T0 + 2, { op: "cli.lifecycle.stop-requested" }),
      ]
    : [];
  lines.push(
    ...Array.from({ length: count }, () =>
      fixtureLine(process, T0 + 3, {
        op: "client.diagnostic",
        correlationId: CORRELATION,
      }),
    ),
  );
  writeFixtureSegment(stateDir, segmentIdentity(process, T0, 1), lines);
  const { result: query } = executeLocalSupportQuery(
    stateDir,
    {
      kind: "closure",
      queryClass: "correlation",
      roots: [CORRELATION],
      windows: [],
      requiredClasses: { kind: "observed" },
      unresolved: false,
    },
    DEFAULT_SUPPORT_QUERY_LIMITS,
    { trigger: "export" },
  );
  const incident = supportIncidentPrivateProjection(
    resolveSelectedSupportIncident(prepareUnretainedUserReportDescriptor(CORRELATION), query),
  );
  return { report: buildSupportReport(incident, query), query };
}

describe("canonical body-free offline report", () => {
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-support-report-"));
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("round trips the largest admitted closure with its anchor and fitting optional context", () => {
    const { report, query } = countBoundedFixture(MAX_SUPPORT_REPORT_RECORDS - 2, true);
    const parsed = parseSupportReport(serializeSupportReport(report));
    expect(parsed.evidence.recordCount).toBe(MAX_SUPPORT_REPORT_RECORDS);
    expect(parsed.selection).toMatchObject({
      requiredRecordCount: MAX_SUPPORT_REPORT_RECORDS - 1,
      requiredBytes: query.truncation.requiredBytes,
      reasons: expect.arrayContaining(["context-truncated"]) as unknown,
    });
    expect(parsed.selection.reasons).not.toContain("report-budget-exceeded");
    const analysis = analyzeSupportReport(serializeSupportReport(parsed));
    expect(analysis.selection.requiredRecordCount).toBe(MAX_SUPPORT_REPORT_RECORDS - 1);
  });

  it("exports a count requirement separately from bytes for an oversized required closure", () => {
    const { report, query } = countBoundedFixture(MAX_SUPPORT_REPORT_RECORDS + 1);
    const parsed = parseSupportReport(serializeSupportReport(report));
    expect(parsed.evidence.recordCount).toBe(0);
    expect(parsed.selection).toMatchObject({
      requiredRecordCount: MAX_SUPPORT_REPORT_RECORDS + 1,
      requiredBytes: query.truncation.requiredBytes,
      reasons: expect.arrayContaining(["report-budget-exceeded"]) as unknown,
    });
    expect(parsed.selection.requiredBytes).toBeLessThan(MAX_SUPPORT_REPORT_EVENT_BYTES);
  });

  it.each([-1, 0.5, null, "20001"])(
    "rejects an invalid required record count %s",
    (requiredRecordCount) => {
      const { report } = fixture();
      const forged = sealSupportReport(
        report.incident,
        // @ts-expect-error Deliberately verify rejection of non-numeric wire values.
        { ...report.selection, requiredRecordCount },
        report.evidence,
      );
      expect(() => parseSupportReport(serializeSupportReport(forged))).toThrow(
        expect.objectContaining({ reason: "unsafe-report" }),
      );
    },
  );

  it("accepts older reports whose selection predates the required record count", () => {
    const { report } = fixture();
    const { requiredRecordCount: _count, ...selection } = report.selection;
    const legacy = sealSupportReport(report.incident, selection, report.evidence);
    expect(parseSupportReport(serializeSupportReport(legacy)).selection).toEqual(selection);
  });

  it("refuses client-only availability headers attached to retained server evidence", () => {
    const limited = parseSupportReport(
      createClientOnlySupportReport(CORRELATION, "session-unavailable").reportJson,
    );
    const { report, query } = fixture();
    const forged = sealSupportReport(limited.incident, report.selection, report.evidence);
    expect(() => parseSupportReport(serializeSupportReport(forged))).toThrow(
      expect.objectContaining({ reason: "unsafe-report" }),
    );
    expect(() => buildSupportReport(limited.incident, query)).toThrow(
      expect.objectContaining({ reason: "unsafe-report" }),
    );
  });

  it("refuses a resealed client-only report with manufactured selection requirements", () => {
    const limited = parseSupportReport(
      createClientOnlySupportReport(CORRELATION, "service-unavailable").reportJson,
    );
    expect(() =>
      parseSupportReport(
        serializeSupportReport(
          sealSupportReport(
            limited.incident,
            { ...limited.selection, requiredBytes: 1 },
            limited.evidence,
          ),
        ),
      ),
    ).toThrow(expect.objectContaining({ reason: "unsafe-report" }));
  });

  it("does not label retained unrelated events omitted by canonical selection as process gaps", () => {
    const selectedSequences = new Set([1821, 1854, 1870, 1890, 1892]);
    const { report, query } = fixture(1, {}, undefined, (process) => {
      process.seq = 1820;
      return Array.from({ length: 72 }, (_, index) =>
        fixtureLine(process, T0, {
          op: "client.diagnostic",
          correlationId: selectedSequences.has(1821 + index)
            ? CORRELATION
            : `unrelated-${String(index)}`,
        }),
      );
    });
    expect(
      query.events
        .filter((event) => event.parsed.view.pid === 4242)
        .map((event) => event.parsed.view.seq),
    ).toEqual([1821, 1854, 1870, 1890, 1892, 1893]);
    const analyzed = analyzeSupportReport(serializeSupportReport(report));
    expect(analyzed.incident.loss).toBe("none");
    expect(analyzed.selection.status).toBe("complete");
    expect(
      analyzed.analysis.evidence.sequenceAnomalies.filter((anomaly) => anomaly.pid === 4242),
    ).toEqual([]);
    expect(analyzed.analysis.warnings).not.toContainEqual(
      expect.stringContaining("process sequence anomaly"),
    );
  });

  it("does not report an intentionally unselected process prefix as a canonical report anomaly", () => {
    const { report } = fixture(1, {}, undefined, (process) => {
      process.seq = 339;
      return [];
    });
    const analyzed = analyzeSupportReport(serializeSupportReport(report));
    expect(analyzed.selection.lifetimes).toEqual(
      expect.arrayContaining([expect.objectContaining({ pid: 4242, start: "absent" })]),
    );
    expect(analyzed.analysis.timelines[0]?.lines[0]?.seq).toBe(340);
    expect(analyzed.analysis.evidence.sequenceAnomalies).not.toContainEqual(
      expect.objectContaining({ kind: "gap", pid: 4242, previousSeq: 0, seq: 340 }),
    );
  });

  it("roundtrips a production incident and query, preserving reconstruction and unknown authenticity", () => {
    const { report } = fixture();
    const text = serializeSupportReport(report);
    expect(parseSupportReport(text)).toEqual(report);
    const analyzed = analyzeSupportReport(text);
    expect(analyzed.authenticity).toBe("unknown");
    expect(analyzed.analysis.timelines[0]?.lines[0]?.op).toBe("client.diagnostic");
    expect(analyzed.selection.status).toBe("complete");
    expect(text).not.toContain(stateDir);
  });

  it("bounds parent fan-out before the analyzer materializes duplicated timelines", () => {
    const { query } = fixture(30, {}, (index) => `parent-${String(index)}`);
    const text = query.events.map((event) => event.text).join("\n");
    expect(() => analyzeLogText(text, { maxTimelineRecords: 400 })).toThrow(
      "timeline-budget-exceeded",
    );
  });

  it("accounts for record occurrences and UTF-8 view bytes without truncating timelines", () => {
    const { query } = fixture(4, {}, (index) => `parent-${String(index)}`);
    const text = query.events.map((event) => event.text).join("\n");
    const original = analyzeLogText(text);
    const views = original.timelines.flatMap((timeline) => timeline.lines);
    const bytes = views.reduce((sum, view) => sum + Buffer.byteLength(JSON.stringify(view)), 0);
    expect(
      analyzeLogText(text, { maxTimelineRecords: views.length, maxTimelineBytes: bytes }),
    ).toEqual(original);
    expect(() => analyzeLogText(text, { maxTimelineRecords: views.length - 1 })).toThrow(
      "timeline-budget-exceeded",
    );
    expect(() => analyzeLogText(text, { maxTimelineBytes: bytes - 1 })).toThrow(
      "timeline-budget-exceeded",
    );
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "refuses invalid explicit timeline limits (%s)",
    (limit) => {
      expect(() => analyzeLogText("", { maxTimelineRecords: limit })).toThrow(
        "timeline-budget-exceeded",
      );
      expect(() => analyzeLogText("", { maxTimelineBytes: limit })).toThrow(
        "timeline-budget-exceeded",
      );
    },
  );

  it("reduces evidence above the record cap to an explicitly insufficient report", () => {
    const { query, incident } = fixture();
    const event = query.events[0];
    if (event === undefined) throw new TypeError("missing fixture evidence");
    const oversized = {
      ...query,
      events: Array.from({ length: MAX_SUPPORT_REPORT_RECORDS + 1 }, () => event),
    };
    const reduced = buildSupportReport(incident, oversized);
    expect(reduced.evidence.recordCount).toBe(0);
    expect(reduced.selection.status).toBe("insufficient");
    expect(reduced.selection.reasons).toContain("report-budget-exceeded");
    expect(analyzeSupportReport(serializeSupportReport(reduced)).selection).toEqual(
      reduced.selection,
    );
  });

  it("exports honest insufficiency and rejects resealed graph amplification without a caller override", () => {
    const { report, query } = fixture(300, {}, (index) => `parent-${String(index)}`);
    expect(report.evidence.recordCount).toBe(0);
    expect(report.selection).toMatchObject({ status: "insufficient" });
    expect(report.selection.reasons).toContain("report-budget-exceeded");
    expect(report.selection.reasons).toContain("evidence-not-retained");
    expect(report.selection.requiredBytes).toBe(query.truncation.requiredBytes);
    expect(analyzeSupportReport(serializeSupportReport(report)).selection.status).toBe(
      "insufficient",
    );
    const amplified = query.events.map((event) => ({
      sourceSegmentId: event.file.segmentId ?? "legacy",
      record: JSON.parse(event.text) as Record<string, unknown>,
    }));
    const hostile = sealSupportReport(
      report.incident,
      { ...report.selection, lifetimes: accountFor(amplified) },
      encodeSupportReportEvidence(amplified),
    );
    expect(() =>
      analyzeSupportReport(serializeSupportReport(hostile), {
        maxTimelineRecords: Number.MAX_SAFE_INTEGER,
        maxTimelineBytes: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow("report-budget-exceeded");
  });

  it("retains reduced browser frames while refusing raw chunk names in received evidence", () => {
    const frame = "dist/ui/static/_next/static/chunks/1wntg-7ptuw73.js:12:345";
    const { report, query } = fixture(1, { frames: [frame] });
    const retained = eventsOf(report);
    const persisted = JSON.parse(query.events[0]?.text ?? "null") as Record<string, unknown>;
    expect(retained[0]?.record.frames).toEqual(persisted.frames);
    expect(retained[0]?.record.frames).toHaveLength(1);
    expect(analyzeSupportReport(serializeSupportReport(report)).selection.status).toBe("complete");
    const hostile = sealSupportReport(
      report.incident,
      report.selection,
      encodeSupportReportEvidence(
        retained.map((event) => ({ ...event, record: { ...event.record, frames: [frame] } })),
      ),
    );
    expect(() => analyzeSupportReport(serializeSupportReport(hostile))).toThrow(SupportReportError);
  });

  it("does not bless unrelated evidence as an incident's complete closure", () => {
    const { report } = fixture();
    const incident = {
      ...report.incident,
      correlation: { rootCorrelationId: "unretained-incident", childCorrelationIds: [] },
    };
    const forged = sealSupportReport(incident, report.selection, report.evidence);
    // The analyzer recomputes the verdict and only ever downgrades the declared one.
    expect(analyzeSupportReport(serializeSupportReport(forged)).selection).toMatchObject({
      status: "insufficient",
      reasons: expect.arrayContaining(["evidence-not-retained"]) as unknown,
    });
  });

  it("analyzes the calibration trace offline with no embedded I/O and a 128 MiB heap", () => {
    const { report } = fixture(2000);
    const path = join(stateDir, "received.json");
    writeFileSync(path, serializeSupportReport(report), { mode: 0o600 });
    const moduleUrl = new URL("../../dist/reader/index.js", import.meta.url).href;
    const program = `
      import fs from "node:fs";
      import http from "node:http";
      import https from "node:https";
      import net from "node:net";
      import { syncBuiltinESMExports } from "node:module";
      import { analyzeSupportReport } from ${JSON.stringify(moduleUrl)};
      const text = fs.readFileSync(process.argv[1], "utf8");
      const denied = () => { throw new Error("unexpected report I/O"); };
      for (const key of ["readFileSync", "openSync", "statSync", "accessSync", "existsSync"])
        fs[key] = denied;
      for (const key of ["readFile", "open", "stat", "access"]) fs.promises[key] = denied;
      http.request = http.get = https.request = https.get = net.connect = denied;
      globalThis.fetch = denied;
      syncBuiltinESMExports();
      const result = analyzeSupportReport(text);
      process.stdout.write(JSON.stringify({ status: result.selection.status,
        count: result.analysis.evidence.supportedLineCount }));
    `;
    const result = execFileSync(
      process.execPath,
      ["--max-old-space-size=128", "--input-type=module", "-e", program, path],
      { encoding: "utf8", timeout: 15_000 },
    );
    expect(JSON.parse(result)).toEqual({ status: "complete", count: report.evidence.recordCount });
  });

  it("refuses producer-only route hatches and unsafe frames even with valid registered sections", () => {
    const { report, query, incident } = fixture();
    const process = fixtureProcess(4242, "aabbccdd");
    const request = JSON.parse(
      fixtureLine(process, T0, {
        op: "request",
        correlationId: CORRELATION,
        fields: {
          method: "GET",
          path: "/api/health",
          queryParamNames: [],
          responseBytes: 0,
          aborted: false,
        },
      }),
    ) as Record<string, unknown>;
    const sourceSegmentId = eventsOf(report)[0]?.sourceSegmentId ?? "legacy";
    const original = query.events[0];
    if (original === undefined) throw new TypeError("missing selected event");
    const safe = buildSupportReport(incident, {
      ...query,
      events: [{ ...original, text: canonicalSupportJson(request) }],
    });
    expect(() => analyzeSupportReport(serializeSupportReport(safe))).not.toThrow();
    const unsafeRoute = sealSupportReport(
      safe.incident,
      safe.selection,
      encodeSupportReportEvidence([
        { sourceSegmentId, record: { ...request, path: "/private/customer/body" } },
      ]),
    );
    expect(() => analyzeSupportReport(serializeSupportReport(unsafeRoute))).toThrow(
      SupportReportError,
    );
    const failed = JSON.parse(
      fixtureLine(process, T0 + 1, {
        op: "support.report.failed",
        correlationId: CORRELATION,
        errorKind: "validation-failed",
        fields: {
          surface: "analyze",
          reportSchemaVersion: 1,
          frames: ["packages/keiko-cli/src/support.ts:10:2"],
        },
      }),
    ) as Record<string, unknown>;
    const unsafeFrame = sealSupportReport(
      report.incident,
      report.selection,
      encodeSupportReportEvidence([
        {
          sourceSegmentId,
          record: { ...failed, frames: ["packages/keiko-cli/src/../../customer.ts:10:2"] },
        },
      ]),
    );
    expect(() => analyzeSupportReport(serializeSupportReport(unsafeFrame))).toThrow(
      SupportReportError,
    );
  });

  it("refuses tamper, truncation, duplicate keys, and unknown sections before rendering", () => {
    const text = serializeSupportReport(fixture().report);
    for (const hostile of [
      text.slice(0, -1),
      text.replace('"sha256"', '"sha512"'),
      text.replace('"kind":', '"kind":"keiko.support.report","kind":'),
      text.replace('"kind":', '"attachment":"customer-body","kind":'),
    ]) {
      expect(() => analyzeSupportReport(hostile)).toThrow(SupportReportError);
    }
  });

  it("rejects excessive depth before parsing and terminal controls at canonicalization", () => {
    expect(() => parseSupportReport("[".repeat(1000) + "]".repeat(1000) + "\n")).toThrow(
      SupportReportError,
    );
    for (const character of ["\u001b", "\u0000", "\u0085", "\u202e"]) {
      expect(() => canonicalSupportJson({ value: character })).toThrow(SupportReportError);
    }
  });

  it("uses the hard final-file budget and never reports an omitted closure as complete", () => {
    const { report, query, incident } = fixture();
    const fullBytes = Buffer.byteLength(serializeSupportReport(report));
    const reduced = buildSupportReport(incident, query, fullBytes - 1);
    expect(Buffer.byteLength(serializeSupportReport(reduced))).toBeLessThan(fullBytes);
    // The report-budget metric names exactly what --max-bytes would have to allow.
    expect(reduced.selection.requiredBytes).toBe(fullBytes);
    expect(query.truncation.requiredRecordCount).toBeGreaterThan(0);
    expect(report.selection.requiredRecordCount).toBe(query.truncation.requiredRecordCount);
    expect(reduced.selection.requiredRecordCount).toBe(query.truncation.requiredRecordCount);
    expect(reduced.evidence.recordCount).toBe(0);
    expect(reduced.selection.status).toBe("insufficient");
    expect(reduced.selection.reasons).toContain("report-budget-exceeded");
    expect(() => buildSupportReport(incident, query, 1)).toThrow(SupportReportError);
  });
});

function eventsOf(
  report: SupportReport,
): { sourceSegmentId: string; record: Record<string, unknown> }[] {
  return JSON.parse(inflateSync(Buffer.from(report.evidence.payload, "base64")).toString()) as {
    sourceSegmentId: string;
    record: Record<string, unknown>;
  }[];
}

describe("hostile report admission", () => {
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-hostile-report-"));
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });
  it("refuses a newer minimum analyzer version even with a known schema and valid integrity", () => {
    const report = fixture().report;
    const hostile = sealSupportReport(report.incident, report.selection, report.evidence, "9.0.0");
    expect(() => parseSupportReport(serializeSupportReport(hostile))).toThrow(
      expect.objectContaining({ reason: "unsupported-report", minimumAnalyzerVersion: "9.0.0" }),
    );
  });
  it.each(["01.1.13", "1.1.13-alpha.01", `${"9".repeat(129)}.1.13`])(
    "refuses a malformed minimum analyzer version before rendering: %s",
    (minimum) => {
      const report = fixture().report;
      const hostile = sealSupportReport(
        report.incident,
        report.selection,
        report.evidence,
        minimum,
      );
      expect(() => parseSupportReport(serializeSupportReport(hostile))).toThrow(
        expect.objectContaining({ reason: "unsafe-report" }),
      );
    },
  );
  it("refuses a newer schema with a bounded minimum analyzer version", () => {
    const report = fixture().report;
    const text =
      canonicalSupportJson({ ...report, schemaVersion: 99, minimumAnalyzerVersion: "9.0.0" }) +
      "\n";
    expect(() => parseSupportReport(text)).toThrow(
      expect.objectContaining({ reason: "unsupported-report", minimumAnalyzerVersion: "9.0.0" }),
    );
  });
  it("names the minimum analyzer for a newer schema that adds a section", () => {
    const report = fixture().report;
    const text =
      canonicalSupportJson({
        ...report,
        schemaVersion: 2,
        minimumAnalyzerVersion: "9.0.0",
        attestations: [],
      }) + "\n";
    expect(() => parseSupportReport(text)).toThrow(
      expect.objectContaining({ reason: "unsupported-report", minimumAnalyzerVersion: "9.0.0" }),
    );
    const sameMinimum = canonicalSupportJson({ ...report, schemaVersion: 2, attestations: [] });
    expect(() => parseSupportReport(`${sameMinimum}\n`)).toThrow(
      expect.objectContaining({ reason: "unsupported-report" }),
    );
    const unknownSection = canonicalSupportJson({ ...report, attestations: [] });
    expect(() => parseSupportReport(`${unknownSection}\n`)).toThrow(
      expect.objectContaining({ reason: "unsafe-report" }),
    );
  });
  it("refuses an unknown registry with valid integrity instead of using its own catalog", () => {
    const report = fixture().report;
    const incident = {
      ...report.incident,
      build: { ...report.incident.build, catalogDigest: "f".repeat(64) },
    };
    const hostile = sealSupportReport(incident, report.selection, report.evidence);
    expect(() => analyzeSupportReport(serializeSupportReport(hostile))).toThrow(
      expect.objectContaining({
        reason: "unsupported-report",
        minimumAnalyzerVersion: undefined,
      }),
    );
  });
  it("refuses prohibited event fields even when an attacker recomputes every digest", () => {
    const report = fixture().report;
    const events = eventsOf(report);
    for (const field of ["prompt", "response", "path", "endpoint", "redacted", "$section"]) {
      const hostile = events.map((event) => ({
        ...event,
        record: { ...event.record, [field]: "customer-private" },
      }));
      const resealed = sealSupportReport(
        report.incident,
        report.selection,
        encodeSupportReportEvidence(hostile),
      );
      expect(() => analyzeSupportReport(serializeSupportReport(resealed))).toThrow(
        expect.objectContaining({ reason: "unsafe-report" }),
      );
    }
  });
  it("refuses a source segment whose process identity contradicts its event", () => {
    const report = fixture().report;
    const events = eventsOf(report).map((event) => ({
      ...event,
      record: { ...event.record, pid: 9999 },
    }));
    const resealed = sealSupportReport(
      report.incident,
      report.selection,
      encodeSupportReportEvidence(events),
    );
    expect(() => parseSupportReport(serializeSupportReport(resealed))).toThrow(
      expect.objectContaining({ reason: "unsafe-report" }),
    );
  });
  it("never presents a forged complete verdict over an absent closure as complete", () => {
    const report = fixture().report;
    const hostile = sealSupportReport(
      report.incident,
      { ...report.selection, status: "complete", reasons: [], lifetimes: [] },
      encodeSupportReportEvidence([]),
    );
    const analyzed = analyzeSupportReport(serializeSupportReport(hostile));
    expect(analyzed.selection.status).toBe("insufficient");
    expect(analyzed.selection.reasons).toContain("evidence-not-retained");
  });
  it("refuses trailing compressed bytes rather than accepting an opaque auxiliary payload", () => {
    const report = fixture().report;
    const payload = Buffer.concat([
      Buffer.from(report.evidence.payload, "base64"),
      Buffer.from("hidden"),
    ]).toString("base64");
    const hostile = sealSupportReport(report.incident, report.selection, {
      ...report.evidence,
      payload,
    });
    expect(() => parseSupportReport(serializeSupportReport(hostile))).toThrow(
      expect.objectContaining({ reason: "corrupt-report" }),
    );
  });
  it("bounds decompression independently of the sender's declared section size", () => {
    const report = fixture().report;
    const payload = deflateSync(Buffer.alloc(MAX_SUPPORT_REPORT_EVENT_BYTES + 1)).toString(
      "base64",
    );
    const hostile = sealSupportReport(report.incident, report.selection, {
      ...report.evidence,
      payload,
    });
    expect(() => parseSupportReport(serializeSupportReport(hostile))).toThrow(
      expect.objectContaining({ reason: "corrupt-report" }),
    );
  });
  it("rejects escaped terminal controls inside an otherwise correctly sealed event section", () => {
    const report = fixture().report;
    const correlation = report.incident.correlation.rootCorrelationId;
    if (correlation === undefined) throw new TypeError("missing report correlation");
    const text = JSON.stringify(eventsOf(report)).replace(correlation, `${correlation}\\u001b`);
    const evidence = {
      ...report.evidence,
      rawBytes: Buffer.byteLength(text),
      digest: supportReportDigest(text),
      payload: deflateSync(text).toString("base64"),
    };
    expect(() =>
      parseSupportReport(
        serializeSupportReport(sealSupportReport(report.incident, report.selection, evidence)),
      ),
    ).toThrow();
  });
  it("rejects legacy open sections without returning any of their content", () => {
    for (const section of ["manifest", "config-snapshot", "evidence-manifest", "ui-log"]) {
      expect(() =>
        analyzeSupportReport(
          JSON.stringify({ $section: section, body: "customer-private" }) + "\n",
        ),
      ).toThrow(SupportReportError);
    }
  });
  it("enforces the producer ceiling even when an operator requests a larger budget", () => {
    const { query, incident } = fixture();
    for (const max of [MAX_SUPPORT_REPORT_BYTES + 1, NaN, Infinity, 0, -1, 1.5]) {
      expect(() => buildSupportReport(incident, query, max)).toThrow(
        expect.objectContaining({ reason: "report-budget-exceeded" }),
      );
    }
  });
  it("losslessly compacts 2000 production diagnostic records below an enterprise attachment budget", () => {
    const { report } = fixture(2000);
    expect(
      eventsOf(report).filter((event) => event.record.op === "client.diagnostic"),
    ).toHaveLength(2000);
    expect(report.selection.status).toBe("complete");
    expect(Buffer.byteLength(serializeSupportReport(report))).toBeLessThan(128 * 1024);
    expect(
      analyzeSupportReport(serializeSupportReport(report)).analysis.evidence.supportedLineCount,
    ).toBe(report.evidence.recordCount);
  });
});

describe("historical report reconstruction", () => {
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-historical-report-"));
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });
  it.each(["1.1.9", "99.0.0"])(
    "does not attest current-only modules for release %s sharing the current catalog digest",
    (productVersion) => {
      const { incident } = failureFixture();
      const registry = findSupportRegistry(incident.build);
      if (registry === undefined) throw new TypeError("missing current registry");
      const otherRelease = {
        ...incident,
        productVersion,
        build: { ...incident.build, productVersion },
      };
      const privacy = supportReportPrivacyProjection(otherRelease, registry);
      expect(
        privacy.event({
          sourceSegmentId: "fixture",
          record: {
            op: otherRelease.op,
            correlationId: otherRelease.correlation.rootCorrelationId,
            frames: ["packages/keiko-activity-log/dist/reader/support-desktop-report.js:10:2"],
          },
        }),
      ).toBeUndefined();
      expect(privacy.reasons()).toEqual(["evidence-partial"]);
    },
  );

  it("retains code frames owned by the producing release after modules have moved", () => {
    const snapshot = SUPPORT_RELEASE_REGISTRY_SNAPSHOTS.find((entry) => entry.release === "1.1.9");
    if (snapshot === undefined) throw new TypeError("missing shipped release registry");
    const registry = findSupportRegistry(snapshot);
    if (registry === undefined) throw new TypeError("missing archived registry");
    const { incident } = failureFixture();
    const historical = {
      ...incident,
      productVersion: snapshot.release,
      build: { ...incident.build, ...snapshot, productVersion: snapshot.release },
    };
    const privacy = supportReportPrivacyProjection(historical, registry);
    const frame = "packages/keiko-server/dist/observability/activity-log-store.js:10:2";
    const projected = privacy.event({
      sourceSegmentId: "fixture",
      record: {
        op: historical.op,
        correlationId: historical.correlation.rootCorrelationId,
        frames: [frame],
      },
    });
    expect(projected?.record.frames).toEqual([frame]);
    expect(privacy.reasons()).toEqual([]);
    expect(
      privacy.event({
        sourceSegmentId: "fixture",
        record: {
          op: historical.op,
          correlationId: historical.correlation.rootCorrelationId,
          frames: ["packages/keiko-server/dist/customer-private-file.js:10:2"],
        },
      }),
    ).toBeUndefined();
  });

  it("analyzes frozen 1.1.9 production evidence and seed with its matching registry", () => {
    const packed = JSON.parse(
      readFileSync(
        new URL("../activity-log-compatibility-3558.fixture.json", import.meta.url),
        "utf8",
      ),
    ) as { payload: string };
    const frozen = JSON.parse(gunzipSync(Buffer.from(packed.payload, "base64")).toString()) as {
      files: { name: string; bytes: string }[];
    };
    // Each record keeps the segment it was written to, so its process identity is checked against
    // that segment and the lifetime's first segment shows its beginning (review #3679).
    const events = frozen.files.flatMap((file) => {
      const parsed = parseActivityLogFileName(file.name);
      if (parsed === undefined || !("segmentId" in parsed)) return [];
      return Buffer.from(file.bytes, "base64")
        .toString()
        .trimEnd()
        .split("\n")
        .map((line) => ({
          sourceSegmentId: parsed.segmentId,
          record: JSON.parse(line) as Record<string, unknown>,
        }));
    });
    const first = events[0]?.record;
    if (first === undefined) throw new TypeError("empty historical production fixture");
    const { report } = fixture();
    const incident = {
      ...report.incident,
      productVersion: String(first.productVersion),
      platformClass: report.incident.platformClass,
      build: {
        ...report.incident.build,
        productVersion: String(first.productVersion),
        registryVersion: Number(first.registryVersion),
        schemaDigest: String(first.schemaDigest),
        catalogDigest: String(first.catalogDigest),
      },
      correlation: { rootCorrelationId: String(first.correlationId), childCorrelationIds: [] },
    };
    const historical = sealSupportReport(
      incident,
      { ...report.selection, lifetimes: accountFor(events) },
      encodeSupportReportEvidence(events),
    );
    const analyzed = analyzeSupportReport(serializeSupportReport(historical));
    expect(analyzed.incident.productVersion).toBe("1.1.9");
    expect(analyzed.analysis.evidence.unsupportedLineCount).toBe(0);
    expect(analyzed.analysis.evidence.supportedLineCount).toBe(9);
    expect(analyzed.selection.status).toBe("complete");
    expect(analyzed.seed?.sufficiency.status).toBe("complete");
    expect(prepareSupportReportSeed(analyzed)).toEqual(analyzed.seed);
    expect(prepareSupportReportSeed(analyzed, "missing")).toBeUndefined();
  });
});

// A registered failure; with `parent`, the failing operation was spawned under that root, which
// recorded its own line first.
function failureFixture(parent?: string): {
  report: SupportReport;
  query: SupportQueryResult;
  incident: SupportIncidentPrivateProjection;
} {
  const process = fixtureProcess(4343, "bbccddee");
  const spawned = parent === undefined ? {} : { parentCorrelationId: parent };
  writeFixtureSegment(stateDir, segmentIdentity(process, T0, 1), [
    ...(parent === undefined
      ? []
      : [fixtureLine(process, T0, { op: "client.diagnostic", correlationId: parent })]),
    fixtureLine(process, T0, {
      op: "gateway.chat.started",
      correlationId: CORRELATION,
      ...spawned,
      fields: {
        modelId: "test-model",
        costClass: "low",
        timeoutMs: 100,
        maxRetries: 0,
        requestBudgetMs: 100,
        upstreamStreaming: false,
        streaming: false,
      },
    }),
    fixtureLine(process, T0 + 1, {
      op: "gateway.chat.failed",
      correlationId: CORRELATION,
      ...spawned,
      errorKind: "timeout",
      level: "error",
      fields: { modelId: "test-model", streaming: false },
    }),
  ]);
  const created = recordRegisteredFailureIncident(
    stateDir,
    { op: "gateway.chat.failed", errorKind: "timeout", correlationId: CORRELATION, ...spawned },
    { nowMs: T0 + 2 },
  );
  if (created?.status !== "created") throw new TypeError("failure incident was not created");
  const incident = supportIncidentPrivateProjection(
    resolveSupportIncident(
      created.record,
      supportIncidentSegmentFiles(stateDir, created.record),
      stateDir,
    ),
  );
  const { result: query } = executeLocalSupportQuery(
    stateDir,
    {
      kind: "closure",
      queryClass: "incident",
      roots: [parent ?? CORRELATION],
      windows: [],
      requiredClasses: { kind: "observed-failures" },
      unresolved: false,
    },
    DEFAULT_SUPPORT_QUERY_LIMITS,
    { trigger: "export" },
  );
  return { report: buildSupportReport(incident, query), query, incident };
}

function withoutKey(
  record: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

// The lifetime account of a sender who keeps the selection consistent with the evidence it seals:
// a lifetime the evidence still shows keeps its declared start, and one never declared is accounted
// for by what its evidence carries.
function accountFor(
  events: ReturnType<typeof eventsOf>,
  declared: readonly SupportLifetimeProvenance[] = [],
): SupportLifetimeProvenance[] {
  const starts = new Map(declared.map((lifetime) => [lifetime.instanceId, lifetime.start]));
  const shown = new Map<string, SupportLifetimeProvenance>();
  for (const { record } of events) {
    const instanceId = String(record.instanceId);
    const started = record.op === "process.started" || shown.get(instanceId)?.start === "selected";
    shown.set(instanceId, {
      pid: Number(record.pid),
      instanceId,
      start: starts.get(instanceId) ?? (started ? "selected" : "absent"),
    });
  }
  return [...shown.values()].sort(
    (left, right) => left.pid - right.pid || left.instanceId.localeCompare(right.instanceId),
  );
}

function resealed(
  report: SupportReport,
  change: (events: ReturnType<typeof eventsOf>) => ReturnType<typeof eventsOf>,
  selection = report.selection,
): string {
  const events = change(eventsOf(report));
  return serializeSupportReport(
    sealSupportReport(
      report.incident,
      { ...selection, lifetimes: accountFor(events, selection.lifetimes) },
      encodeSupportReportEvidence(events),
    ),
  );
}

function withIncident(report: SupportReport, incident: Record<string, unknown>): string {
  return serializeSupportReport(
    sealSupportReport({ ...report.incident, ...incident }, report.selection, report.evidence),
  );
}

function evidenceText(text: string, recordCount = 1): SupportReport["evidence"] {
  return {
    encoding: "deflate-base64",
    rawBytes: Buffer.byteLength(text),
    recordCount,
    digest: supportReportDigest(text),
    payload: deflateSync(text).toString("base64"),
  };
}

describe("received-report audit hardening (#3534)", () => {
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-report-audit-"));
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("bounds containers, values and object keys before parsing a small expanding payload", () => {
    const report = fixture().report;
    const arrays = Math.ceil(MAX_SUPPORT_REPORT_CONTAINERS / MAX_SUPPORT_REPORT_RECORDS) + 1;
    const objects = `[${Array.from({ length: arrays }, () => `[${"{},".repeat(MAX_SUPPORT_REPORT_RECORDS - 1)}{}]`).join(",")}]`;
    const values = `[${Array.from({ length: Math.ceil(MAX_SUPPORT_REPORT_VALUES / MAX_SUPPORT_REPORT_RECORDS) + 1 }, () => `[${"0,".repeat(MAX_SUPPORT_REPORT_RECORDS - 1)}0]`).join(",")}]`;
    const keys = `{${Array.from({ length: MAX_SUPPORT_REPORT_OBJECT_KEYS + 1 }, (_, index) => `"k${String(index)}":0`).join(",")}}`;
    for (const bomb of [objects, values, keys]) {
      // Inside a resealed evidence section, and as the outer text itself.
      const hostile = sealSupportReport(report.incident, report.selection, evidenceText(bomb));
      expect(() => parseSupportReport(serializeSupportReport(hostile))).toThrow(
        expect.objectContaining({ reason: "report-budget-exceeded" }),
      );
      expect(() => parseCanonicalSupportJson(bomb, MAX_SUPPORT_REPORT_EVENT_BYTES)).toThrow(
        expect.objectContaining({ reason: "report-budget-exceeded" }),
      );
    }
  });

  it("applies one nesting bound to the writer and the parser", () => {
    const nested = (depth: number): unknown => (depth === 0 ? [] : [nested(depth - 1)]);
    const deepest = canonicalSupportJson(nested(MAX_SUPPORT_REPORT_DEPTH - 1));
    expect(parseCanonicalSupportJson(deepest, MAX_SUPPORT_REPORT_BYTES)).toEqual(
      nested(MAX_SUPPORT_REPORT_DEPTH - 1),
    );
    expect(() => canonicalSupportJson(nested(MAX_SUPPORT_REPORT_DEPTH))).toThrow(
      expect.objectContaining({ reason: "report-budget-exceeded" }),
    );
  });

  it.each(["\u200e", "\u200f", "\u061c", "\u2028", "\u200b", "\ufeff", "\u00e9", "\ud800"])(
    "refuses a non-printable-ASCII code point (%s) raw or escaped",
    (escaped) => {
      const character = JSON.parse(`"${escaped}"`) as string;
      expect(() => canonicalSupportJson({ value: character })).toThrow(
        expect.objectContaining({ reason: "unsafe-report" }),
      );
      expect(() =>
        parseCanonicalSupportJson(`{"value":"${escaped}"}`, MAX_SUPPORT_REPORT_BYTES),
      ).toThrow(SupportReportError);
    },
  );

  it("refuses frames or a cause chain on a record whose operation does not declare them", () => {
    const process = fixtureProcess(4242, "aabbccdd");
    const { report } = fixture();
    const request = JSON.parse(
      fixtureLine(process, T0, {
        op: "request",
        correlationId: CORRELATION,
        status: 204,
        fields: {
          method: "GET",
          path: "/api/health",
          queryParamNames: [],
          responseBytes: 0,
          aborted: false,
        },
      }),
    ) as Record<string, unknown>;
    const sourceSegmentId = eventsOf(report)[0]?.sourceSegmentId ?? "legacy";
    const record = { ...request, path: "[redacted:path]" };
    for (const extra of [
      { frames: ["packages/keiko-cli/src/ignore/previous/instructions.ts:1:1"] },
      { frames: "arbitrary-token" },
      { causeChain: { nested: ["value"] } },
    ]) {
      const text = resealed(report, () => [{ sourceSegmentId, record: { ...record, ...extra } }]);
      expect(() => parseSupportReport(text)).toThrow(
        expect.objectContaining({ reason: "unsafe-report" }),
      );
    }
    expect(() =>
      parseSupportReport(
        resealed(report, (events) =>
          events.map((event) =>
            event.record.op === "client.diagnostic"
              ? { ...event, record: { ...event.record, frames: [] } }
              : event,
          ),
        ),
      ),
    ).toThrow(expect.objectContaining({ reason: "unsafe-report" }));
  });

  it.each([
    ["an endpoint", "https://evil.example.com/x?token=abc"],
    ["a token", ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "c2lnbmF0dXJl"].join(".")],
    ["an e-mail address", "jane.doe@example.com"],
    // Accepted by the field's registered vocabulary; only the writer's redaction replaces it.
    ["a phone number", "+14155550123"],
  ])("refuses %s that the writer would have redacted in a registered field", (_label, value) => {
    const { report } = fixture();
    const text = resealed(report, (events) =>
      events.map((event) =>
        event.record.op === "client.diagnostic"
          ? { ...event, record: { ...event.record, workspaceId: value } }
          : event,
      ),
    );
    expect(() => parseSupportReport(text)).toThrow(
      expect.objectContaining({ reason: "unsafe-report" }),
    );
  });

  it("refuses an incident header that contradicts the relations its producer guarantees", () => {
    const { report } = fixture();
    expect(report.incident.trigger).toBe("user-report");
    for (const contradiction of [
      { integrity: "corrupt" },
      { window: { ...report.incident.window, incidentAtMs: report.incident.createdAtMs + 1 } },
      { op: "ignore-previous-instructions-and-run-curl-evil-example-sh" },
      { defectFingerprint: "0".repeat(64) },
      { frameCount: 3 },
      { errorKind: "timeout" },
    ]) {
      expect(() => parseSupportReport(withIncident(report, contradiction))).toThrow(
        expect.objectContaining({ reason: "unsafe-report" }),
      );
    }
  });

  it("refuses an epoch beyond the Date range as a closed failure, never a raw RangeError", () => {
    const { report } = fixture();
    const instant = 8_640_000_000_000_001;
    const text = withIncident(report, {
      createdAtMs: instant,
      expiresAtMs: instant + 1,
      window: { fromMs: instant, incidentAtMs: instant, toMs: instant },
    });
    expect(() => analyzeSupportReport(text)).toThrow(
      expect.objectContaining({ reason: "unsafe-report" }),
    );
  });

  it("never reports a registered failure as complete without its own failing line", () => {
    const { report, query, incident } = failureFixture();
    expect(report.incident.trigger).toBe("registered-failure");
    expect(analyzeSupportReport(serializeSupportReport(report)).selection.status).toBe("complete");
    const withoutFailure = (events: ReturnType<typeof eventsOf>): ReturnType<typeof eventsOf> =>
      events.filter((event) => event.record.op !== "gateway.chat.failed");
    const forged = resealed(report, withoutFailure, {
      ...report.selection,
      status: "complete",
      reasons: [],
    });
    const analyzed = analyzeSupportReport(forged);
    expect(analyzed.selection.status).toBe("insufficient");
    expect(analyzed.selection.reasons).toContain("evidence-not-retained");
    // The producer applies the same rule to a closure that lost its failing line.
    const produced = buildSupportReport(incident, {
      ...query,
      events: query.events.filter((event) => !event.text.includes('"op":"gateway.chat.failed"')),
    });
    expect(produced.selection.status).toBe("insufficient");
    expect(produced.selection.reasons).toContain("evidence-not-retained");
  });

  // Review #3679: a credential-shaped label passes the correlation grammar, but the writer would
  // have replaced it with its marker, so a received report carrying one is forged.
  it("refuses credential-shaped correlation labels a writer would have redacted", () => {
    const { report } = failureFixture();
    // Assembled at runtime so the secret scanner never sees a token literal.
    const token = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "c2lnbmF0dXJl"].join(".");
    const forgedLabel = resealed(report, (events) =>
      events.map((event, index) =>
        index === 0 ? { ...event, record: { ...event.record, parentCorrelationId: token } } : event,
      ),
    );
    expect(() => parseSupportReport(forgedLabel)).toThrow(
      expect.objectContaining({ reason: "unsafe-report" }),
    );
    const forgedReference = withIncident(report, {
      correlation: { rootCorrelationId: token, childCorrelationIds: [] },
    });
    expect(() => parseSupportReport(forgedReference)).toThrow(
      expect.objectContaining({ reason: "unsafe-report" }),
    );
  });

  // Review #3679: only the incident's own correlation binds its failing line. Another request's
  // failure of the same operation neither completes the incident nor refuses a genuine report.
  it("never takes another correlation's failure as the incident's own failing line", () => {
    const { report } = failureFixture();
    const other = "support-report-fixture-0002";
    const forged = resealed(
      report,
      (events) => {
        const [started, failed] = events;
        if (started === undefined || failed === undefined) throw new TypeError("missing lines");
        const seq = Number(failed.record.seq);
        return [
          started,
          { ...started, record: { ...started.record, correlationId: other, seq: seq + 1 } },
          {
            ...failed,
            record: { ...failed.record, correlationId: other, errorKind: "internal", seq: seq + 2 },
          },
        ];
      },
      { ...report.selection, status: "complete", reasons: [] },
    );
    const analyzed = analyzeSupportReport(forged);
    expect(analyzed.selection.status).toBe("insufficient");
    expect(analyzed.selection.reasons).toContain("evidence-not-retained");
  });

  // Review #3679: narrowing a report to one timeline or a seed never drops its known loss.
  it("keeps the report's loss reasons on every narrowed timeline and seed", () => {
    const { report } = failureFixture();
    const withoutFailure = analyzeSupportReport(
      resealed(report, (events) =>
        events.filter((event) => event.record.op !== "gateway.chat.failed"),
      ),
    );
    expect(withoutFailure.selection.reasons).toContain("evidence-not-retained");
    expect(
      supportReportTimeline(withoutFailure, report.incident.correlation.rootCorrelationId ?? "")
        ?.sufficiency,
    ).toMatchObject({
      status: "insufficient",
      reasons: expect.arrayContaining(["evidence-not-retained"]) as unknown,
    });
    expect(withoutFailure.seed?.sufficiency.status).toBe("insufficient");
    expect(prepareSupportReportSeed(withoutFailure)?.sufficiency.reasons).toContain(
      "evidence-not-retained",
    );
    const dropped = analyzeSupportReport(
      resealed(report, (events) => events, {
        status: "degraded",
        reasons: ["events-dropped"],
        requiredBytes: report.selection.requiredBytes,
        lifetimes: report.selection.lifetimes,
      }),
    );
    expect(
      supportReportTimeline(dropped, report.incident.correlation.rootCorrelationId ?? "")
        ?.sufficiency.reasons,
    ).toContain("events-dropped");
    expect(dropped.seed?.sufficiency.reasons).toContain("events-dropped");
  });

  // Review #3679: a parent timeline synthesized from its child's lines never proves the parent was
  // retained; every closure member needs a directly recorded line.
  it("never accepts a causal parent that only its child's lines imply", () => {
    const { report } = failureFixture();
    const parent = "support-report-parent-0001";
    const child = "support-report-child-0001";
    const text = serializeSupportReport(
      sealSupportReport(
        {
          ...report.incident,
          correlation: { rootCorrelationId: parent, childCorrelationIds: [child] },
        },
        { ...report.selection, status: "complete", reasons: [] },
        encodeSupportReportEvidence(
          eventsOf(report).map((event) => ({
            ...event,
            record: { ...event.record, correlationId: child, parentCorrelationId: parent },
          })),
        ),
      ),
    );
    const analyzed = analyzeSupportReport(text);
    expect(analyzed.selection.status).toBe("insufficient");
    expect(analyzed.selection.reasons).toEqual(
      expect.arrayContaining(["evidence-not-retained", "parent-correlation-missing"]),
    );
    expect(analyzed.seed?.sufficiency.status).toBe("insufficient");
  });

  // Review #3679: a registered incident's identity follows from its operation and its own failing
  // line through the producer's rules, so a header that contradicts them is forged.
  it("refuses a registered incident whose identity contradicts its own failing line", () => {
    const { report } = failureFixture();
    expect(parseSupportReport(serializeSupportReport(report)).incident.surface).toBe(
      "model-gateway",
    );
    for (const contradiction of [
      { surface: "ui" },
      { frameCount: 8 },
      { defectFingerprint: "0".repeat(64) },
    ]) {
      expect(() => parseSupportReport(withIncident(report, contradiction))).toThrow(
        expect.objectContaining({ reason: "unsafe-report" }),
      );
    }
  });

  it("states insufficiency when the failing line that fixes the identity is not retained", () => {
    const { report } = failureFixture();
    const text = serializeSupportReport(
      sealSupportReport(
        { ...report.incident, frameCount: 8 },
        report.selection,
        encodeSupportReportEvidence(
          eventsOf(report).filter((event) => event.record.op !== "gateway.chat.failed"),
        ),
      ),
    );
    const analyzed = analyzeSupportReport(text);
    expect(analyzed.selection.status).toBe("insufficient");
    expect(analyzed.selection.reasons).toContain("evidence-not-retained");
  });

  it("refuses a registered failure whose error kind contradicts its retained failing line", () => {
    const { report } = failureFixture();
    expect(() => parseSupportReport(withIncident(report, { errorKind: "internal" }))).toThrow(
      expect.objectContaining({ reason: "unsafe-report" }),
    );
    expect(() => parseSupportReport(withIncident(report, { op: "gateway.chat.started" }))).toThrow(
      expect.objectContaining({ reason: "unsafe-report" }),
    );
  });

  // Review #3679: the producer derives a spawned failure's root and child from its failing line, so
  // only that line's parent edge connects the declared child to the root the report selects.
  it("refuses a declared child whose own failing line no longer names its parent", () => {
    const parent = "support-report-parent-0002";
    const { report } = failureFixture(parent);
    expect(report.incident.correlation.rootCorrelationId).toMatch(/^id\d{6}$/u);
    expect(report.incident.correlation.childCorrelationIds).toHaveLength(1);
    expect(report.incident.correlation.childCorrelationIds[0]).toMatch(/^id\d{6}$/u);
    expect(analyzeSupportReport(serializeSupportReport(report)).selection.status).toBe("complete");
    const detached = resealed(report, (events) =>
      events.map((event) =>
        event.record.correlationId === report.incident.correlation.childCorrelationIds[0]
          ? { ...event, record: withoutKey(event.record, "parentCorrelationId") }
          : event,
      ),
    );
    expect(() => parseSupportReport(detached)).toThrow(
      expect.objectContaining({ reason: "unsafe-report" }),
    );
  });

  // Review #3679: a header naming the child without its root cannot come from any failing line, so
  // a received report carrying one is refused rather than validated as uncorrelated.
  it("refuses a declared child whose header omits its root", () => {
    const parent = "support-report-parent-0004";
    const { report } = failureFixture(parent);
    expect(analyzeSupportReport(serializeSupportReport(report)).selection.status).toBe("complete");
    expect(() =>
      parseSupportReport(
        withIncident(report, { correlation: { childCorrelationIds: [CORRELATION] } }),
      ),
    ).toThrow(expect.objectContaining({ reason: "unsafe-report" }));
  });

  // Review #3679: the root failing the same operation is another failure; it neither stands in for
  // the declared child's missing failing line nor refuses the report.
  it("never takes the root's failure of the same operation as its child's failing line", () => {
    const parent = "support-report-parent-0003";
    const { report } = failureFixture(parent);
    const rootFailure = resealed(
      report,
      (events) =>
        events.map((event) =>
          event.record.op === "gateway.chat.failed"
            ? {
                ...event,
                record: {
                  ...withoutKey(event.record, "parentCorrelationId"),
                  correlationId: report.incident.correlation.rootCorrelationId,
                },
              }
            : event,
        ),
      { ...report.selection, status: "complete", reasons: [] },
    );
    const analyzed = analyzeSupportReport(rootFailure);
    expect(analyzed.selection.status).toBe("insufficient");
    expect(analyzed.selection.reasons).toContain("evidence-not-retained");
  });

  // Review #3679: a report accounts for each lifetime's start, and the evidence must carry that
  // account. Dropping a selected start never reads as a lifetime that had none, before or after its
  // first heartbeat; a sender that declares it lost reads insufficient, and a heartbeat (written only
  // after a start) never sits beside a start declared absent.
  it.each([
    ["before its first heartbeat", false],
    ["after its first heartbeat", true],
  ])("refuses a report whose selected start was dropped %s", (_label, beat) => {
    const { report } = fixture(1, {}, undefined, (process) => [
      fixtureLine(process, T0 - 2, { op: "process.started" }),
      ...(beat ? [fixtureLine(process, T0 - 1, { op: "process.heartbeat" })] : []),
    ]);
    const started = report.selection.lifetimes.find((lifetime) => lifetime.pid === 4242);
    expect(started?.start).toBe("selected");
    expect(analyzeSupportReport(serializeSupportReport(report)).selection.status).toBe("complete");
    const withoutStart = (events: ReturnType<typeof eventsOf>): ReturnType<typeof eventsOf> =>
      events.filter((event) => event.record.op !== "process.started");
    const complete = { ...report.selection, status: "complete" as const, reasons: [] };
    expect(() => parseSupportReport(resealed(report, withoutStart, complete))).toThrow(
      expect.objectContaining({ reason: "unsafe-report" }),
    );
    const declaring = (start: "lost" | "absent"): string =>
      resealed(report, withoutStart, {
        ...complete,
        lifetimes: report.selection.lifetimes.map((lifetime) =>
          lifetime.pid === 4242 ? { ...lifetime, start } : lifetime,
        ),
      });
    const lost = analyzeSupportReport(declaring("lost"));
    expect(lost.selection.status).toBe("insufficient");
    expect(lost.selection.reasons).toContain("evidence-not-retained");
    if (beat) {
      expect(() => parseSupportReport(declaring("absent"))).toThrow(
        expect.objectContaining({ reason: "unsafe-report" }),
      );
    }
  });

  // Review #3679: the account names exactly the lifetimes the evidence shows, once each, in order.
  it("refuses a lifetime account that does not match its evidence", () => {
    const { report } = fixture();
    const [first] = report.selection.lifetimes;
    if (first === undefined) throw new TypeError("missing lifetime account");
    const sealWith = (lifetimes: readonly SupportLifetimeProvenance[]): string =>
      serializeSupportReport(
        sealSupportReport(
          report.incident,
          { ...report.selection, lifetimes },
          encodeSupportReportEvidence(eventsOf(report)),
        ),
      );
    for (const lifetimes of [
      report.selection.lifetimes.slice(1),
      [...report.selection.lifetimes, { pid: 1, instanceId: "00000001", start: "absent" as const }],
      [first, ...report.selection.lifetimes],
      report.selection.lifetimes.map((lifetime) => ({ ...lifetime, start: "selected" as const })),
    ]) {
      expect(() => parseSupportReport(sealWith(lifetimes))).toThrow(
        expect.objectContaining({ reason: "unsafe-report" }),
      );
    }
  });

  // Review #3679: a received report recomputes a lost start from its own evidence. A retained
  // heartbeat proves the start was written; without one, a lifetime the report shows with neither
  // its start nor a line of its first segment has no beginning it can stand on.
  it.each([
    ["a heartbeat it still holds", true],
    ["the beginning it cannot show", false],
  ])("recomputes a lost start from %s even when resealed complete", (_label, beat) => {
    const process = fixtureProcess(4545, "ccddeeff");
    const startup = writeFixtureSegment(stateDir, segmentIdentity(process, T0 - 600_000, 1), [
      fixtureLine(process, T0 - 600_000, { op: "process.started" }),
    ]);
    writeFixtureSegment(stateDir, segmentIdentity(process, T0 - 540_000, 2), [
      beat
        ? fixtureLine(process, T0 - 540_000, { op: "process.heartbeat" })
        : fixtureLine(process, T0 - 540_000, {
            op: "client.diagnostic",
            correlationId: "other-0001",
          }),
      fixtureLine(process, T0, { op: "client.diagnostic", correlationId: CORRELATION }),
    ]);
    rmSync(startup);
    const created = recordUserReportedIncident(stateDir, { nowMs: T0, correlationId: CORRELATION });
    if (created.status !== "created") throw new TypeError("incident fixture was not created");
    const incident = supportIncidentPrivateProjection(
      resolveSupportIncident(
        created.record,
        supportIncidentSegmentFiles(stateDir, created.record),
        stateDir,
      ),
    );
    const { result: query } = executeLocalSupportQuery(
      stateDir,
      {
        kind: "closure",
        queryClass: "incident",
        roots: [CORRELATION],
        windows: [],
        requiredClasses: { kind: "observed-failures" },
        unresolved: false,
      },
      { ...DEFAULT_SUPPORT_QUERY_LIMITS, contextMs: 0 },
      { trigger: "export" },
    );
    const report = buildSupportReport(incident, query);
    expect(report.selection.reasons).toContain("evidence-not-retained");
    expect(eventsOf(report).some((event) => event.record.op === "process.heartbeat")).toBe(beat);
    const forged = analyzeSupportReport(
      resealed(report, (events) => events, {
        ...report.selection,
        status: "complete",
        reasons: [],
      }),
    );
    expect(forged.selection.status).toBe("insufficient");
    expect(forged.selection.reasons).toContain("evidence-not-retained");
    expect(forged.seed?.sufficiency.status).toBe("insufficient");
  });

  // Review #3679: a start-less lifetime's first-segment line is what shows a receiver its beginning
  // held; dropping it leaves the report without that proof.
  it("keeps a start-less lifetime complete only while it shows its first segment", () => {
    const process = fixtureProcess(4646, "ddeeff00");
    writeFixtureSegment(stateDir, segmentIdentity(process, T0 - 2, 1), [
      fixtureLine(process, T0 - 2, { op: "client.diagnostic", correlationId: "other-0002" }),
    ]);
    writeFixtureSegment(stateDir, segmentIdentity(process, T0 - 1, 2), [
      fixtureLine(process, T0, { op: "client.diagnostic", correlationId: CORRELATION }),
    ]);
    const created = recordUserReportedIncident(stateDir, { nowMs: T0, correlationId: CORRELATION });
    if (created.status !== "created") throw new TypeError("incident fixture was not created");
    const incident = supportIncidentPrivateProjection(
      resolveSupportIncident(
        created.record,
        supportIncidentSegmentFiles(stateDir, created.record),
        stateDir,
      ),
    );
    const { result: query } = executeLocalSupportQuery(
      stateDir,
      {
        kind: "closure",
        queryClass: "incident",
        roots: [CORRELATION],
        windows: [],
        requiredClasses: { kind: "observed-failures" },
        unresolved: false,
      },
      { ...DEFAULT_SUPPORT_QUERY_LIMITS, contextMs: 0 },
      { trigger: "export" },
    );
    const report = buildSupportReport(incident, query);
    expect(report.selection.status).toBe("complete");
    expect(analyzeSupportReport(serializeSupportReport(report)).selection.status).toBe("complete");
    const withoutBeginning = analyzeSupportReport(
      resealed(report, (events) =>
        events.filter(
          (event) => event.record.pid !== 4646 || !event.sourceSegmentId.endsWith("-000001"),
        ),
      ),
    );
    expect(withoutBeginning.selection.status).toBe("insufficient");
    expect(withoutBeginning.selection.reasons).toContain("evidence-not-retained");
  });

  // Review #3679: a producer's confirmed drop (a seal's droppedEventCount) is the process losing
  // evidence, so every class of that lifetime reads it, the incident's own class included, as it
  // would a loss summary's process counters.
  it("attributes a seal's confirmed drop to the incident class of its lifetime", () => {
    const process = fixtureProcess(4747, "eeff0011");
    const chat = { modelId: "test-model", streaming: false };
    writeFixtureSegment(stateDir, segmentIdentity(process, T0, 1), [
      fixtureLine(process, T0, { op: "process.started" }),
      fixtureLine(process, T0, {
        op: "gateway.chat.started",
        correlationId: CORRELATION,
        fields: {
          ...chat,
          costClass: "low",
          timeoutMs: 100,
          maxRetries: 0,
          requestBudgetMs: 100,
          upstreamStreaming: false,
        },
      }),
      fixtureLine(process, T0, {
        op: "activity-log.segment.sealed",
        correlationId: "unknown-correlation-id",
        fields: {
          completeness: "partial",
          loss: "event-dropped",
          sealReason: "close",
          segmentIndex: 1,
          segmentFirstSeq: 1,
          segmentLastSeq: 3,
          segmentLineCount: 3,
          segmentBytes: 512,
          segmentDurationMs: 1,
          droppedEventCount: 1,
          segmentByteLimit: 1_048_576,
          segmentSecondsLimit: 3600,
        },
      }),
    ]);
    writeFixtureSegment(stateDir, segmentIdentity(process, T0 + 1, 2), [
      fixtureLine(process, T0 + 1, {
        op: "gateway.chat.failed",
        correlationId: CORRELATION,
        errorKind: "timeout",
        level: "error",
        fields: chat,
      }),
    ]);
    const created = recordRegisteredFailureIncident(
      stateDir,
      { op: "gateway.chat.failed", errorKind: "timeout", correlationId: CORRELATION },
      { nowMs: T0 + 2 },
    );
    if (created?.status !== "created") throw new TypeError("failure incident was not created");
    const incident = supportIncidentPrivateProjection(
      resolveSupportIncident(
        created.record,
        supportIncidentSegmentFiles(stateDir, created.record),
        stateDir,
      ),
    );
    const { result: query } = executeLocalSupportQuery(
      stateDir,
      {
        kind: "closure",
        queryClass: "incident",
        roots: [CORRELATION],
        windows: [],
        requiredClasses: { kind: "observed-failures" },
        unresolved: false,
      },
      DEFAULT_SUPPORT_QUERY_LIMITS,
      { trigger: "export" },
    );
    const report = buildSupportReport(incident, query);
    expect(
      eventsOf(report).some((event) => event.record.op === "activity-log.segment.sealed"),
    ).toBe(true);
    expect(report.selection.status).toBe("degraded");
    expect(report.selection.reasons).toContain("activity-log-loss");
    const analyzed = analyzeSupportReport(serializeSupportReport(report));
    expect(analyzed.selection.reasons).toContain("activity-log-loss");
  });

  it("keeps every supported record when one selected line belongs to another registry", () => {
    const { query, incident } = fixture(3);
    const original = query.events[0];
    if (original === undefined) throw new TypeError("missing selected event");
    const foreign = {
      ...original,
      text: original.text.replace(
        /"catalogDigest":"[a-f0-9]{64}"/u,
        `"catalogDigest":"${"e".repeat(64)}"`,
      ),
    };
    const mixed = buildSupportReport(incident, {
      ...query,
      events: [foreign, ...query.events],
    });
    expect(mixed.evidence.recordCount).toBe(query.events.length);
    expect(mixed.selection.reasons).toContain("unsupported-evidence");
    expect(
      analyzeSupportReport(serializeSupportReport(mixed)).analysis.evidence.supportedLineCount,
    ).toBe(query.events.length);
  });

  it("names retired bundles and raw Activity Log files as legacy input", () => {
    const { query } = fixture();
    for (const legacy of [
      `${JSON.stringify({ $section: "manifest", bundleSchemaVersion: 3 })}\n${query.events[0]?.text ?? ""}\n`,
      `${query.events.map((event) => event.text).join("\n")}\n`,
    ]) {
      expect(() => parseSupportReport(legacy)).toThrow(
        expect.objectContaining({ reason: "legacy-input" }),
      );
    }
  });

  it("fails each section guard closed with its own closed reason", () => {
    const { report } = fixture();
    const text = serializeSupportReport(report);
    const reseal = (evidence: SupportReport["evidence"]): string =>
      serializeSupportReport(sealSupportReport(report.incident, report.selection, evidence));
    const cases: readonly [string, string, string][] = [
      [
        "unknown kind",
        canonicalSupportJson({ ...report, kind: "keiko.support.other" }) + "\n",
        "unsupported-report",
      ],
      [
        "incident digest",
        text.replace(report.integrity.incidentDigest, "0".repeat(64)),
        "corrupt-report",
      ],
      [
        "report digest",
        text.replace(report.integrity.reportDigest, "0".repeat(64)),
        "corrupt-report",
      ],
      [
        "noncanonical base64",
        reseal({ ...report.evidence, payload: "A" + report.evidence.payload }),
        "corrupt-report",
      ],
      [
        "raw size",
        reseal({ ...report.evidence, rawBytes: report.evidence.rawBytes + 1 }),
        "corrupt-report",
      ],
      ["evidence digest", reseal({ ...report.evidence, digest: "0".repeat(64) }), "corrupt-report"],
      ["oversized text", `${" ".repeat(MAX_SUPPORT_REPORT_BYTES)}\n`, "report-budget-exceeded"],
      ["truncation", `${text.slice(0, Math.floor(text.length / 2))}\n`, "corrupt-report"],
    ];
    for (const [label, hostile, reason] of cases) {
      expect(() => parseSupportReport(hostile), label).toThrow(expect.objectContaining({ reason }));
    }
    // A record over its own bound, built past the producer's check that would refuse to write it.
    const oversized = eventsOf(report).map((event) => ({
      ...event,
      record: { ...event.record, workspaceId: "w".repeat(70_000) },
    }));
    const oversizedRecord = reseal(evidenceText(canonicalSupportJson(oversized), oversized.length));
    expect(() => parseSupportReport(oversizedRecord)).toThrow(
      expect.objectContaining({ reason: "unsafe-report" }),
    );
  });
});
