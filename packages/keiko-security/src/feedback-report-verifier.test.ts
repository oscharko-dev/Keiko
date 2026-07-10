import { describe, expect, it } from "vitest";

import {
  FEEDBACK_REPORT_SCHEMA_VERSION,
  type FeedbackReportDraftV1,
  type FeedbackReportV1,
} from "@oscharko-dev/keiko-contracts/feedback-report";

import { prepareFeedbackReportV1 } from "./feedback-report.js";
import { verifyCanonicalFeedbackReportBodyV1 } from "./feedback-report-verifier.js";
import { canonicalise, sha256Hex } from "./hashing.js";

function validDraft(): FeedbackReportDraftV1 {
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
  };
}

function canonicalInput(report: FeedbackReportV1): { bytes: Uint8Array; claimedDigest: string } {
  const json = canonicalise(report);
  return { bytes: new TextEncoder().encode(json), claimedDigest: sha256Hex(json) };
}

function encodedInput(json: string): { bytes: Uint8Array; claimedDigest: string } {
  return { bytes: new TextEncoder().encode(json), claimedDigest: sha256Hex(json) };
}

describe("verifyCanonicalFeedbackReportBodyV1", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["number", 1],
    ["string", "body"],
    ["boolean", true],
    ["array", []],
    ["empty record", {}],
    [
      "record with an unknown key",
      { bytes: new Uint8Array(), claimedDigest: "0".repeat(64), unexpected: true },
    ],
  ])("rejects %s verifier input without throwing", (_label, input) => {
    expect(verifyCanonicalFeedbackReportBodyV1(input)).toEqual({
      ok: false,
      error: { code: "invalid-body" },
    });
  });

  it("fails closed when an input wrapper throws while reading a known field", () => {
    const wrapper = Object.defineProperties(
      {},
      {
        bytes: {
          enumerable: true,
          get: (): never => {
            throw new Error("untrusted getter");
          },
        },
        claimedDigest: { enumerable: true, value: "0".repeat(64) },
      },
    );

    expect(verifyCanonicalFeedbackReportBodyV1(wrapper)).toEqual({
      ok: false,
      error: { code: "invalid-body" },
    });
  });

  it.each([
    [
      "prototype trap",
      new Proxy(
        {},
        {
          getPrototypeOf: (): never => {
            throw new Error("prototype trap");
          },
        },
      ),
    ],
    [
      "own-key trap",
      new Proxy(
        {},
        {
          ownKeys: (): never => {
            throw new Error("own-key trap");
          },
        },
      ),
    ],
    [
      "descriptor trap",
      new Proxy(
        { bytes: new Uint8Array(), claimedDigest: "0".repeat(64) },
        {
          getOwnPropertyDescriptor: (): never => {
            throw new Error("descriptor trap");
          },
        },
      ),
    ],
  ])("fails closed for an input proxy with a throwing %s", (_label, input) => {
    expect(verifyCanonicalFeedbackReportBodyV1(input)).toEqual({
      ok: false,
      error: { code: "invalid-body" },
    });
  });

  it("fails closed for a revoked top-level input proxy", () => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    expect(verifyCanonicalFeedbackReportBodyV1(revocable.proxy)).toEqual({
      ok: false,
      error: { code: "invalid-body" },
    });
  });

  it.each([
    ["typed-array accessors", new Proxy(new Uint8Array([0x7b]), {})],
    [
      "prototype lookup",
      new Proxy(new Uint8Array([0x7b]), {
        getPrototypeOf: (): never => {
          throw new Error("byte prototype trap");
        },
      }),
    ],
  ])("fails closed for a proxied byte view with hostile %s", (_label, bytes) => {
    expect(verifyCanonicalFeedbackReportBodyV1({ bytes, claimedDigest: "0".repeat(64) })).toEqual({
      ok: false,
      error: { code: "invalid-body" },
    });
  });

  it("snapshots a byte-view subclass without dispatching its slice override", () => {
    const prepared = prepareFeedbackReportV1(validDraft());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    let sliceCalls = 0;
    let speciesCalls = 0;
    class HostileBytes extends Uint8Array {
      public static get [Symbol.species](): typeof Uint8Array {
        speciesCalls += 1;
        throw new Error("species must not be consulted");
      }

      public override slice(): Uint8Array<ArrayBuffer> {
        sliceCalls += 1;
        return new Proxy(new Uint8Array(), {});
      }
    }
    const bytes = new HostileBytes(prepared.value.canonicalBody.copyBytes());

    const verified = verifyCanonicalFeedbackReportBodyV1({
      bytes,
      claimedDigest: prepared.value.exactBodySha256,
    });

    expect(verified.ok).toBe(true);
    expect(sliceCalls).toBe(0);
    expect(speciesCalls).toBe(0);
    if (!verified.ok) return;
    expect(Object.getPrototypeOf(verified.value.canonicalBody.copyBytes())).toBe(
      Uint8Array.prototype,
    );
  });

  it.each([
    [
      "own-key trap",
      new Proxy(
        {},
        {
          ownKeys: (): never => {
            throw new Error("policy own-key trap");
          },
        },
      ),
    ],
    [
      "known-field getter",
      Object.defineProperty({}, "sensitiveLiterals", {
        enumerable: true,
        get: (): never => {
          throw new Error("policy getter");
        },
      }),
    ],
  ])("fails closed for a hostile policy %s", (_label, policy) => {
    const prepared = prepareFeedbackReportV1(validDraft());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    expect(
      verifyCanonicalFeedbackReportBodyV1({
        bytes: prepared.value.canonicalBody.copyBytes(),
        claimedDigest: prepared.value.exactBodySha256,
        policy,
      }),
    ).toEqual({ ok: false, error: { code: "invalid-policy" } });
  });

  it("rejects an explicit null policy while defaulting a missing or undefined policy", () => {
    const prepared = prepareFeedbackReportV1(validDraft());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const input = {
      bytes: prepared.value.canonicalBody.copyBytes(),
      claimedDigest: prepared.value.exactBodySha256,
    };

    expect(verifyCanonicalFeedbackReportBodyV1({ ...input, policy: null })).toEqual({
      ok: false,
      error: { code: "invalid-policy" },
    });
    expect(verifyCanonicalFeedbackReportBodyV1(input).ok).toBe(true);
    expect(verifyCanonicalFeedbackReportBodyV1({ ...input, policy: undefined }).ok).toBe(true);
  });

  it("accepts the exact canonical bytes and digest produced by the local engine", () => {
    const prepared = prepareFeedbackReportV1(validDraft());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const verified = verifyCanonicalFeedbackReportBodyV1({
      bytes: prepared.value.canonicalBody.copyBytes(),
      claimedDigest: prepared.value.exactBodySha256,
    });

    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.value.report).toEqual(prepared.value.report);
    expect(verified.value.canonicalJson).toBe(prepared.value.canonicalJson);
    expect(verified.value.canonicalBody.copyBytes()).toEqual(
      prepared.value.canonicalBody.copyBytes(),
    );
    expect(verified.value.exactBodySha256).toBe(prepared.value.exactBodySha256);
  });

  it("returns a frozen report and defensive copies of the verified canonical body", () => {
    const prepared = prepareFeedbackReportV1(validDraft());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const verified = verifyCanonicalFeedbackReportBodyV1({
      bytes: prepared.value.canonicalBody.copyBytes(),
      claimedDigest: prepared.value.exactBodySha256,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    const first = verified.value.canonicalBody.copyBytes();
    first[0] = 0;
    const second = verified.value.canonicalBody.copyBytes();

    expect(new TextDecoder().decode(second)).toBe(verified.value.canonicalJson);
    expect(sha256Hex(verified.value.canonicalJson)).toBe(verified.value.exactBodySha256);
    expect(Object.isFrozen(verified.value)).toBe(true);
    expect(Object.isFrozen(verified.value.report)).toBe(true);
    expect(Object.isFrozen(verified.value.report.summary)).toBe(true);
    expect(Object.isFrozen(verified.value.report.redactionProvenance.rules)).toBe(true);
  });

  it("rejects canonical text that the authoritative redactor would change", () => {
    const prepared = prepareFeedbackReportV1(validDraft());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const report = {
      ...prepared.value.report,
      summary: { ...prepared.value.report.summary, description: "Bearer opaque-token-value" },
    };

    expect(verifyCanonicalFeedbackReportBodyV1(canonicalInput(report))).toEqual({
      ok: false,
      error: { code: "unsafe-content" },
    });
  });

  it.each([
    ["timestamped log", "2026-07-09T18:10:11Z ERROR worker failed"],
    ["stack records", "at first (src/a.ts:1:2)\nat second (src/b.ts:3:4)"],
    ["personal identifier", "IBAN DE89 3704 0044 0532 0130 00"],
    ["binary magic", "%PDF-1.7"],
  ])("rejects canonical %s content", (_label, description) => {
    const prepared = prepareFeedbackReportV1(validDraft());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const report = {
      ...prepared.value.report,
      summary: { ...prepared.value.report.summary, description },
    };

    expect(verifyCanonicalFeedbackReportBodyV1(canonicalInput(report))).toEqual({
      ok: false,
      error: { code: "unsafe-content" },
    });
  });

  it("rejects trusted customer identifiers and residual absolute paths", () => {
    const prepared = prepareFeedbackReportV1(validDraft());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const customerReport = {
      ...prepared.value.report,
      summary: { ...prepared.value.report.summary, description: "Affected customer-atlas" },
    };
    const sensitiveReport = {
      ...prepared.value.report,
      summary: { ...prepared.value.report.summary, description: "Used internal.corp.example" },
    };
    const pathReport = {
      ...prepared.value.report,
      summary: { ...prepared.value.report.summary, description: "Read /private/customer.txt" },
    };

    expect(
      verifyCanonicalFeedbackReportBodyV1({
        ...canonicalInput(customerReport),
        policy: { customerIdentifierLiterals: ["customer-atlas"] },
      }),
    ).toEqual({ ok: false, error: { code: "unsafe-content" } });
    expect(
      verifyCanonicalFeedbackReportBodyV1({
        ...canonicalInput(sensitiveReport),
        policy: { sensitiveLiterals: ["internal.corp.example"] },
      }),
    ).toEqual({ ok: false, error: { code: "unsafe-content" } });
    expect(verifyCanonicalFeedbackReportBodyV1(canonicalInput(pathReport))).toEqual({
      ok: false,
      error: { code: "invalid-report" },
    });
  });

  it("rejects noncanonical and duplicate-key JSON even when their digests match", () => {
    const prepared = prepareFeedbackReportV1(validDraft());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const noncanonical = JSON.stringify(prepared.value.report);
    const duplicate = `{"summary":"duplicate",${prepared.value.canonicalJson.slice(1)}`;

    expect(verifyCanonicalFeedbackReportBodyV1(encodedInput(noncanonical))).toEqual({
      ok: false,
      error: { code: "noncanonical-body" },
    });
    expect(verifyCanonicalFeedbackReportBodyV1(encodedInput(duplicate))).toEqual({
      ok: false,
      error: { code: "noncanonical-body" },
    });
  });

  it("rejects digest mismatch, a BOM, and an oversized body content-free", () => {
    const prepared = prepareFeedbackReportV1(validDraft());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const bytes = prepared.value.canonicalBody.copyBytes();

    expect(verifyCanonicalFeedbackReportBodyV1({ bytes, claimedDigest: "0".repeat(64) })).toEqual({
      ok: false,
      error: { code: "digest-mismatch" },
    });
    expect(
      verifyCanonicalFeedbackReportBodyV1({
        bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]),
        claimedDigest: prepared.value.exactBodySha256,
      }),
    ).toEqual({ ok: false, error: { code: "bom-not-allowed" } });
    expect(
      verifyCanonicalFeedbackReportBodyV1({
        bytes: new Uint8Array(256 * 1024 + 1),
        claimedDigest: "0".repeat(64),
      }),
    ).toEqual({ ok: false, error: { code: "body-byte-limit" } });
  });

  it("rejects malformed UTF-8 before parsing", () => {
    expect(
      verifyCanonicalFeedbackReportBodyV1({
        bytes: new Uint8Array([0xc3, 0x28]),
        claimedDigest: "0".repeat(64),
      }),
    ).toEqual({ ok: false, error: { code: "invalid-utf8" } });
  });
});
