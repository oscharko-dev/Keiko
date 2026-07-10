import { describe, expect, it } from "vitest";

import {
  FEEDBACK_ATTACHMENT_MAGIC_TABLE_VERSION,
  FEEDBACK_REPORT_LIMITS,
  FEEDBACK_REPORT_SCHEMA_VERSION,
  type FeedbackReportDraftV1,
} from "@oscharko-dev/keiko-contracts/feedback-report";

import { prepareFeedbackReportV1 } from "./feedback-report.js";
import { prepareFeedbackAttachment } from "./feedback-report-attachment.js";
import { EMPTY_FEEDBACK_REPORT_REDACTION_POLICY_V1 } from "./feedback-report-policy.js";

function validDraft(overrides: Partial<FeedbackReportDraftV1> = {}): FeedbackReportDraftV1 {
  return {
    schemaVersion: FEEDBACK_REPORT_SCHEMA_VERSION,
    category: "defect",
    title: "Editor does not open",
    description: "The editor remains blank.",
    reproductionSteps: "1. Open Files\n2. Select a file",
    expectedBehavior: "The editor opens.",
    actualBehavior: "The editor remains blank.",
    productVersion: "0.2.14",
    platform: "Linux",
    featureArea: "editor",
    browserDescription: "Firefox 139",
    impact: "Blocks core workflow",
    diagnostics: { errors: 1, warnings: 0, infos: 0 },
    handwrittenEvidence: "Reproduces in a clean workspace.",
    ...overrides,
  };
}

const ascii = (value: string): readonly number[] => [...new TextEncoder().encode(value)];
const magicCases: readonly (readonly [string, readonly number[]])[] = [
  ["PDF", ascii("%PDF-")],
  ["PNG", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ["JPEG", [0xff, 0xd8, 0xff]],
  ["GIF87a", ascii("GIF87a")],
  ["GIF89a", ascii("GIF89a")],
  ["BMP", ascii("BM")],
  ["TIFF little endian", [0x49, 0x49, 0x2a, 0x00]],
  ["TIFF big endian", [0x4d, 0x4d, 0x00, 0x2a]],
  ["WebP", [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")]],
  ["SVG", ascii("<svg")],
  ["ZIP local", [0x50, 0x4b, 0x03, 0x04]],
  ["ZIP empty", [0x50, 0x4b, 0x05, 0x06]],
  ["ZIP spanning", [0x50, 0x4b, 0x07, 0x08]],
  ["gzip", [0x1f, 0x8b]],
  ["RAR4", [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]],
  ["RAR5", [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]],
  ["7z", [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
  ["ELF", [0x7f, 0x45, 0x4c, 0x46]],
  ["PE MZ", ascii("MZ")],
  ["Mach-O 32", [0xfe, 0xed, 0xfa, 0xce]],
  ["Mach-O 64 little endian", [0xcf, 0xfa, 0xed, 0xfe]],
  ["Mach-O fat", [0xca, 0xfe, 0xba, 0xbe]],
];

describe("prepareFeedbackReportV1 attachment predicate", () => {
  it("decodes a BOM-prefixed UTF-8 attachment and omits all source metadata", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("safe\r\ntext")]);
    const prepared = prepareFeedbackReportV1(
      validDraft({
        attachments: [{ bytes, declaredMediaType: "text/plain", extension: ".txt" }],
      }),
    );

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.report.attachments).toEqual(["safe\ntext"]);
    expect(prepared.value.canonicalJson).not.toContain("declaredMediaType");
    expect(prepared.value.canonicalJson).not.toContain("extension");
    expect(prepared.value.canonicalJson).not.toContain("bytes");
  });

  it("rejects a second leading UTF-8 BOM instead of silently stripping it", () => {
    const bom = [0xef, 0xbb, 0xbf] as const;
    const bytes = new Uint8Array([...bom, ...bom, ...ascii("safe text")]);

    expect(prepareFeedbackReportV1(validDraft({ attachments: [{ bytes }] }))).toEqual({
      ok: false,
      errors: [{ code: "unsafe-format-character", field: "attachments" }],
    });
  });

  it("rejects an embedded UTF-8 BOM as an unsafe format character", () => {
    const bytes = new Uint8Array([...ascii("safe"), 0xef, 0xbb, 0xbf, ...ascii("text")]);

    expect(prepareFeedbackReportV1(validDraft({ attachments: [{ bytes }] }))).toEqual({
      ok: false,
      errors: [{ code: "unsafe-format-character", field: "attachments" }],
    });
  });

  it("pins the known attachment-magic table at v1", () => {
    expect(FEEDBACK_ATTACHMENT_MAGIC_TABLE_VERSION).toBe("1");
  });

  it("rejects malformed UTF-8 attachment bytes", () => {
    const bytes = new Uint8Array([0xc3, 0x28]);
    expect(prepareFeedbackReportV1(validDraft({ attachments: [{ bytes }] }))).toEqual({
      ok: false,
      errors: [{ code: "invalid-utf8", field: "attachments" }],
    });
  });

  it.each(magicCases)("rejects %s attachment magic before decoding", (_label, signature) => {
    const bytes = new Uint8Array([...signature, ...ascii(" trailing text")]);
    expect(prepareFeedbackReportV1(validDraft({ attachments: [{ bytes }] }))).toEqual({
      ok: false,
      errors: [{ code: "binary-signature", field: "attachments" }],
    });
  });

  it("detects binary magic immediately after an optional UTF-8 BOM", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...ascii("%PDF-1.7")]);
    expect(prepareFeedbackReportV1(validDraft({ attachments: [{ bytes }] }))).toEqual({
      ok: false,
      errors: [{ code: "binary-signature", field: "attachments" }],
    });
  });

  it("applies the binary-signature predicate to typed prose fields too", () => {
    expect(prepareFeedbackReportV1(validDraft({ description: "%PDF-1.7" }))).toEqual({
      ok: false,
      errors: [{ code: "binary-signature", field: "summary.description" }],
    });
  });

  it.each([
    ["UTF-16LE", [0xff, 0xfe, 0x61, 0x00]],
    ["UTF-16BE", [0xfe, 0xff, 0x00, 0x61]],
    ["UTF-32LE", [0xff, 0xfe, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00]],
    ["UTF-32BE", [0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x61]],
  ])("rejects a %s attachment BOM", (_label, values) => {
    const bytes = new Uint8Array(values);
    expect(prepareFeedbackReportV1(validDraft({ attachments: [{ bytes }] }))).toEqual({
      ok: false,
      errors: [{ code: "invalid-utf8", field: "attachments" }],
    });
  });

  it.each([
    ["binary MIME", { declaredMediaType: "application/pdf" }, "unsupported-media-type"],
    ["image MIME", { declaredMediaType: "image/png" }, "unsupported-media-type"],
    [
      "JSON-prefix binary MIME",
      { declaredMediaType: "application/json-binary" },
      "unsupported-media-type",
    ],
    ["archive extension", { extension: ".zip" }, "unsupported-extension"],
    ["filename-shaped archive extension", { extension: "report.zip" }, "unsupported-extension"],
    ["raw-log extension", { extension: ".log" }, "unsupported-extension"],
  ])("rejects a %s negative signal", (_label, metadata, code) => {
    const bytes = new TextEncoder().encode("otherwise safe text");
    expect(prepareFeedbackReportV1(validDraft({ attachments: [{ bytes, ...metadata }] }))).toEqual({
      ok: false,
      errors: [{ code, field: "attachments" }],
    });
  });

  it.each([
    [
      "media type",
      { declaredMediaType: `text/${"x".repeat(FEEDBACK_REPORT_LIMITS.attachmentMediaTypeBytes)}` },
    ],
    ["extension", { extension: "x".repeat(FEEDBACK_REPORT_LIMITS.attachmentExtensionBytes + 1) }],
  ])("rejects oversized transient %s metadata before normalization", (_label, metadata) => {
    const result = prepareFeedbackAttachment(
      { bytes: new TextEncoder().encode("safe text"), ...metadata },
      EMPTY_FEEDBACK_REPORT_REDACTION_POLICY_V1,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "field-byte-limit", field: "attachments" },
    });
  });

  it("rejects stack-trace attachment records", () => {
    const bytes = new TextEncoder().encode("at first (/a.ts:1:2)\nat second (/b.ts:3:4)");
    expect(prepareFeedbackReportV1(validDraft({ attachments: [{ bytes }] }))).toEqual({
      ok: false,
      errors: [{ code: "raw-log-content", field: "attachments" }],
    });
  });
});
