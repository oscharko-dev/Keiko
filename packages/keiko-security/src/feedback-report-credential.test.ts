import { describe, expect, it } from "vitest";

import {
  FEEDBACK_REPORT_SCHEMA_VERSION,
  type FeedbackReportDraftV1,
} from "@oscharko-dev/keiko-contracts/feedback-report";

import { prepareFeedbackReportV1 } from "./feedback-report.js";
import type { PreparedFeedbackReportV1 } from "./feedback-report.js";
import { verifyCanonicalFeedbackReportBodyV1 } from "./feedback-report-verifier.js";
import { canonicalise, sha256Hex } from "./hashing.js";

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
    impact: "Blocks core workflow",
    ...overrides,
  };
}

function prepareAndVerify(
  overrides: Partial<FeedbackReportDraftV1>,
): PreparedFeedbackReportV1 | undefined {
  const prepared = prepareFeedbackReportV1(validDraft(overrides));
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) return undefined;
  const verified = verifyCanonicalFeedbackReportBodyV1({
    bytes: prepared.value.canonicalBody.copyBytes(),
    claimedDigest: prepared.value.exactBodySha256,
  });
  expect(verified.ok).toBe(true);
  return prepared.value;
}

describe("feedback credential redaction parity", () => {
  it("removes the complete bearer token when it contains a tilde", () => {
    const token = "abc~defghijklmnopqrstuv";
    const prepared = prepareAndVerify({ description: `Bearer ${token}` });
    if (prepared === undefined) return;

    expect(prepared.report.summary.description).toContain("Bearer [REDACTED]");
    expect(prepared.canonicalJson).not.toContain(token);
    expect(prepared.canonicalJson).not.toContain("defghijklmnopqrstuv");
  });

  it("removes complete URL userinfo from the structured title and counts it once", () => {
    const url = "https://alice:pa:ss@example.com/repo";
    const prepared = prepareAndVerify({ title: url });
    if (prepared === undefined) return;

    expect(prepared.report.summary.title).toContain("https://[REDACTED]@example.com/repo");
    expect(prepared.canonicalJson).not.toContain("alice:pa:ss");
    expect(prepared.report.redactionProvenance.rules).toContainEqual({
      code: "url-userinfo",
      count: 1,
    });
    expect(prepared.dispositionSidecar.records).toContainEqual(
      expect.objectContaining({
        action: "redacted",
        target: { kind: "draft-field", field: "title" },
      }),
    );
  });

  it("removes the complete value of a quoted credential assignment", () => {
    const secret = "correct horse battery staple";
    const prepared = prepareAndVerify({ description: `password="${secret}"` });
    if (prepared === undefined) return;

    expect(prepared.report.summary.description).toContain('password="[REDACTED]"');
    expect(prepared.canonicalJson).not.toContain(secret);
    expect(prepared.canonicalJson).not.toContain("horse battery staple");
    expect(prepared.report.redactionProvenance.rules).toContainEqual({
      code: "credential-assignment",
      count: 1,
    });
  });

  it.each([
    ["quoted Basic", 'Basic "opaque secret value"', "opaque secret value", "authorization-secret"],
    ["colon-bearing DSN", "postgres://user:p:a@db.internal/app", "user:p:a", "url-userinfo"],
    ["multiple-at URL", "https://user:p@ss@host/repo", "user:p@ss", "url-userinfo"],
    [
      "prefixed API key",
      'OPENAI_API_KEY = "opaque secret value"',
      "opaque secret value",
      "credential-assignment",
    ],
    [
      "camel-case key",
      "clientSecret='opaque; secret, value'",
      "opaque; secret, value",
      "credential-assignment",
    ],
    [
      "unquoted whitespace suffix",
      "password=correct horse battery",
      "horse battery",
      "credential-assignment",
    ],
    [
      "quoted assignment suffix",
      'PASSWORD="correct horse"battery',
      "battery",
      "credential-assignment",
    ],
    [
      "authorization punctuation suffix",
      "Basic user:supersecret",
      "supersecret",
      "authorization-secret",
    ],
    [
      "quoted decorated key",
      '"password ": "opaque secret"',
      "opaque secret",
      "credential-assignment",
    ],
    ["bracket-decorated key", "password[]=opaque-secret", "opaque-secret", "credential-assignment"],
  ])("keeps prepared and canonical verification aligned for %s", (_label, input, secret, code) => {
    const prepared = prepareAndVerify({ description: input });
    if (prepared === undefined) return;

    expect(prepared.canonicalJson).not.toContain(secret);
    expect(prepared.report.redactionProvenance.rules).toContainEqual({ code, count: 1 });
  });

  it("treats an unindented line after an empty block scalar as safe remainder", () => {
    const prepared = prepareAndVerify({ description: "password: |\nunindented safe prose" });
    if (prepared === undefined) return;

    expect(prepared.report.summary.description).toBe("password: [REDACTED]\nunindented safe prose");
    expect(prepared.report.redactionProvenance.rules).toContainEqual({
      code: "credential-assignment",
      count: 1,
    });
  });

  it.each([
    "password[0]",
    "password[primary]",
    "password.value",
    "credentials.password.value",
    "token[access]",
    "api_key[prod]",
    "password(confirm)",
  ])("keeps structural key %s aligned through canonical verification", (key) => {
    const prepared = prepareAndVerify({ description: `${key}="opaque secret"` });
    if (prepared === undefined) return;

    expect(prepared.canonicalJson).not.toContain("opaque secret");
    expect(prepared.report.redactionProvenance.rules).toContainEqual({
      code: "credential-assignment",
      count: 1,
    });
  });

  it.each([
    ["pretty JSON LF", '"password":\n  "opaque secret"'],
    ["pretty JSON CRLF", '"password":\r\n\t"opaque secret"'],
    ["balanced object", 'password={"nested":{"value":"opaque secret"},"safe":1}'],
    ["nested ungoverned object", 'payload={"password":"opaque secret","safe":1}'],
    ["malformed object", 'password={"nested":"opaque secret"'],
  ])("removes complete %s value before canonical verification", (_label, description) => {
    const prepared = prepareAndVerify({ description });
    if (prepared === undefined) return;

    expect(prepared.canonicalJson).not.toContain("opaque secret");
    expect(prepared.report.redactionProvenance.rules).toContainEqual({
      code: "credential-assignment",
      count: 1,
    });
  });

  it("counts multiple structured credential lines once each", () => {
    const prepared = prepareAndVerify({
      description: 'password="first secret"\nsafe=value\ntoken[access]="second secret"',
    });
    if (prepared === undefined) return;

    expect(prepared.canonicalJson).not.toContain("first secret");
    expect(prepared.canonicalJson).not.toContain("second secret");
    expect(prepared.report.redactionProvenance.rules).toContainEqual({
      code: "credential-assignment",
      count: 2,
    });
  });

  it.each([
    "Password reset: follow the documented flow",
    "The password: reset guidance is public",
    "The password policy requires twelve characters.",
    "Use the password reset page and sign in again.",
    "The password field remained empty after reload.",
    "Rotate credentials after the scheduled maintenance window.",
    'The label "password" is visible in the settings form.',
    'payload={"passwordPolicy":"minimum length"}',
    "timestamp 12:30:00",
    'payload={"passwordReset":"safe"}',
  ])("preserves benign structured prose through canonical verification: %s", (description) => {
    const prepared = prepareAndVerify({ description });
    if (prepared === undefined) return;

    expect(prepared.report.summary.description).toContain(description);
    expect(prepared.report.redactionProvenance.rules).not.toContainEqual({
      code: "credential-assignment",
      count: 1,
    });
  });

  it("preserves a colonless SSH login through preparation and canonical verification", () => {
    const login = "ssh://user@host/repo";
    const prepared = prepareAndVerify({ description: login });
    if (prepared === undefined) return;

    expect(prepared.report.summary.description).toContain(login);
    expect(prepared.report.redactionProvenance.rules).not.toContainEqual({
      code: "url-userinfo",
      count: 1,
    });
  });

  it("quarantines an ambiguous quoted assignment while preserving both safe sides", () => {
    const ambiguous = '"password=opaque-value"';
    const prepared = prepareAndVerify({
      description: `Safe before ${ambiguous} safe after`,
    });
    if (prepared === undefined) return;

    expect(prepared.report.summary.description).toContain("Safe before");
    expect(prepared.report.summary.description).toContain("safe after");
    expect(prepared.canonicalJson).not.toContain("opaque-value");
    expect(prepared.dispositionSidecar).toEqual({
      exactBodySha256: prepared.exactBodySha256,
      records: [
        {
          action: "quarantined",
          reason: "ambiguous-credential-structure",
          unitKind: "quoted-segment",
          target: { kind: "draft-field", field: "description" },
        },
      ],
    });
  });

  it("quarantines only the line remainder for unterminated credential syntax", () => {
    const prepared = prepareAndVerify({
      description: 'Safe prefix password="opaque-value\nSafe next line',
    });
    if (prepared === undefined) return;

    expect(prepared.report.summary.description).toContain("Safe prefix");
    expect(prepared.report.summary.description).toContain("Safe next line");
    expect(prepared.canonicalJson).not.toContain("opaque-value");
    expect(prepared.dispositionSidecar.records).toContainEqual({
      action: "quarantined",
      reason: "ambiguous-credential-structure",
      unitKind: "line-remainder",
      target: { kind: "draft-field", field: "description" },
    });
  });

  it("omits an exhausted optional field with ordered content-free dispositions", () => {
    const ambiguous = '"password=opaque-value"';
    const prepared = prepareAndVerify({ browserDescription: ambiguous });
    if (prepared === undefined) return;

    expect(prepared.report).not.toHaveProperty("browserDescription");
    expect(prepared.canonicalJson).not.toContain(ambiguous);
    expect(prepared.dispositionSidecar.records).toEqual([
      {
        action: "quarantined",
        reason: "ambiguous-credential-structure",
        unitKind: "quoted-segment",
        target: { kind: "draft-field", field: "browserDescription" },
      },
      {
        action: "omitted",
        reason: "no-safe-optional-content",
        unitKind: "optional-field",
        target: { kind: "draft-field", field: "browserDescription" },
      },
    ]);
  });

  it("omits only the exhausted attachment and retains its snapshot ordinal", () => {
    const ambiguous = '"password=opaque-value"';
    const prepared = prepareAndVerify({
      attachments: [
        { bytes: new TextEncoder().encode(ambiguous) },
        { bytes: new TextEncoder().encode("Safe attachment remains") },
      ],
    });
    if (prepared === undefined) return;

    expect(prepared.report.attachments).toEqual(["Safe attachment remains"]);
    expect(prepared.canonicalJson).not.toContain(ambiguous);
    expect(prepared.dispositionSidecar.records).toEqual([
      {
        action: "quarantined",
        reason: "ambiguous-credential-structure",
        unitKind: "quoted-segment",
        target: { kind: "attachment", ordinal: 0 },
      },
      {
        action: "omitted",
        reason: "no-safe-optional-content",
        unitKind: "attachment",
        target: { kind: "attachment", ordinal: 0 },
      },
    ]);
  });

  it("requires a rewrite only when a required source field has no safe content", () => {
    const ambiguous = '"password=opaque-value"';
    const blocked = prepareFeedbackReportV1(validDraft({ description: ambiguous }));

    expect(blocked).toEqual({
      ok: false,
      errors: [
        {
          code: "rewrite-required",
          target: { kind: "draft-field", field: "description" },
        },
      ],
    });
    expect(JSON.stringify(blocked)).not.toContain(ambiguous);

    const safeRemainder = prepareAndVerify({
      description: `Safe context ${ambiguous}`,
    });
    expect(safeRemainder?.report.summary.description).toContain("Safe context");
  });

  it.each([
    ["authorization", 'Bearer "opaque secret value"'],
    ["URL userinfo", "https://user:p@ss@host/repo"],
    ["assignment", "OPENAI_API_KEY=opaque secret value"],
    ["block scalar", "password: |\nunindented secret"],
    ["pretty assignment", '"password":\n  "opaque secret"'],
    ["quoted assignment", '"password=opaque-value"'],
    ["JSON separator whitespace", '"password"\n:\n"opaque value"'],
    ["structural key", 'credentials.password.value="opaque secret"'],
    ["nested object", 'payload={"password":"opaque secret","safe":1}'],
  ])("rejects an unredacted canonical %s body", (_label, description) => {
    const prepared = prepareFeedbackReportV1(validDraft());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const report = {
      ...prepared.value.report,
      summary: { ...prepared.value.report.summary, description },
    };
    const json = canonicalise(report);

    expect(
      verifyCanonicalFeedbackReportBodyV1({
        bytes: new TextEncoder().encode(json),
        claimedDigest: sha256Hex(json),
      }),
    ).toEqual({ ok: false, error: { code: "unsafe-content" } });
  });
});
