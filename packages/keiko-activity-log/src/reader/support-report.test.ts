import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync, gunzipSync, inflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  supportIncidentPrivateProjection,
  type SupportReport,
  MAX_SUPPORT_REPORT_EVENT_BYTES,
  MAX_SUPPORT_REPORT_BYTES,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { recordUserReportedIncident, supportIncidentSegmentFiles } from "../support-incident.js";
import { resolveSupportIncident } from "../../../keiko-cli/src/support-incident.js";
import { executeSupportQuery } from "../../../keiko-cli/src/support-query-cli.js";
import {
  fixtureLine,
  fixtureProcess,
  segmentIdentity,
  writeFixtureSegment,
} from "../../../../tests/support/activity-log-segments.js";
import { selectedLogContent } from "./support-selective-export.js";
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
} from "./support-report.js";

const T0 = Date.UTC(2026, 8, 30, 12);
const CORRELATION = "support-report-fixture-0001";
let stateDir: string;

function fixture(
  count = 1,
  fields: Readonly<Record<string, unknown>> = {},
): { report: SupportReport; query: SupportQueryResult } {
  const process = fixtureProcess(4242, "aabbccdd");
  writeFixtureSegment(
    stateDir,
    segmentIdentity(process, T0, 1),
    Array.from({ length: count }, (_, index) =>
      fixtureLine(process, T0 + index, {
        op: "client.diagnostic",
        correlationId: CORRELATION,
        fields,
      }),
    ),
  );
  const created = recordUserReportedIncident(stateDir, { nowMs: T0, correlationId: CORRELATION });
  if (created.status !== "created") throw new TypeError("incident fixture was not created");
  const record = created.record;
  const incident = supportIncidentPrivateProjection(
    resolveSupportIncident(record, supportIncidentSegmentFiles(stateDir, record), stateDir),
  );
  const { result: query } = executeSupportQuery(
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
  return { report: buildSupportReport(incident, query), query };
}

describe("canonical body-free offline report", () => {
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-support-report-"));
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
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

  it("keeps the selective reader projection at its owning public entry point", () => {
    const { query } = fixture(2);
    const selected = selectedLogContent(query);
    expect(selected.contentLines).toEqual(query.events.map((event) => event.text));
    expect(selected.sourceLogFileLines.reduce((sum, file) => sum + file.lineCount, 0)).toBe(
      query.events.length,
    );
    expect(selected.sourceLogFiles).toEqual([
      ...new Set(query.events.map((event) => event.file.name)),
    ]);
    expect(selected.selection.query).not.toHaveProperty("events");
    expect(selected.terminalFragment).toBe(false);
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
    expect(() => analyzeSupportReport(serializeSupportReport(forged))).toThrow(SupportReportError);
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
    const { report, query } = fixture();
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
    const safe = buildSupportReport(report.incident, {
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
    const { report, query } = fixture();
    const reduced = buildSupportReport(report.incident, query, 4000);
    expect(Buffer.byteLength(serializeSupportReport(reduced))).toBeLessThanOrEqual(4000);
    if (reduced.evidence.recordCount === 0) {
      expect(reduced.selection.status).toBe("insufficient");
      expect(reduced.selection.reasons).toContain("report-budget-exceeded");
    }
    expect(() => buildSupportReport(report.incident, query, 1)).toThrow(SupportReportError);
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
  it("refuses an unknown registry with valid integrity instead of using its own catalog", () => {
    const report = fixture().report;
    const incident = {
      ...report.incident,
      build: { ...report.incident.build, catalogDigest: "f".repeat(64) },
    };
    const hostile = sealSupportReport(incident, report.selection, report.evidence);
    expect(() => analyzeSupportReport(serializeSupportReport(hostile))).toThrow(
      expect.objectContaining({ reason: "unsupported-report" }),
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
  it("refuses a forged complete verdict over an absent closure", () => {
    const report = fixture().report;
    const hostile = sealSupportReport(
      report.incident,
      { ...report.selection, status: "complete", reasons: [] },
      encodeSupportReportEvidence([]),
    );
    expect(() => parseSupportReport(serializeSupportReport(hostile))).toThrow(
      expect.objectContaining({ reason: "corrupt-report" }),
    );
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
    const text = JSON.stringify(eventsOf(report)).replace(CORRELATION, `${CORRELATION}\\u001b`);
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
    const { report, query } = fixture();
    for (const max of [MAX_SUPPORT_REPORT_BYTES + 1, NaN, Infinity, 0, -1, 1.5]) {
      expect(() => buildSupportReport(report.incident, query, max)).toThrow(
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
    const records = frozen.files
      .filter((file) => file.name.endsWith(".jsonl"))
      .flatMap((file) =>
        Buffer.from(file.bytes, "base64")
          .toString()
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      );
    const first = records[0];
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
      report.selection,
      encodeSupportReportEvidence(records.map((record) => ({ sourceSegmentId: "legacy", record }))),
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
