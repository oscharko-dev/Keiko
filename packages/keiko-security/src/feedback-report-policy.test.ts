import { describe, expect, it } from "vitest";

import {
  FEEDBACK_REPORT_SCHEMA_VERSION,
  type FeedbackReportDraftV1,
} from "@oscharko-dev/keiko-contracts/feedback-report";

import { prepareFeedbackReportV1 } from "./feedback-report.js";
import {
  FEEDBACK_REPORT_REDACTION_POLICY_LIMITS_V1,
  parseFeedbackReportRedactionPolicyV1,
  type FeedbackReportRedactionPolicyV1,
} from "./feedback-report-policy.js";
import { verifyCanonicalFeedbackReportBodyV1 } from "./feedback-report-verifier.js";
import { sha256Hex } from "./hashing.js";
import { redactWithRuleCounts } from "./redaction.js";

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
    handwrittenEvidence: "Reproduces in a clean workspace.",
    ...overrides,
  };
}

describe("feedback report policy and immutable body", () => {
  it("keeps approved canonical bytes private and returns defensive copies", () => {
    const prepared = prepareFeedbackReportV1(validDraft());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const first = prepared.value.canonicalBody.copyBytes();
    first[0] = 0;
    const second = prepared.value.canonicalBody.copyBytes();

    expect(new TextDecoder().decode(second)).toBe(prepared.value.canonicalJson);
    expect(sha256Hex(new TextDecoder().decode(second))).toBe(prepared.value.exactBodySha256);
    expect(Object.isFrozen(prepared.value.report)).toBe(true);
    expect(Object.isFrozen(prepared.value.report.redactionProvenance.rules)).toBe(true);
  });

  it("redacts an exact trusted sensitive literal and records content-free provenance", () => {
    const literal = "internal.corp.example";
    const prepared = prepareFeedbackReportV1(
      validDraft({ description: `Connected to ${literal}` }),
      { sensitiveLiterals: [literal] },
    );

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.canonicalJson).not.toContain(literal);
    expect(prepared.value.report.redactionProvenance.rules).toContainEqual({
      code: "configured-literal",
      count: 1,
    });
  });

  it("redacts an exact trusted customer identifier with verifier parity", () => {
    const identifier = "customer-atlas";
    const policy = { customerIdentifierLiterals: [identifier] };
    const prepared = prepareFeedbackReportV1(
      validDraft({ description: `Observed for ${identifier}` }),
      policy,
    );

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.report.summary.description).toContain("Observed for [REDACTED]");
    expect(prepared.value.canonicalJson).not.toContain(identifier);
    expect(prepared.value.report.redactionProvenance.rules).toContainEqual({
      code: "configured-literal",
      count: 1,
    });
    expect(prepared.value.dispositionSidecar.records).toContainEqual(
      expect.objectContaining({
        action: "redacted",
        reason: "complete-sensitive-span",
        target: { kind: "draft-field", field: "description" },
      }),
    );
    expect(JSON.stringify(prepared.value.dispositionSidecar)).not.toContain(identifier);
    expect(
      verifyCanonicalFeedbackReportBodyV1({
        bytes: prepared.value.canonicalBody.copyBytes(),
        claimedDigest: prepared.value.exactBodySha256,
        policy,
      }),
    ).toEqual(expect.objectContaining({ ok: true }));
  });

  it("rejects an invalid trusted redaction policy content-free", () => {
    expect(prepareFeedbackReportV1(validDraft(), { sensitiveLiterals: [""] })).toEqual({
      ok: false,
      errors: [{ code: "invalid-shape", field: "report" }],
    });
  });

  it("rejects sensitive and customer literals that overlap reserved redaction sentinels", () => {
    const substrings = new Set<string>();
    for (const sentinel of ["[REDACTED]", "[REDACTED_PATH]"]) {
      for (let start = 0; start < sentinel.length; start += 1) {
        for (let end = start + 4; end <= sentinel.length; end += 1) {
          substrings.add(sentinel.slice(start, end));
        }
      }
    }
    for (const literal of substrings) {
      for (const field of ["sensitiveLiterals", "customerIdentifierLiterals"] as const) {
        const policy = { [field]: [literal] };
        expect(parseFeedbackReportRedactionPolicyV1(policy)).toEqual({
          ok: false,
          error: { code: "invalid-shape", field: "report" },
        });
      }
    }
    for (const literal of ["DACT", "REDA", "REDACTED", "[REDACTED]", "REDACTED_PATH"]) {
      expect(prepareFeedbackReportV1(validDraft(), { sensitiveLiterals: [literal] })).toEqual({
        ok: false,
        errors: [{ code: "invalid-shape", field: "report" }],
      });
    }
  });

  it("keeps accepted literal policies idempotent across preparation and verification", () => {
    for (const literal of ["tenant-alpha", "opaque-value", "[CUSTOMER]"]) {
      const policy = { sensitiveLiterals: [literal] };
      expect(parseFeedbackReportRedactionPolicyV1(policy).ok).toBe(true);
      const prepared = prepareFeedbackReportV1(
        validDraft({ description: `Affected ${literal}` }),
        policy,
      );
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) continue;
      expect(prepared.value.report.redactionProvenance.rules).toContainEqual({
        code: "configured-literal",
        count: 1,
      });
      expect(
        verifyCanonicalFeedbackReportBodyV1({
          bytes: prepared.value.canonicalBody.copyBytes(),
          claimedDigest: prepared.value.exactBodySha256,
          policy,
        }).ok,
      ).toBe(true);
      const once = redactWithRuleCounts(`Affected ${literal}`, [literal]);
      expect(redactWithRuleCounts(once.value, [literal])).toEqual({
        value: once.value,
        rules: [],
      });
    }

    const customerPolicy = { customerIdentifierLiterals: ["customer-atlas"] };
    const prepared = prepareFeedbackReportV1(validDraft(), customerPolicy);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(
      verifyCanonicalFeedbackReportBodyV1({
        bytes: prepared.value.canonicalBody.copyBytes(),
        claimedDigest: prepared.value.exactBodySha256,
        policy: customerPolicy,
      }).ok,
    ).toBe(true);
  });

  it.each([
    [
      "known-field getter",
      Object.defineProperty({}, "sensitiveLiterals", {
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
  ])("fails closed for a policy %s", (_label, policy) => {
    expect(parseFeedbackReportRedactionPolicyV1(policy)).toEqual({
      ok: false,
      error: { code: "invalid-shape", field: "report" },
    });
    expect(
      prepareFeedbackReportV1(validDraft(), policy as FeedbackReportRedactionPolicyV1),
    ).toEqual({
      ok: false,
      errors: [{ code: "invalid-shape", field: "report" }],
    });
  });

  it("fails closed for a revoked policy proxy", () => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    expect(parseFeedbackReportRedactionPolicyV1(revocable.proxy)).toEqual({
      ok: false,
      error: { code: "invalid-shape", field: "report" },
    });
    expect(
      prepareFeedbackReportV1(validDraft(), revocable.proxy as FeedbackReportRedactionPolicyV1),
    ).toEqual({
      ok: false,
      errors: [{ code: "invalid-shape", field: "report" }],
    });
  });

  it("preflights the literal-count cap before inspecting an out-of-bounds entry", () => {
    const literals = new Array<string>(FEEDBACK_REPORT_REDACTION_POLICY_LIMITS_V1.literalCount + 1);
    Object.defineProperty(literals, FEEDBACK_REPORT_REDACTION_POLICY_LIMITS_V1.literalCount, {
      enumerable: true,
      get: (): never => {
        throw new Error("must not traverse beyond the policy cap");
      },
    });

    expect(parseFeedbackReportRedactionPolicyV1({ sensitiveLiterals: literals })).toEqual({
      ok: false,
      error: { code: "field-byte-limit", field: "report" },
    });
  });

  it("preflights the combined literal-count cap before inspecting either list", () => {
    const sensitiveLiterals = new Array<string>(
      FEEDBACK_REPORT_REDACTION_POLICY_LIMITS_V1.literalCount,
    ).fill("duplicate-value");
    const customerIdentifierLiterals = new Array<string>(1);
    Object.defineProperty(customerIdentifierLiterals, 0, {
      enumerable: true,
      get: (): never => {
        throw new Error("must not inspect an over-limit combined policy");
      },
    });

    expect(
      parseFeedbackReportRedactionPolicyV1({
        sensitiveLiterals,
        customerIdentifierLiterals,
      }),
    ).toEqual({
      ok: false,
      error: { code: "field-byte-limit", field: "report" },
    });
  });

  it.each([
    ["sparse", new Array<string>(1)],
    [
      "accessor-backed",
      Object.defineProperty([], 0, {
        enumerable: true,
        get: (): never => {
          throw new Error("policy accessors must not execute");
        },
      }),
    ],
    ["extra-property", Object.assign(["safe-literal"], { unexpected: true })],
  ])("rejects a %s literal array without invoking caller code", (_label, sensitiveLiterals) => {
    expect(parseFeedbackReportRedactionPolicyV1({ sensitiveLiterals })).toEqual({
      ok: false,
      error: { code: "invalid-shape", field: "report" },
    });
  });

  it("applies a trusted sensitive literal to every prose field and attachment", () => {
    const literal = "tenant-X";
    const prepared = prepareFeedbackReportV1(
      validDraft({
        title: literal,
        description: literal,
        reproductionSteps: literal,
        expectedBehavior: literal,
        actualBehavior: literal,
        productVersion: literal,
        browserDescription: literal,
        handwrittenEvidence: literal,
        attachments: [{ bytes: new TextEncoder().encode(literal) }],
      }),
      { sensitiveLiterals: [literal] },
    );

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.canonicalJson).not.toContain(literal);
    expect(prepared.value.report.redactionProvenance.rules).toContainEqual({
      code: "configured-literal",
      count: 9,
    });
  });

  it.each([
    [
      "literal count",
      Array.from(
        { length: FEEDBACK_REPORT_REDACTION_POLICY_LIMITS_V1.literalCount + 1 },
        (_, index) => `literal-${String(index)}`,
      ),
    ],
    [
      "per-literal bytes",
      ["x".repeat(FEEDBACK_REPORT_REDACTION_POLICY_LIMITS_V1.literalBytes + 1)],
    ],
    [
      "multibyte per-literal bytes",
      ["💥".repeat(Math.floor(FEEDBACK_REPORT_REDACTION_POLICY_LIMITS_V1.literalBytes / 4) + 1)],
    ],
    [
      "aggregate bytes",
      Array.from(
        { length: 33 },
        (_, index) => `${String(index).padStart(3, "0")}${"x".repeat(253)}`,
      ),
    ],
  ])("bounds trusted policy %s before report processing", (_label, sensitiveLiterals) => {
    expect(prepareFeedbackReportV1(validDraft(), { sensitiveLiterals })).toEqual({
      ok: false,
      errors: [{ code: "field-byte-limit", field: "report" }],
    });
  });
});
