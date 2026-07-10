import { describe, expect, it } from "vitest";

import {
  FEEDBACK_REPORT_SCHEMA_VERSION,
  type FeedbackReportDraftV1,
  type FeedbackReportV1,
} from "@oscharko-dev/keiko-contracts/feedback-report";

import {
  prepareFeedbackReportV1,
  type FeedbackReportRedactionPolicyV1,
  type PreparedFeedbackReportV1,
} from "./feedback-report.js";
import { verifyCanonicalFeedbackReportBodyV1 } from "./feedback-report-verifier.js";
import { canonicalise, sha256Hex } from "./hashing.js";

function validDraft(overrides: Partial<FeedbackReportDraftV1> = {}): FeedbackReportDraftV1 {
  return {
    schemaVersion: FEEDBACK_REPORT_SCHEMA_VERSION,
    category: "defect",
    title: "Feedback regression",
    description: "Safe description.",
    reproductionSteps: "Open the settings form.",
    expectedBehavior: "The form remains usable.",
    actualBehavior: "The form displayed unexpected content.",
    productVersion: "0.2.14",
    platform: "Linux",
    featureArea: "model-configuration",
    impact: "Degrades core workflow",
    ...overrides,
  };
}

function expectPreparedParity(
  overrides: Partial<FeedbackReportDraftV1>,
  policy?: FeedbackReportRedactionPolicyV1,
): PreparedFeedbackReportV1 | undefined {
  const prepared = prepareFeedbackReportV1(validDraft(overrides), policy);
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) return undefined;
  const verified = verifyCanonicalFeedbackReportBodyV1({
    bytes: prepared.value.canonicalBody.copyBytes(),
    claimedDigest: prepared.value.exactBodySha256,
    ...(policy === undefined ? {} : { policy }),
  });
  expect(verified.ok).toBe(true);
  if (verified.ok) {
    expect(verified.value.canonicalJson).toBe(prepared.value.canonicalJson);
    expect(verified.value.exactBodySha256).toBe(prepared.value.exactBodySha256);
  }
  return prepared.value;
}

function expectRawRejected(
  patch: Partial<FeedbackReportV1>,
  policy?: FeedbackReportRedactionPolicyV1,
): void {
  const baseline = prepareFeedbackReportV1(validDraft(), policy);
  expect(baseline.ok).toBe(true);
  if (!baseline.ok) return;
  const report = { ...baseline.value.report, ...patch };
  const json = canonicalise(report);
  expect(
    verifyCanonicalFeedbackReportBodyV1({
      bytes: new TextEncoder().encode(json),
      claimedDigest: sha256Hex(json),
      ...(policy === undefined ? {} : { policy }),
    }),
  ).toEqual({ ok: false, error: { code: "unsafe-content" } });
}

function expectRawDescriptionRejected(
  description: string,
  policy?: FeedbackReportRedactionPolicyV1,
): void {
  const baseline = prepareFeedbackReportV1(validDraft(), policy);
  expect(baseline.ok).toBe(true);
  if (!baseline.ok) return;
  expectRawRejected(
    {
      summary: { ...baseline.value.report.summary, description },
    },
    policy,
  );
}

function expectRedactedDisposition(
  prepared: PreparedFeedbackReportV1,
  field: "description" | "reproductionSteps" | "handwrittenEvidence",
): void {
  expect(prepared.dispositionSidecar.records).toContainEqual(
    expect.objectContaining({
      action: "redacted",
      reason: "complete-sensitive-span",
      target: { kind: "draft-field", field },
    }),
  );
}

describe("feedback report dual-review regressions", () => {
  it("fails closed for over-budget whitespace before a required credential separator", () => {
    const rawAtom = "opaque-secret-value";
    const input = `password${" ".repeat(4_097)}=${rawAtom}`;
    const prepared = prepareFeedbackReportV1(validDraft({ reproductionSteps: input }));

    expect(prepared).toEqual({
      ok: false,
      errors: [
        {
          code: "rewrite-required",
          target: { kind: "draft-field", field: "reproductionSteps" },
        },
      ],
    });
    expect(JSON.stringify(prepared)).not.toContain(rawAtom);
    expectRawRejected({ steps: input });
  });

  it("keeps independently safe summary controls structured without cross-field composition", () => {
    const semanticAtom = "opaque-secret";
    const overrides = { title: "password", description: `: ${semanticAtom}` };
    const first = expectPreparedParity(overrides);
    const repeated = expectPreparedParity(overrides);
    if (first === undefined || repeated === undefined) return;

    expect(first.report.summary).toEqual({
      title: "password",
      description: `: ${semanticAtom}`,
    });
    expect(first.dispositionSidecar.records).toEqual([]);
    expect(repeated.canonicalJson).toBe(first.canonicalJson);
    expect(repeated.dispositionSidecar).toEqual(first.dispositionSidecar);
    expectRawDescriptionRejected(`password\n\n: ${semanticAtom}`);
  });

  it.each([
    ["authorization scheme", "Bearer"],
    ["assignment separator", "password="],
  ])("keeps an incomplete %s title separate from a safe description", (_label, title) => {
    const description = "opaque-safe-atom";
    const first = expectPreparedParity({ title, description });
    const repeated = expectPreparedParity({ title, description });
    if (first === undefined || repeated === undefined) return;

    expect(first.report.summary).toEqual({ title, description });
    expect(first.dispositionSidecar.records).toEqual([]);
    expect(repeated.canonicalJson).toBe(first.canonicalJson);
    expect(repeated.dispositionSidecar).toEqual(first.dispositionSidecar);
  });

  it("redacts a credential value after a newline separator with verifier parity", () => {
    const rawAtom = "opaque-secret-value";
    const input = `password=\n${rawAtom}`;
    const prepared = expectPreparedParity({ reproductionSteps: input });
    if (prepared === undefined) return;

    expect(prepared.report.steps).toContain("password=");
    expect(prepared.canonicalJson).not.toContain(rawAtom);
    expectRedactedDisposition(prepared, "reproductionSteps");
    expectRawRejected({ steps: input });
  });

  it.each(['"', "'"] as const)(
    "quarantines the complete known multiline %s-quoted assignment segment",
    (quote) => {
      const rawAtom = "opaque-secret-value";
      const input = `Safe prefix password=${quote}\n${rawAtom}${quote} safe suffix`;
      const prepared = expectPreparedParity({ description: input });
      if (prepared === undefined) return;

      expect(prepared.report.summary.description).toContain("Safe prefix");
      expect(prepared.report.summary.description).toContain("safe suffix");
      expect(prepared.canonicalJson).not.toContain(rawAtom);
      expect(prepared.dispositionSidecar.records).toContainEqual({
        action: "quarantined",
        reason: "ambiguous-credential-structure",
        unitKind: "quoted-segment",
        target: { kind: "draft-field", field: "description" },
      });
      expectRawDescriptionRejected(input);
    },
  );

  it.each([
    [
      "prose",
      'Safe prefix "password=\nopaque-outer-value" safe suffix',
      ["Safe prefix", "safe suffix"],
    ],
    ["JSON message", 'payload={"message":"password=\nopaque-outer-value"}', ["payload="]],
  ])("quarantines a complete outer multiline assignment in %s", (_label, description, safe) => {
    const prepared = expectPreparedParity({ description });
    if (prepared === undefined) return;

    expect(prepared.canonicalJson).not.toContain("opaque-outer-value");
    for (const atom of safe) expect(prepared.report.summary.description).toContain(atom);
    expect(prepared.dispositionSidecar.records).toContainEqual({
      action: "quarantined",
      reason: "ambiguous-credential-structure",
      unitKind: "quoted-segment",
      target: { kind: "draft-field", field: "description" },
    });
    expectRawDescriptionRejected(description);
  });

  it("quarantines a complete outer multiline assignment in an attachment", () => {
    const raw = 'Safe prefix "password=\nopaque-outer-value" safe suffix';
    const prepared = expectPreparedParity({
      attachments: [{ bytes: new TextEncoder().encode(raw) }],
    });
    if (prepared === undefined) return;

    expect(prepared.canonicalJson).not.toContain("opaque-outer-value");
    expect(prepared.report.attachments?.[0]).toContain("Safe prefix");
    expect(prepared.report.attachments?.[0]).toContain("safe suffix");
    expect(prepared.dispositionSidecar.records).toContainEqual({
      action: "quarantined",
      reason: "ambiguous-credential-structure",
      unitKind: "quoted-segment",
      target: { kind: "attachment", ordinal: 0 },
    });
  });

  it.each([
    ["quoted Bearer", 'Safe prefix Bearer "opaque-auth-value" safe suffix'],
    ["unquoted Basic", "Safe prefix Basic opaque-auth-value safe suffix"],
    ["multiline Bearer", "Safe prefix Bearer\nopaque-auth-value safe suffix"],
    ["multiline Basic", "Safe prefix Basic\nopaque-auth-value safe suffix"],
  ])("redacts exact %s boundaries and preserves safe semantics", (_label, input) => {
    const prepared = expectPreparedParity({ description: input });
    if (prepared === undefined) return;

    expect(prepared.report.summary.description).toContain("Safe prefix");
    expect(prepared.report.summary.description).toContain("safe suffix");
    expect(prepared.canonicalJson).not.toContain("opaque-auth-value");
    expectRedactedDisposition(prepared, "description");
    expectRawDescriptionRejected(input);
  });

  it.each(["Bearer", "Basic"] as const)(
    "quarantines only an unterminated quoted %s unit",
    (scheme) => {
      const rawAtom = "opaque-auth-value";
      const input = `Safe prefix ${scheme} "${rawAtom}\nSafe following line`;
      const prepared = expectPreparedParity({ description: input });
      if (prepared === undefined) return;

      expect(prepared.report.summary.description).toContain("Safe prefix");
      expect(prepared.report.summary.description).toContain("Safe following line");
      expect(prepared.canonicalJson).not.toContain(rawAtom);
      expect(prepared.dispositionSidecar.records).toContainEqual({
        action: "quarantined",
        reason: "ambiguous-credential-structure",
        unitKind: "line-remainder",
        target: { kind: "draft-field", field: "description" },
      });
      expectRawDescriptionRejected(input);
    },
  );

  it("uses the longest overlapping configured literal independent of policy order", () => {
    const input = "Safe prefix tenant-alpha-prod safe suffix";
    const policies = [
      { sensitiveLiterals: ["tenant-alpha", "tenant-alpha-prod"] },
      { sensitiveLiterals: ["tenant-alpha-prod", "tenant-alpha"] },
    ] as const;
    const prepared = policies.map((policy) => expectPreparedParity({ description: input }, policy));
    expect(prepared.every((value) => value !== undefined)).toBe(true);
    if (prepared.some((value) => value === undefined)) return;
    const [shortFirst, longFirst] = prepared as [
      PreparedFeedbackReportV1,
      PreparedFeedbackReportV1,
    ];

    expect(shortFirst.canonicalJson).toBe(longFirst.canonicalJson);
    expect(shortFirst.dispositionSidecar.records).toEqual(longFirst.dispositionSidecar.records);
    expect(shortFirst.canonicalJson).not.toContain("tenant-alpha");
    expect(shortFirst.canonicalJson).not.toContain("-prod");
    expect(shortFirst.report.redactionProvenance.rules).toContainEqual({
      code: "configured-literal",
      count: 1,
    });
    expectRedactedDisposition(shortFirst, "description");
    expectRawDescriptionRejected(input, policies[0]);
  });

  it("redacts an exact customer identifier without blocking optional safe content", () => {
    const identifier = "customer-atlas";
    const input = `Safe prefix ${identifier} safe suffix`;
    const policy = { customerIdentifierLiterals: [identifier] } as const;
    const first = expectPreparedParity({ handwrittenEvidence: input }, policy);
    const repeated = expectPreparedParity({ handwrittenEvidence: input }, policy);
    if (first === undefined || repeated === undefined) return;

    expect(first.report.handwrittenEvidence).toContain("Safe prefix");
    expect(first.report.handwrittenEvidence).toContain("safe suffix");
    expect(first.canonicalJson).not.toContain(identifier);
    expect(first.report.redactionProvenance.rules).toContainEqual({
      code: "configured-literal",
      count: 1,
    });
    expectRedactedDisposition(first, "handwrittenEvidence");
    expect(repeated.canonicalJson).toBe(first.canonicalJson);
    expect(repeated.dispositionSidecar.records).toEqual(first.dispositionSidecar.records);
    expectRawRejected({ handwrittenEvidence: input }, policy);
  });
});
