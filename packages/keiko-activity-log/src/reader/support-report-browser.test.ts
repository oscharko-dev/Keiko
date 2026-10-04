import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildSupportReportEnvelope,
  canonicalSupportJson,
  clientOnlySupportReportSections,
  EMPTY_SUPPORT_REPORT_EVIDENCE,
  parseCanonicalSupportJson,
  parseSupportIncidentPrivateProjection,
  sealSupportReportEnvelope,
  serializeSupportReport,
  supportIncidentPrivateProjection,
  SupportReportError,
  type SupportReport,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { prepareUnretainedUserReportDescriptor } from "../support-incident.js";
import { createClientOnlySupportReport } from "./support-desktop-report.js";
import { resolveSelectedSupportIncident } from "./support-incident-resolution.js";
import { ActivityLogScanner, ensureSegmentManifests } from "./support-segment-scan.js";
import { DEFAULT_SUPPORT_QUERY_LIMITS, runSupportQuery } from "./support-query.js";
import {
  analyzeSupportReport,
  buildSupportReport,
  encodeSupportReportEvidence,
  parseSupportReport,
  supportReportDigest,
} from "./support-report.js";

function legacyClientOnlyReport(): SupportReport {
  const descriptor = prepareUnretainedUserReportDescriptor("opaque-client-correlation");
  const scanner = new ActivityLogScanner("");
  const pass = ensureSegmentManifests("", [], scanner, {
    trigger: "export",
    persist: false,
    rebuild: false,
  });
  const query = runSupportQuery({
    files: [],
    scanner,
    manifests: pass.manifests,
    manifestStats: pass.stats,
    selection: {
      kind: "closure",
      queryClass: "correlation",
      roots: [],
      windows: [],
      requiredClasses: { kind: "observed" },
      unresolved: false,
    },
    limits: DEFAULT_SUPPORT_QUERY_LIMITS,
  });
  const incident = supportIncidentPrivateProjection(
    resolveSelectedSupportIncident(descriptor, query),
  );
  return buildSupportReport(
    {
      ...incident,
      clientReport: { serverEvidence: "unavailable", availabilityReason: "session-unavailable" },
    },
    query,
  );
}

async function browserDigest(text: string): Promise<string> {
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function browserReport(reference: SupportReport): Promise<SupportReport> {
  const sections = clientOnlySupportReportSections({
    incidentId: reference.incident.incidentId,
    nowMs: reference.incident.createdAtMs,
    build: reference.incident.build,
    defectFingerprint: reference.incident.defectFingerprint,
    availabilityReason: "session-unavailable",
  });
  const unsigned = buildSupportReportEnvelope(
    sections.incident,
    sections.selection,
    sections.evidence,
    {
      incidentDigest: await browserDigest(canonicalSupportJson(sections.incident)),
      selectionDigest: await browserDigest(canonicalSupportJson(sections.selection)),
      evidenceDigest: await browserDigest(canonicalSupportJson(sections.evidence)),
    },
  );
  return sealSupportReportEnvelope(unsigned, await browserDigest(canonicalSupportJson(unsigned)));
}

describe("shared canonical browser report producer", () => {
  it("preserves the prior Node descriptor, query, privacy and envelope bytes", async () => {
    const reference = legacyClientOnlyReport();
    const report = await browserReport(reference);
    expect(serializeSupportReport(report)).toBe(serializeSupportReport(reference));
    const parsed = parseSupportReport(serializeSupportReport(report));
    expect(parsed.evidence.recordCount).toBe(0);
    expect(analyzeSupportReport(serializeSupportReport(report)).selection.status).toBe(
      "insufficient",
    );
    expect(serializeSupportReport(report)).not.toContain("opaque-client-correlation");
  });

  it("uses the actual Node encoder's empty canonical payload", () => {
    expect(EMPTY_SUPPORT_REPORT_EVIDENCE).toEqual(encodeSupportReportEvidence([]));
  });

  it.each([
    "session-unavailable",
    "diagnostic-delivery-unavailable",
    "service-unavailable",
  ] as const)("admits only limited zero-server evidence for %s", (reason) => {
    const report = parseSupportReport(createClientOnlySupportReport(undefined, reason).reportJson);
    expect(parseSupportIncidentPrivateProjection(report.incident)).toBeDefined();
    expect(report.incident.clientReport?.availabilityReason).toBe(reason);
    expect(report.incident.segments).toEqual([]);
    expect(report.incident.lineCount).toBe(0);
    expect(report.selection.status).toBe("insufficient");
  });

  it("rejects unsafe factory inputs without filtering or leaking them", () => {
    const reference = legacyClientOnlyReport().incident;
    const input = {
      incidentId: reference.incidentId,
      nowMs: reference.createdAtMs,
      build: reference.build,
      defectFingerprint: reference.defectFingerprint,
      availabilityReason: "service-unavailable" as const,
    };
    expect(() =>
      clientOnlySupportReportSections({ ...input, incidentId: "customer/path" }),
    ).toThrow(SupportReportError);
    expect(() => clientOnlySupportReportSections({ ...input, nowMs: Number.NaN })).toThrow(
      SupportReportError,
    );
    expect(() =>
      clientOnlySupportReportSections({
        ...input,
        build: { ...input.build, platformClass: "host\nname" },
      }),
    ).toThrow(SupportReportError);
  });

  it.each(["ascii", "é", "😀", "\ud800"])(
    "charges UTF-8 bytes identically to Node for %s",
    (value) => {
      const text = JSON.stringify(value);
      const bytes = Buffer.byteLength(text);
      expect(new TextEncoder().encode(text).byteLength).toBe(bytes);
      expect(() => parseCanonicalSupportJson(text, bytes - 1)).toThrow("report-budget-exceeded");
    },
  );

  it("keeps strict canonical parsing and digest rejection", async () => {
    const report = await browserReport(legacyClientOnlyReport());
    const canonical = serializeSupportReport(report);
    expect(supportReportDigest(canonicalSupportJson(report.incident))).toBe(
      report.integrity.incidentDigest,
    );
    expect(() => parseSupportReport(canonical.replace('"complete"', '"partial"'))).toThrow(
      SupportReportError,
    );
    expect(() => parseSupportReport(` ${canonical}`)).toThrow(SupportReportError);
    expect(() => parseSupportReport(canonical.replace('"candidate"', '"candi\\u0064ate"'))).toThrow(
      SupportReportError,
    );
  });
});

describe("client-only original failure attribution", () => {
  it("preserves a real original correlation and closed client failure through the strict parser", () => {
    const reference = legacyClientOnlyReport();
    const input = {
      incidentId: reference.incident.incidentId,
      nowMs: reference.incident.createdAtMs,
      build: reference.incident.build,
      defectFingerprint: reference.incident.defectFingerprint,
      availabilityReason: "service-unavailable" as const,
      correlationId: "failed-request-original-123",
      failure: {
        errorKind: "permission-denied" as const,
        errorEvidence: { errorClass: "ApiError", frames: [], causeChain: [] },
        context: ["stage:files-directory-load"],
      },
    };
    const sections = clientOnlySupportReportSections(input);
    const unsigned = buildSupportReportEnvelope(
      sections.incident,
      sections.selection,
      sections.evidence,
      {
        incidentDigest: supportReportDigest(canonicalSupportJson(sections.incident)),
        selectionDigest: supportReportDigest(canonicalSupportJson(sections.selection)),
        evidenceDigest: supportReportDigest(canonicalSupportJson(sections.evidence)),
      },
    );
    const sealed = sealSupportReportEnvelope(
      unsigned,
      supportReportDigest(canonicalSupportJson(unsigned)),
    );
    const parsed = parseSupportReport(serializeSupportReport(sealed));
    expect(parsed.incident.correlation.rootCorrelationId).toBe(input.correlationId);
    expect(parsed.incident.clientReport?.failure).toEqual(input.failure);
    const analyzed = analyzeSupportReport(serializeSupportReport(sealed));
    expect(analyzed.incident.correlation.rootCorrelationId).toBe(input.correlationId);
    expect(analyzed.incident.clientReport?.failure).toEqual(input.failure);
    expect(analyzed.selection.status).toBe("insufficient");
    expect(analyzed.analysis.evidence.supportedLineCount).toBe(0);
    expect(parsed.incident.sufficiencyStatus).toBe("insufficient");
    expect(parsed.evidence.recordCount).toBe(0);
  });
});

it("rejects private or malformed client failure fields instead of filtering them", () => {
  const reference = legacyClientOnlyReport().incident;
  const base = {
    incidentId: reference.incidentId,
    nowMs: reference.createdAtMs,
    build: reference.build,
    defectFingerprint: reference.defectFingerprint,
    availabilityReason: "service-unavailable" as const,
  };
  const evidence = { errorClass: "ApiError", frames: [], causeChain: [] };
  for (const failure of [
    {
      errorKind: "permission-denied" as const,
      errorEvidence: evidence,
      context: ["/private/customer"],
    },
    {
      errorKind: "permission-denied" as const,
      errorEvidence: { ...evidence, errorClass: "PrivateCustomerClass" },
      context: [],
    },
    {
      errorKind: "permission-denied" as const,
      errorEvidence: { ...evidence, frames: ["/private/customer/file.ts:1:2"] },
      context: [],
    },
    {
      errorKind: "permission-denied" as const,
      errorEvidence: { ...evidence, message: "private customer text" },
      context: [],
    },
  ])
    expect(() => clientOnlySupportReportSections({ ...base, failure })).toThrow(SupportReportError);
  expect(() =>
    clientOnlySupportReportSections({ ...base, correlationId: "/private/customer" }),
  ).toThrow(SupportReportError);
});
