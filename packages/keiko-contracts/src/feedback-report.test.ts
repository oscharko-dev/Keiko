import { describe, expect, it } from "vitest";

import {
  FEEDBACK_PRIVACY_CONTRACT_VERSION,
  FEEDBACK_REDACTION_ENGINE_VERSION,
  FEEDBACK_REPORT_LIMITS,
  FEEDBACK_REPORT_SCHEMA_VERSION,
  parseFeedbackReportDraftV1,
  parseFeedbackReportV1,
} from "./feedback-report.js";

function validReport(): Record<string, unknown> {
  return {
    schemaVersion: FEEDBACK_REPORT_SCHEMA_VERSION,
    privacyContractVersion: FEEDBACK_PRIVACY_CONTRACT_VERSION,
    redactionProvenance: {
      engineVersion: FEEDBACK_REDACTION_ENGINE_VERSION,
      rules: [],
    },
    productVersion: "0.2.14",
    platform: "Linux",
    browserDescription: "Firefox 139",
    summary: {
      title: "Editor does not open",
      description: "The editor remains blank.",
    },
    steps: "1. Open Files\n2. Select a file",
    expectedResult: "The editor opens.",
    actualResult: "The editor remains blank.",
    impact: "Blocks core workflow",
    handwrittenEvidence: "Reproduces in a clean workspace.",
    attachments: ["Sanitized attachment text."],
    diagnostics: {
      category: "defect",
      featureArea: "editor",
      severityCounts: { errors: 1, warnings: 0, infos: 0 },
    },
  };
}

function validDraft(): Record<string, unknown> {
  return {
    schemaVersion: FEEDBACK_REPORT_SCHEMA_VERSION,
    category: "defect",
    title: "Title",
    description: "Description",
    reproductionSteps: "Steps",
    expectedBehavior: "Expected",
    actualBehavior: "Actual",
    productVersion: "0.2.14",
    platform: "Linux",
    featureArea: "editor",
    impact: "Unknown",
  };
}

function revokedRecord(): object {
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  return revocable.proxy;
}

function throwingField(record: Record<string, unknown>, field: string): Record<string, unknown> {
  Object.defineProperty(record, field, {
    enumerable: true,
    get: (): never => {
      throw new Error(`hostile ${field} getter`);
    },
  });
  return record;
}

class FeedbackBytesSubclass extends Uint8Array {}

function hostileFeedbackBytes(): Uint8Array {
  class HostileFeedbackBytes extends Uint8Array {}
  Object.defineProperty(HostileFeedbackBytes, Symbol.species, {
    get: (): never => {
      throw new Error("caller species must not run");
    },
  });
  const bytes = new HostileFeedbackBytes([65]);
  Object.defineProperty(bytes, "slice", {
    get: (): never => {
      throw new Error("caller slice must not run");
    },
  });
  return bytes;
}

describe("feedback report v1 contract", () => {
  it("accepts the closed canonical report shape", () => {
    const report = validReport();

    expect(parseFeedbackReportV1(report)).toEqual({ ok: true, value: report });
  });

  it.each([
    ["schema version", { schemaVersion: "2" }, "unsupported-version", "schemaVersion"],
    ["platform", { platform: "Solaris" }, "invalid-enum", "platform"],
    ["impact", { impact: "Catastrophic" }, "invalid-enum", "impact"],
    [
      "non-finite diagnostic count",
      {
        diagnostics: {
          category: "defect",
          featureArea: "editor",
          severityCounts: { errors: Number.NaN, warnings: 0, infos: 0 },
        },
      },
      "invalid-count",
      "diagnostics",
    ],
  ])("rejects an invalid %s", (_label, patch, code, field) => {
    expect(parseFeedbackReportV1({ ...validReport(), ...patch })).toEqual({
      ok: false,
      errors: [{ code, field }],
    });
  });

  it("rejects unknown fields without echoing their values", () => {
    const parsed = parseFeedbackReportV1({
      schemaVersion: FEEDBACK_REPORT_SCHEMA_VERSION,
      privacyContractVersion: FEEDBACK_PRIVACY_CONTRACT_VERSION,
      redactionProvenance: {
        engineVersion: FEEDBACK_REDACTION_ENGINE_VERSION,
        rules: [],
      },
      productVersion: "0.2.14",
      platform: "Linux",
      summary: { title: "Title", description: "Summary" },
      steps: "Steps",
      expectedResult: "Expected",
      actualResult: "Actual",
      impact: "Unknown",
      diagnostics: { category: "defect", featureArea: "editor" },
      rawEvidenceReference: "/private/customer/path",
    });

    expect(parsed).toEqual({
      ok: false,
      errors: [{ code: "unknown-field", field: "report" }],
    });
    expect(JSON.stringify(parsed)).not.toContain("/private/customer/path");
  });

  it.each([
    [
      "out-of-order provenance rules",
      [
        { code: "credential-shape", count: 1 },
        { code: "absolute-path", count: 1 },
      ],
      "invalid-shape",
    ],
    [
      "an unbounded provenance count",
      [{ code: "absolute-path", count: 256 * 1024 + 1 }],
      "invalid-count",
    ],
  ])("rejects %s", (_label, rules, code) => {
    const report = validReport();
    report.redactionProvenance = {
      engineVersion: FEEDBACK_REDACTION_ENGINE_VERSION,
      rules,
    };

    expect(parseFeedbackReportV1(report)).toEqual({
      ok: false,
      errors: [{ code, field: "redactionProvenance" }],
    });
  });

  it.each([
    ["unknown draft field", { rawEvidenceReference: "private-ref" }, "unknown-field", "report"],
    ["unknown category", { category: "security" }, "invalid-enum", "diagnostics"],
    [
      "non-finite diagnostics",
      { diagnostics: { errors: Number.POSITIVE_INFINITY, warnings: 0, infos: 0 } },
      "invalid-count",
      "diagnostics",
    ],
    [
      "attachment metadata",
      { attachments: [{ bytes: new Uint8Array([65]), filename: "secret.txt" }] },
      "unknown-field",
      "attachments",
    ],
  ])("rejects %s", (_label, patch, code, field) => {
    const draft = { ...validDraft(), ...patch };
    expect(parseFeedbackReportDraftV1(draft)).toEqual({
      ok: false,
      errors: [{ code, field }],
    });
  });

  it.each([
    ["ASCII media type", "declaredMediaType", `text/${"a".repeat(252)}`],
    ["multibyte media type", "declaredMediaType", `text/${"é".repeat(126)}`],
    ["ASCII extension", "extension", `.${"a".repeat(64)}`],
    ["multibyte extension", "extension", `.${"é".repeat(32)}`],
  ])("rejects an over-limit %s without echoing it", (_label, key, input) => {
    const parsed = parseFeedbackReportDraftV1({
      ...validDraft(),
      attachments: [{ bytes: new Uint8Array([65]), [key]: input }],
    });

    expect(parsed).toEqual({
      ok: false,
      errors: [{ code: "field-byte-limit", field: "attachments" }],
    });
    expect(JSON.stringify(parsed)).not.toContain(input);
  });

  it("accepts absent and exact-boundary attachment metadata", () => {
    const withoutMetadata = validDraft();
    const mediaTypePrefix = "text/";
    const declaredMediaType = `${mediaTypePrefix}${"a".repeat(
      FEEDBACK_REPORT_LIMITS.attachmentMediaTypeBytes - mediaTypePrefix.length,
    )}`;
    const extension = `.${"é".repeat(31)}a`;
    const atBoundary = {
      ...validDraft(),
      attachments: [
        {
          bytes: new Uint8Array([65]),
          declaredMediaType,
          extension,
        },
      ],
    };

    expect(new TextEncoder().encode(declaredMediaType)).toHaveLength(
      FEEDBACK_REPORT_LIMITS.attachmentMediaTypeBytes,
    );
    expect(new TextEncoder().encode(extension)).toHaveLength(
      FEEDBACK_REPORT_LIMITS.attachmentExtensionBytes,
    );
    expect(parseFeedbackReportDraftV1(withoutMetadata)).toEqual({
      ok: true,
      value: withoutMetadata,
    });
    expect(parseFeedbackReportDraftV1(atBoundary)).toEqual({ ok: true, value: atBoundary });
  });

  it.each([
    [
      "draft known getter",
      parseFeedbackReportDraftV1,
      (): unknown => throwingField(validDraft(), "title"),
    ],
    [
      "draft own-key proxy",
      parseFeedbackReportDraftV1,
      (): unknown =>
        new Proxy(validDraft(), {
          ownKeys: (): never => {
            throw new Error("hostile draft ownKeys");
          },
        }),
    ],
    ["draft revoked proxy", parseFeedbackReportDraftV1, revokedRecord],
    [
      "canonical known getter",
      parseFeedbackReportV1,
      (): unknown => throwingField(validReport(), "summary"),
    ],
    [
      "canonical own-key proxy",
      parseFeedbackReportV1,
      (): unknown =>
        new Proxy(validReport(), {
          ownKeys: (): never => {
            throw new Error("hostile report ownKeys");
          },
        }),
    ],
    ["canonical revoked proxy", parseFeedbackReportV1, revokedRecord],
  ])("fails closed for a %s", (_label, parse, input) => {
    expect(parse(input())).toEqual({
      ok: false,
      errors: [{ code: "invalid-shape", field: "report" }],
    });
  });

  it.each([
    [
      "summary",
      (): unknown => ({
        ...validReport(),
        summary: throwingField({ description: "Description" }, "title"),
      }),
      parseFeedbackReportV1,
      "summary",
    ],
    [
      "provenance",
      (): unknown => ({ ...validReport(), redactionProvenance: throwingField({}, "rules") }),
      parseFeedbackReportV1,
      "redactionProvenance",
    ],
    [
      "provenance rule",
      (): unknown => ({
        ...validReport(),
        redactionProvenance: {
          engineVersion: FEEDBACK_REDACTION_ENGINE_VERSION,
          rules: [throwingField({ count: 1 }, "code")],
        },
      }),
      parseFeedbackReportV1,
      "redactionProvenance",
    ],
    [
      "diagnostics",
      (): unknown => ({ ...validReport(), diagnostics: throwingField({}, "category") }),
      parseFeedbackReportV1,
      "diagnostics",
    ],
    [
      "severity counts",
      (): unknown => ({
        ...validReport(),
        diagnostics: {
          category: "defect",
          featureArea: "editor",
          severityCounts: throwingField({ warnings: 0, infos: 0 }, "errors"),
        },
      }),
      parseFeedbackReportV1,
      "diagnostics",
    ],
    [
      "attachment candidate",
      (): unknown => ({
        ...validDraft(),
        attachments: [throwingField({}, "bytes")],
      }),
      parseFeedbackReportDraftV1,
      "attachments",
    ],
  ])("fails closed for nested hostile %s data", (_label, input, parse, field) => {
    expect(parse(input())).toEqual({
      ok: false,
      errors: [{ code: "invalid-shape", field }],
    });
  });

  it("preflights the canonical attachment count before reading elements", () => {
    const attachments = ["safe", "safe", "safe", "safe"];
    Object.defineProperty(attachments, "0", {
      enumerable: true,
      get: (): never => {
        throw new Error("oversized attachment getter must not run");
      },
    });

    expect(parseFeedbackReportV1({ ...validReport(), attachments })).toEqual({
      ok: false,
      errors: [{ code: "attachment-count-limit", field: "attachments" }],
    });
  });

  it.each([
    ["plain Uint8Array", (): Uint8Array => new Uint8Array([65])],
    ["Uint8Array subclass", (): Uint8Array => new FeedbackBytesSubclass([65])],
    ["Node Buffer", (): Uint8Array => Buffer.from([65])],
    ["hostile slice/species subclass", hostileFeedbackBytes],
  ])("accepts a genuine %s via a plain defensive copy", (_label, source) => {
    const bytes = source();
    const parsed = parseFeedbackReportDraftV1({
      ...validDraft(),
      attachments: [{ bytes }],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const copied = parsed.value.attachments?.[0]?.bytes;
    expect(copied).toEqual(new Uint8Array([65]));
    expect(copied).not.toBe(bytes);
    expect(Object.getPrototypeOf(copied)).toBe(Uint8Array.prototype);
    bytes[0] = 90;
    expect(copied).toEqual(new Uint8Array([65]));
  });

  it.each([
    ["proxied Uint8Array", new Proxy(new Uint8Array([65]), {})],
    ["forged Uint8Array", Object.create(Uint8Array.prototype) as unknown],
    ["different typed array", new Uint16Array([65])],
  ])("rejects a %s attachment byte source", (_label, bytes) => {
    expect(parseFeedbackReportDraftV1({ ...validDraft(), attachments: [{ bytes }] })).toEqual({
      ok: false,
      errors: [{ code: "invalid-type", field: "attachments" }],
    });
  });
});
