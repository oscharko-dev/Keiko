import { describe, expect, it, vi } from "vitest";

import {
  FEEDBACK_REPORT_SCHEMA_VERSION,
  type FeedbackReportDraftV1,
} from "@oscharko-dev/keiko-contracts/feedback-report";

import {
  containsCredentialDetection,
  sanitizeFeedbackCredentialSpans,
} from "./credential-spans.js";
import { prepareFeedbackReportV1, type PreparedFeedbackReportV1 } from "./feedback-report.js";
import { verifyCanonicalFeedbackReportBodyV1 } from "./feedback-report-verifier.js";
import { canonicalise, sha256Hex } from "./hashing.js";
import { redactWithRuleCounts } from "./redaction.js";

const ASSIGNMENT_RULE = [{ code: "credential-assignment", count: 1 }] as const;
const TWO_ASSIGNMENT_RULES = [{ code: "credential-assignment", count: 2 }] as const;

function indexedReadsDuringRedaction(value: string): number {
  let reads = 0;
  const target = Object(value) as object;
  const counted = new Proxy(target, {
    get: (object, key): unknown => {
      if (typeof key === "string" && /^[0-9]+$/u.test(key)) reads += 1;
      if (key === Symbol.toPrimitive) return (): string => value;
      const member = Reflect.get(object, key, object) as unknown;
      return typeof member === "function" ? member.bind(object) : member;
    },
  });
  redactWithRuleCounts(counted as unknown as string);
  return reads;
}

function validDraft(reproductionSteps: string): FeedbackReportDraftV1 {
  return {
    schemaVersion: FEEDBACK_REPORT_SCHEMA_VERSION,
    category: "defect",
    title: "Credential boundary regression",
    description: "A safe report description.",
    reproductionSteps,
    expectedBehavior: "The report remains reviewable.",
    actualBehavior: "The report changed unexpectedly.",
    productVersion: "0.2.14",
    platform: "Linux",
    featureArea: "model-configuration",
    impact: "Degrades core workflow",
  };
}

function prepareAndVerifySteps(reproductionSteps: string): PreparedFeedbackReportV1 | undefined {
  const prepared = prepareFeedbackReportV1(validDraft(reproductionSteps));
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) return undefined;
  expect(
    verifyCanonicalFeedbackReportBodyV1({
      bytes: prepared.value.canonicalBody.copyBytes(),
      claimedDigest: prepared.value.exactBodySha256,
    }).ok,
  ).toBe(true);
  return prepared.value;
}

function expectRawStepsRejected(prepared: PreparedFeedbackReportV1, steps: string): void {
  const report = { ...prepared.report, steps };
  const json = canonicalise(report);
  expect(
    verifyCanonicalFeedbackReportBodyV1({
      bytes: new TextEncoder().encode(json),
      claimedDigest: sha256Hex(json),
    }),
  ).toEqual({ ok: false, error: { code: "unsafe-content" } });
}

function repeatedAssignments(
  count: number,
  renderValue: (value: string) => string = (value) => value,
): string {
  return Array.from(
    { length: count },
    (_, index) => `token=${renderValue(`opaque-value-${String(index)}`)}`,
  ).join("; ");
}

function searchedCharactersDuringPublicParity(
  count: number,
  renderValue?: (value: string) => string,
): number {
  const input = repeatedAssignments(count, renderValue);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- captured before the temporary spy
  const original = String.prototype.indexOf;
  let searched = 0;
  const spy = vi.spyOn(String.prototype, "indexOf").mockImplementation(function (
    this: string,
    search: string,
    position?: number,
  ): number {
    const value = this.valueOf();
    const from = position ?? 0;
    if (value === input && search === "\n") searched += Math.max(0, value.length - from);
    return original.call(value, search, position);
  });
  try {
    const prepared = prepareAndVerifySteps(input);
    expect(prepared?.report.redactionProvenance.rules).toContainEqual({
      code: "credential-assignment",
      count,
    });
  } finally {
    spy.mockRestore();
  }
  return searched;
}

describe("credential scalar-boundary regressions", () => {
  it("does not treat a quoted empty-call key as a code signature", () => {
    expect(redactWithRuleCounts('{"password()":"opaque"}')).toEqual({
      value: '{"password()":"[REDACTED]"}',
      rules: ASSIGNMENT_RULE,
    });
  });

  it.each([
    ["password(): supersecret", "password(): [REDACTED]"],
    ["config: password(): supersecret", "config: password(): [REDACTED]"],
    ["password(): {nested: secret}", "password(): [REDACTED]"],
  ])("requires an actual method return signature in %s", (input, value) => {
    expect(redactWithRuleCounts(input)).toEqual({ value, rules: ASSIGNMENT_RULE });
  });

  it.each([
    ["password(): string supersecret;", "supersecret"],
    ["token(): void opaque-token;", "opaque-token"],
    ["password(): Promise<string> opaque;", "opaque"],
    [`token(): ${"A".repeat(126)}.T;`, ".T"],
  ])("rejects a trailing value outside the complete return grammar in %s", (input, raw) => {
    const shared = redactWithRuleCounts(input);
    const feedback = sanitizeFeedbackCredentialSpans(input);
    expect(shared.value).toBe(input.slice(0, input.indexOf(":") + 1) + " [REDACTED]");
    expect(shared.rules).toEqual(ASSIGNMENT_RULE);
    expect(feedback.value).toBe(shared.value);
    expect(feedback.rules).toEqual(ASSIGNMENT_RULE);
    expect(feedback.value).not.toContain(raw);
    const prepared = prepareAndVerifySteps(input);
    if (prepared === undefined) return;
    expect(prepared.canonicalJson).not.toContain(raw);
    expectRawStepsRejected(prepared, input);
  });

  it("does not parse qualified-name punctuation beyond the bounded return segment", () => {
    const input = `token(): ${"A".repeat(127)}${".B".repeat(1_000)};`;
    const shared = redactWithRuleCounts(input);
    const feedback = sanitizeFeedbackCredentialSpans(input);
    expect(shared).toEqual({ value: "token(): [REDACTED]", rules: ASSIGNMENT_RULE });
    expect(feedback.value).toBe(shared.value);
    expect(feedback.rules).toEqual(ASSIGNMENT_RULE);
    const prepared = prepareAndVerifySteps(input);
    if (prepared === undefined) return;
    expect(prepared.canonicalJson).not.toContain(".B.B.B");
    expectRawStepsRejected(prepared, input);
  });

  it.each([
    "token(): SessionToken",
    "token(): SessionToken\n",
    "token(): auth.SessionToken;",
    "token(): Promise<SessionToken[]>;",
    "token(): SessionToken[] | null;",
  ])("preserves a complete bounded method return signature in %s", (input) => {
    expect(redactWithRuleCounts(input)).toEqual({ value: input, rules: [] });
    expect(sanitizeFeedbackCredentialSpans(input)).toEqual({
      value: input,
      rules: [],
      dispositions: [],
    });
    expect(prepareAndVerifySteps(input)?.report.steps).toBe(input);
  });

  it("does not clip fail-closed ownership after value whitespace overflow", () => {
    const input = `password=${" ".repeat(4_097)}opaque; token=two\ncontinuation-secret`;
    const shared = redactWithRuleCounts(input);
    const feedback = sanitizeFeedbackCredentialSpans(input);

    expect(shared.value).not.toContain("continuation-secret");
    expect(shared.rules).toEqual(ASSIGNMENT_RULE);
    expect(feedback.value).toBe(shared.value);
    expect(feedback.rules).toEqual(ASSIGNMENT_RULE);
    expect(feedback.dispositions).toEqual([{ action: "quarantined", unitKind: "line-remainder" }]);
    expect(containsCredentialDetection(feedback.value)).toBe(false);
  });

  it.each([
    ['password="one"; token="two"', 'password="[REDACTED]"; token="[REDACTED]"', "quoted-segment"],
    [
      'password={"value":"one"}; token={"value":"two"}',
      "password=[REDACTED]; token=[REDACTED]",
      "structured-value",
    ],
  ] as const)(
    "splits closed values before a proven next assignment in %s",
    (input, value, unitKind) => {
      expect(redactWithRuleCounts(input)).toEqual({ value, rules: TWO_ASSIGNMENT_RULES });
      const feedback = sanitizeFeedbackCredentialSpans(input);
      expect(feedback.value).toBe(value);
      expect(feedback.rules).toEqual(TWO_ASSIGNMENT_RULES);
      expect(feedback.dispositions).toEqual([
        { action: "redacted", unitKind },
        { action: "redacted", unitKind },
      ]);
      expect(containsCredentialDetection(feedback.value)).toBe(false);
    },
  );

  it("does not preserve arbitrary interstitial text before a later credential", () => {
    expect(redactWithRuleCounts("password=one; leaked-middle token=two")).toEqual({
      value: "password=[REDACTED]",
      rules: ASSIGNMENT_RULE,
    });
  });

  it("bounds escaped-quote indexed reads linearly within each scalar span", () => {
    const build = (lines: number): string =>
      Array.from({ length: lines }, () => 'password=opaque\\"').join("\n");
    const small = indexedReadsDuringRedaction(build(20));
    const doubled = indexedReadsDuringRedaction(build(40));

    expect(doubled).toBeLessThan(small * 3);
  });

  it("does not accept a raw suffix after a redacted sentinel", () => {
    expect(redactWithRuleCounts("password=[REDACTED]; correcthorse")).toEqual({
      value: "password=[REDACTED]",
      rules: ASSIGNMENT_RULE,
    });
  });

  it("does not create a redaction span for an empty first value", () => {
    expect(redactWithRuleCounts("password=; token=opaque")).toEqual({
      value: "password=; token=[REDACTED]",
      rules: ASSIGNMENT_RULE,
    });
  });

  it("keeps repeated same-line assignment search work linear through prepare and verify", () => {
    const small = searchedCharactersDuringPublicParity(300);
    const medium = searchedCharactersDuringPublicParity(600);
    const large = searchedCharactersDuringPublicParity(1_200);

    expect(large).toBeLessThan(medium * 3);
    expect(medium).toBeLessThan(small * 3);
  });

  it("keeps repeated closed quoted assignment search work linear through prepare and verify", () => {
    const quoted = (value: string): string => JSON.stringify(value);
    const small = searchedCharactersDuringPublicParity(300, quoted);
    const medium = searchedCharactersDuringPublicParity(600, quoted);
    const large = searchedCharactersDuringPublicParity(1_200, quoted);

    expect(large).toBeLessThan(medium * 3);
    expect(medium).toBeLessThan(small * 3);
  });

  it("keeps repeated closed container assignment search work linear through prepare and verify", () => {
    const container = (): string => '{"v":"opaque"}';
    const small = searchedCharactersDuringPublicParity(300, container);
    const medium = searchedCharactersDuringPublicParity(600, container);
    const large = searchedCharactersDuringPublicParity(1_200, container);

    expect(large).toBeLessThan(medium * 3);
    expect(medium).toBeLessThan(small * 3);
  });
});
