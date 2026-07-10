import { describe, expect, it } from "vitest";

import {
  FEEDBACK_REPORT_SCHEMA_VERSION,
  FEEDBACK_REPORT_LIMITS,
  parseFeedbackReportV1,
  type FeedbackReportDraftV1,
} from "@oscharko-dev/keiko-contracts/feedback-report";

import { canonicalise, sha256Hex } from "./hashing.js";
import { prepareFeedbackReportV1 } from "./feedback-report.js";

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

describe("prepareFeedbackReportV1", () => {
  it.each([
    [
      "known-field getter",
      Object.defineProperty(validDraft(), "title", {
        enumerable: true,
        get: (): never => {
          throw new Error("private getter detail");
        },
      }),
    ],
    [
      "own-key trap",
      new Proxy(
        {},
        {
          ownKeys: (): never => {
            throw new Error("private proxy detail");
          },
        },
      ),
    ],
  ])("fails closed for a draft %s", (_label, draft) => {
    expect(prepareFeedbackReportV1(draft)).toEqual({
      ok: false,
      errors: [{ code: "invalid-shape", field: "report" }],
    });
  });

  it("fails closed for a revoked draft proxy", () => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    expect(prepareFeedbackReportV1(revocable.proxy)).toEqual({
      ok: false,
      errors: [{ code: "invalid-shape", field: "report" }],
    });
  });

  it("projects the draft into deterministic canonical bytes and an external digest", () => {
    const prepared = prepareFeedbackReportV1(validDraft());
    const repeated = prepareFeedbackReportV1(validDraft());
    expect(prepared.ok).toBe(true);
    expect(repeated.ok).toBe(true);
    if (!prepared.ok) return;
    if (!repeated.ok) return;

    expect(prepared.value.report.summary).toEqual({
      title: "Editor does not open",
      description: "The editor remains blank.",
    });
    expect(prepared.value.report.steps).toBe("1. Open Files\n2. Select a file");
    expect(prepared.value.report.diagnostics).toEqual({
      category: "defect",
      featureArea: "editor",
      severityCounts: { errors: 1, warnings: 0, infos: 0 },
    });
    expect(prepared.value.canonicalJson).toBe(canonicalise(prepared.value.report));
    expect(new TextDecoder().decode(prepared.value.canonicalBody.copyBytes())).toBe(
      prepared.value.canonicalJson,
    );
    expect(prepared.value.exactBodySha256).toBe(sha256Hex(prepared.value.canonicalJson));
    expect(prepared.value.canonicalJson).toBe(repeated.value.canonicalJson);
    expect(prepared.value.canonicalBody.copyBytes()).toEqual(
      repeated.value.canonicalBody.copyBytes(),
    );
    expect(prepared.value.exactBodySha256).toBe(repeated.value.exactBodySha256);
    expect(parseFeedbackReportV1(prepared.value.report).ok).toBe(true);
    expect(prepared.value.report).not.toHaveProperty("title");
    expect(prepared.value.report).not.toHaveProperty("description");
    expect(prepared.value.report).not.toHaveProperty("reproductionSteps");
    expect(prepared.value.report).not.toHaveProperty("exactBodySha256");
  });

  it("redacts supported secrets and absolute paths in every outbound prose field", () => {
    const token = ["sk-", "A".repeat(24)].join("");
    const prepared = prepareFeedbackReportV1(
      validDraft({
        title: `Token ${token}`,
        description: "Opened /tmp and file:///Users/alice/private.txt",
        reproductionSteps: `Use ${token} from C:\\Secrets`,
        expectedBehavior: "No /Users/alice path is shown",
        actualBehavior: `Bearer ${token}`,
        productVersion: `build ${token}`,
        browserDescription: "Firefox from /Applications/Firefox.app",
        handwrittenEvidence: "Stored under /var/log/private.log",
        attachments: [
          {
            bytes: new TextEncoder().encode(`Attachment ${token} at /opt/private.txt`),
          },
        ],
      }),
    );

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const serialized = prepared.value.canonicalJson;
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("/Users/alice");
    expect(serialized).not.toContain("C:\\\\Secrets");
    expect(serialized).not.toContain("file:///");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("[REDACTED_PATH]");
    expect(prepared.value.report.redactionProvenance.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "absolute-path" }),
        expect.objectContaining({ code: "credential-shape" }),
      ]),
    );
    for (const rule of prepared.value.report.redactionProvenance.rules) {
      expect(Object.keys(rule).sort()).toEqual(["code", "count"]);
    }
  });

  it("counts each absolute-path occurrence without recording matched content", () => {
    const prepared = prepareFeedbackReportV1(
      validDraft({ description: "First /tmp\nSecond C:\\Secrets\nThird file:///Users/a/file" }),
    );

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.report.redactionProvenance.rules).toContainEqual({
      code: "absolute-path",
      count: 3,
    });
    expect(JSON.stringify(prepared.value.report.redactionProvenance)).not.toContain("/tmp");
    expect(JSON.stringify(prepared.value.report.redactionProvenance)).not.toContain("Secrets");
  });

  it("never preserves the body following an unmatched PEM begin marker", () => {
    const begin = "-----BEGIN RSA " + "PRIVATE KEY-----";
    const body = "MIIEvQIBADAN-sensitive-key-body";
    const prepared = prepareFeedbackReportV1(
      validDraft({ description: `Context\n${begin}\n${body}` }),
    );

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.canonicalJson).not.toContain(body);
    expect(prepared.value.report.redactionProvenance.rules).toContainEqual({
      code: "credential-shape",
      count: 1,
    });
  });

  it("redacts supported IBAN/phone values and rejects residual labeled tax IDs", () => {
    const redacted = prepareFeedbackReportV1(
      validDraft({
        description: "IBAN DE89 3704 0044 0532 0130 00, phone +49 30 1234567",
      }),
    );
    expect(redacted.ok).toBe(true);
    if (redacted.ok) {
      expect(redacted.value.canonicalJson).not.toContain("DE89 3704");
      expect(redacted.value.canonicalJson).not.toContain("+49 30");
      expect(redacted.value.report.redactionProvenance.rules).toContainEqual({
        code: "personal-identifier",
        count: 2,
      });
    }

    expect(
      prepareFeedbackReportV1(validDraft({ description: "Steuer-ID: 12 345 678 901" })),
    ).toEqual({
      ok: false,
      errors: [{ code: "residual-sensitive-content", field: "summary.description" }],
    });
  });

  it("accepts a generic credential assignment after replacing only its value", () => {
    const prepared = prepareFeedbackReportV1(
      validDraft({ description: "X-API-Key: opaque-key-value" }),
    );

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.report.summary.description).toContain("X-API-Key: [REDACTED]");
    expect(prepared.value.report.redactionProvenance.rules).toContainEqual({
      code: "credential-assignment",
      count: 1,
    });
  });

  it("normalizes CR line endings and rejects unsafe scalar/control/format input", () => {
    const normalized = prepareFeedbackReportV1(
      validDraft({ reproductionSteps: "first\r\nsecond\rthird" }),
    );
    expect(normalized.ok).toBe(true);
    if (normalized.ok) expect(normalized.value.report.steps).toBe("first\nsecond\nthird");

    const cases = [
      ["unsafe-control", `step${String.fromCodePoint(0x07)}`, "steps"],
      ["invalid-unicode-scalar", `step${String.fromCharCode(0xd800)}`, "steps"],
      ["unsafe-format-character", `step${String.fromCodePoint(0x202e)}`, "steps"],
    ] as const;
    for (const [code, reproductionSteps, field] of cases) {
      expect(prepareFeedbackReportV1(validDraft({ reproductionSteps }))).toEqual({
        ok: false,
        errors: [{ code, field }],
      });
    }
  });

  it.each([
    [
      "timestamped raw log",
      { reproductionSteps: "ERROR 2026-07-09T18:10:11Z worker failed" },
      "raw-log-content",
      "steps",
    ],
    [
      "private credential path",
      { handwrittenEvidence: "Read ~/.ssh/id_ed25519" },
      "residual-sensitive-content",
      "handwrittenEvidence",
    ],
    [
      "provider endpoint",
      { description: "Provider base URL https://gateway.internal.example/v1" },
      "residual-sensitive-content",
      "summary.description",
    ],
  ])("fails closed for %s content", (_label, override, code, field) => {
    expect(prepareFeedbackReportV1(validDraft(override))).toEqual({
      ok: false,
      errors: [{ code, field }],
    });
  });

  it.each([
    ["product version", { productVersion: "v".repeat(65) }, "productVersion"],
    ["browser", { browserDescription: "b".repeat(257) }, "browserDescription"],
    ["summary title", { title: "t".repeat(4097) }, "summary.title"],
    ["summary description", { description: "d".repeat(4097) }, "summary.description"],
    ["combined summary", { title: "t".repeat(4094), description: "d" }, "summary"],
    ["steps", { reproductionSteps: "s".repeat(32 * 1024 + 1) }, "steps"],
    ["expected", { expectedBehavior: "e".repeat(32 * 1024 + 1) }, "expectedResult"],
    ["actual", { actualBehavior: "a".repeat(32 * 1024 + 1) }, "actualResult"],
    [
      "handwritten evidence",
      { handwrittenEvidence: "e".repeat(64 * 1024 + 1) },
      "handwrittenEvidence",
    ],
  ])("enforces the %s UTF-8 byte cap", (_label, override, field) => {
    expect(prepareFeedbackReportV1(validDraft(override))).toEqual({
      ok: false,
      errors: [{ code: "field-byte-limit", field }],
    });
  });

  it("enforces pre- and post-redaction attachment limits plus count and aggregate caps", () => {
    const over = new Uint8Array(FEEDBACK_REPORT_LIMITS.attachmentBytes + 1).fill(0x61);
    expect(prepareFeedbackReportV1(validDraft({ attachments: [{ bytes: over }] }))).toEqual({
      ok: false,
      errors: [{ code: "field-byte-limit", field: "attachments" }],
    });

    const tiny = { bytes: new TextEncoder().encode("safe") };
    expect(prepareFeedbackReportV1(validDraft({ attachments: [tiny, tiny, tiny, tiny] }))).toEqual({
      ok: false,
      errors: [{ code: "attachment-count-limit", field: "attachments" }],
    });

    const full = { bytes: new Uint8Array(FEEDBACK_REPORT_LIMITS.attachmentBytes).fill(0x61) };
    expect(prepareFeedbackReportV1(validDraft({ attachments: [full, full, tiny] }))).toEqual({
      ok: false,
      errors: [{ code: "attachment-aggregate-byte-limit", field: "attachments" }],
    });
  });

  it("enforces the post-redaction field cap and the whole canonical body cap", () => {
    const pathLines = Array.from({ length: 12 }, (_, index) => `/p${String(index)}`).join("\n");
    expect(new TextEncoder().encode(pathLines).length).toBeLessThanOrEqual(64);
    expect(prepareFeedbackReportV1(validDraft({ productVersion: pathLines }))).toEqual({
      ok: false,
      errors: [{ code: "field-byte-limit", field: "productVersion" }],
    });

    const large = new Uint8Array(64 * 1024).fill(0x61);
    expect(
      prepareFeedbackReportV1(
        validDraft({
          title: "t".repeat(2 * 1024),
          description: "d".repeat(2 * 1024 - 2),
          reproductionSteps: "s".repeat(32 * 1024),
          expectedBehavior: "e".repeat(32 * 1024),
          actualBehavior: "a".repeat(32 * 1024),
          handwrittenEvidence: "h".repeat(64 * 1024),
          attachments: [{ bytes: large }, { bytes: large }],
        }),
      ),
    ).toEqual({
      ok: false,
      errors: [{ code: "canonical-body-byte-limit", field: "report" }],
    });
  });

  it("enforces the combined summary cap before secret redaction can shrink it", () => {
    const shrinkable = `sk-${"a".repeat(2_000)}`;
    expect(
      prepareFeedbackReportV1(validDraft({ title: "t".repeat(3_000), description: shrinkable })),
    ).toEqual({
      ok: false,
      errors: [{ code: "field-byte-limit", field: "summary" }],
    });
  });

  it("keeps the immutable digest-paired disposition sidecar outside canonical content", () => {
    const ambiguous = '"password=opaque-value"';
    const draft = validDraft({ description: `Safe context ${ambiguous}` });
    const prepared = prepareFeedbackReportV1(draft);
    const repeated = prepareFeedbackReportV1(draft);
    expect(prepared.ok).toBe(true);
    expect(repeated.ok).toBe(true);
    if (!prepared.ok) return;
    if (!repeated.ok) return;

    const sidecar = prepared.value.dispositionSidecar;
    expect(sidecar.exactBodySha256).toBe(prepared.value.exactBodySha256);
    expect(sidecar.records).toHaveLength(1);
    expect(Object.isFrozen(sidecar)).toBe(true);
    expect(Object.isFrozen(sidecar.records)).toBe(true);
    expect(Object.isFrozen(sidecar.records[0])).toBe(true);
    expect(Object.isFrozen(sidecar.records[0]?.target)).toBe(true);
    expect(Reflect.set(sidecar, "exactBodySha256", "0".repeat(64))).toBe(false);
    expect(prepared.value.report).not.toHaveProperty("dispositionSidecar");
    expect(prepared.value.canonicalJson).not.toContain("dispositionSidecar");
    expect(prepared.value.canonicalJson).not.toContain("quarantined");
    expect(JSON.stringify(sidecar)).not.toContain("opaque-value");
    expect(repeated.value.dispositionSidecar).toEqual(sidecar);
  });

  it.each(["sendAnyway", "allowUnsafe", "skipDisposition"])(
    "rejects caller-controlled %s bypass state",
    (flag) => {
      const result = prepareFeedbackReportV1({ ...validDraft(), [flag]: true });
      expect(result).toEqual({
        ok: false,
        errors: [{ code: "unknown-field", field: "report" }],
      });
    },
  );
});
