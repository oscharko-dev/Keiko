import { createPublicKey, verify, webcrypto } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  BROWSER_APPROVAL_CHALLENGE_TTL_MS,
  BROWSER_APPROVAL_MAX_RECORDS,
  BROWSER_APPROVAL_REMEMBER_TTL_MS,
  BROWSER_APPROVAL_REQUEST_TTL_MS,
  browserApprovalChallengeText,
  isBrowserApprovalPublicKey,
  validateBrowserApprovalChallenge,
  validateBrowserApprovalChallengeInput,
  validateBrowserApprovalDecisionInput,
  validateBrowserApprovalProofInput,
  validateBrowserApprovalRequestInput,
  validateBrowserApprovalRequestResult,
  validateBrowserApprovalChallengeResult,
  validateBrowserApprovalDecisionResult,
  validateBrowserApprovalManagementResult,
  validateBrowserApprovalProofResult,
  type BrowserApprovalDescriptor,
  type BrowserApprovalProofResult,
  type BrowserApprovalRequestDescriptor,
  type BrowserApprovalChallenge,
} from "./browser-approval.js";

function challenge(): BrowserApprovalChallenge {
  return {
    schemaVersion: 1,
    challengeId: `bch_${"a".repeat(32)}`,
    purpose: "complete",
    subjectId: `brq_${"b".repeat(32)}`,
    installationId: "c".repeat(32),
    serverInstanceId: "d".repeat(32),
    origin: "http://127.0.0.1:1983",
    nonce: "A".repeat(43),
    issuedAtMs: 1_000,
    expiresAtMs: 1_000 + BROWSER_APPROVAL_CHALLENGE_TTL_MS,
  };
}

function requestDescriptor(index = 1): BrowserApprovalRequestDescriptor {
  return {
    requestId: `brq_${index.toString(16).padStart(32, "0")}`,
    comparisonCode: "01234567",
    requestedAtMs: 1_000,
    expiresAtMs: 1_000 + BROWSER_APPROVAL_REQUEST_TTL_MS,
    rememberRequested: false,
    publicKeyFingerprint: "a".repeat(64),
  };
}

function approvalDescriptor(index = 1): BrowserApprovalDescriptor {
  return {
    approvalId: `bra_${index.toString(16).padStart(32, "0")}`,
    remembered: true,
    approvedAtMs: 1_000,
    expiresAtMs: 1_000 + BROWSER_APPROVAL_REMEMBER_TTL_MS,
    lastUsedAtMs: 1_000,
    publicKeyFingerprint: "a".repeat(64),
  };
}

describe("browser approval response boundaries", () => {
  it("accepts the explicit request, challenge, proof and decision states", () => {
    expect(
      validateBrowserApprovalRequestResult({ state: "pending", request: requestDescriptor() }).ok,
    ).toBe(true);
    expect(
      validateBrowserApprovalChallengeResult({ state: "challenge", challenge: challenge() }).ok,
    ).toBe(true);
    expect(validateBrowserApprovalChallengeResult({ state: "pending" }).ok).toBe(true);
    expect(validateBrowserApprovalProofResult({ state: "active" }).ok).toBe(true);
    expect(
      validateBrowserApprovalProofResult({ state: "active", approval: approvalDescriptor() }).ok,
    ).toBe(true);
    expect(validateBrowserApprovalDecisionResult({ state: "accepted" }).ok).toBe(true);
  });

  it("does not treat an unavailable acknowledgement as active authority", () => {
    for (const validate of [
      validateBrowserApprovalRequestResult,
      validateBrowserApprovalChallengeResult,
      validateBrowserApprovalProofResult,
      validateBrowserApprovalDecisionResult,
      validateBrowserApprovalManagementResult,
    ]) {
      expect(validate({ state: "unavailable" }).ok).toBe(true);
      expect(validate({ state: "unavailable", approval: approvalDescriptor() }).ok).toBe(false);
      for (const malformed of [null, [], "active", { state: "accepted", privateKey: {} }]) {
        expect(validate(malformed).ok).toBe(false);
      }
    }
  });

  it.each([
    { expiresAtMs: 1_000 },
    { expiresAtMs: 1_001 + BROWSER_APPROVAL_REQUEST_TTL_MS },
    { requestedAtMs: Number.NaN },
    { comparisonCode: "1234567" },
    { rememberRequested: "true" },
    { publicKeyFingerprint: "not-a-fingerprint" },
    { privateKey: { d: "synthetic-refused-key-material" } },
  ])("refuses malformed request descriptors %j", (patch) => {
    expect(
      validateBrowserApprovalRequestResult({
        state: "pending",
        request: { ...requestDescriptor(), ...patch },
      }).ok,
    ).toBe(false);
  });

  it.each([
    { remembered: "true" },
    { remembered: undefined },
    { expiresAtMs: 1_001 + BROWSER_APPROVAL_REMEMBER_TTL_MS },
    { lastUsedAtMs: Number.POSITIVE_INFINITY },
    { lastUsedAtMs: 999 },
    { lastUsedAtMs: 1_000 + BROWSER_APPROVAL_REMEMBER_TTL_MS },
    { lastUsedAtMs: 1_001 + BROWSER_APPROVAL_REMEMBER_TTL_MS },
    { privateKey: {} },
  ])("refuses malformed proof descriptors %j", (patch) => {
    expect(
      validateBrowserApprovalProofResult({
        state: "active",
        approval: { ...approvalDescriptor(), ...patch },
      }).ok,
    ).toBe(false);
  });

  it("retains the exact valid last-use bounds independently of a browser clock", () => {
    const approval = approvalDescriptor();
    for (const lastUsedAtMs of [approval.approvedAtMs, approval.expiresAtMs - 1]) {
      expect(
        validateBrowserApprovalProofResult({
          state: "active",
          approval: { ...approval, lastUsedAtMs },
        }).ok,
      ).toBe(true);
    }
  });

  it("bounds each existing management inventory and refuses duplicate identities", () => {
    const requests = Array.from({ length: BROWSER_APPROVAL_MAX_RECORDS }, (_, index) =>
      requestDescriptor(index + 1),
    );
    const approvals = Array.from({ length: BROWSER_APPROVAL_MAX_RECORDS * 2 }, (_, index) =>
      approvalDescriptor(index + 1),
    );
    const snapshot = { state: "active", requests, approvals };
    expect(validateBrowserApprovalManagementResult(snapshot).ok).toBe(true);
    expect(
      validateBrowserApprovalManagementResult({ ...snapshot, requests: [...requests, requests[0]] })
        .ok,
    ).toBe(false);
    expect(
      validateBrowserApprovalManagementResult({
        ...snapshot,
        approvals: [...approvals, approvals[0]],
      }).ok,
    ).toBe(false);
    expect(
      validateBrowserApprovalManagementResult({ ...snapshot, requests: [requests[0], requests[0]] })
        .ok,
    ).toBe(false);
    expect(
      validateBrowserApprovalManagementResult({
        ...snapshot,
        approvals: [approvals[0], approvals[0]],
      }).ok,
    ).toBe(false);
    expect(
      validateBrowserApprovalManagementResult({ ...snapshot, authority: "full-access" }).ok,
    ).toBe(false);
  });
});

describe("browser approval wire boundaries", () => {
  it("accepts only public canonical coordinates and explicit remember intent", () => {
    const publicKey = { x: "A".repeat(43), y: "A".repeat(43) };
    expect(validateBrowserApprovalRequestInput({ publicKey, remember: false }).ok).toBe(true);
    expect(validateBrowserApprovalRequestInput({ publicKey }).ok).toBe(false);
    expect(isBrowserApprovalPublicKey({ ...publicKey, d: "A".repeat(43) })).toBe(false);
    expect(isBrowserApprovalPublicKey({ ...publicKey, x: `${"A".repeat(42)}B` })).toBe(false);
    expect(isBrowserApprovalPublicKey({ ...publicKey, kty: "RSA" })).toBe(false);
  });

  it("binds explicit decisions to one request and comparison code", () => {
    const decision = {
      requestId: `brq_${"a".repeat(32)}`,
      comparisonCode: "01234567",
      remember: false,
    };
    expect(validateBrowserApprovalDecisionInput(decision).ok).toBe(true);
    expect(
      validateBrowserApprovalDecisionInput({ ...decision, comparisonCode: "1234567" }).ok,
    ).toBe(false);
    expect(validateBrowserApprovalDecisionInput({ ...decision, remember: "true" }).ok).toBe(false);
    expect(validateBrowserApprovalDecisionInput({ ...decision, authority: "full-access" }).ok).toBe(
      false,
    );
  });

  it.each([
    { purpose: "complete", subjectId: `bra_${"a".repeat(32)}` },
    { purpose: "renew", subjectId: `brq_${"a".repeat(32)}` },
    { purpose: "approve", subjectId: `brq_${"a".repeat(32)}` },
    { purpose: "renew", subjectId: "../approval" },
  ])("refuses cross-purpose or malformed subjects: $purpose", (value) => {
    expect(validateBrowserApprovalChallengeInput(value).ok).toBe(false);
  });

  it.each([
    { origin: "http://127.0.0.1:1983/path" },
    { origin: "http://user@127.0.0.1:1983" },
    { origin: "https://example.invalid" },
    { origin: "http://127.0.0.1:1983#fragment" },
    { nonce: `${"A".repeat(42)}B` },
    { expiresAtMs: 1_000 },
    { expiresAtMs: 1_001 + BROWSER_APPROVAL_CHALLENGE_TTL_MS },
    { issuedAtMs: Number.NaN },
    { serverInstanceId: "foreign" },
    { schemaVersion: 2 },
  ])("refuses malformed or unbounded challenge fields: %j", (patch) => {
    expect(validateBrowserApprovalChallenge({ ...challenge(), ...patch }).ok).toBe(false);
  });

  it("refuses noncanonical signature bytes before cryptographic verification", () => {
    const proof = { challengeId: challenge().challengeId, signature: "A".repeat(86) };
    expect(validateBrowserApprovalProofInput(proof).ok).toBe(true);
    expect(
      validateBrowserApprovalProofInput({ ...proof, signature: `${"A".repeat(85)}B` }).ok,
    ).toBe(false);
    expect(validateBrowserApprovalProofInput({ ...proof, signature: "A".repeat(85) }).ok).toBe(
      false,
    );
    expect(validateBrowserApprovalProofInput({ ...proof, publicKey: {} }).ok).toBe(false);
  });
});

describe("browser/server proof interoperability", () => {
  it("verifies real WebCrypto signatures and rejects every changed authority binding", async () => {
    const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]);
    const jwk = await webcrypto.subtle.exportKey("jwk", keys.publicKey);
    const value = challenge();
    expect(validateBrowserApprovalChallenge(value).ok).toBe(true);
    const bytes = new TextEncoder().encode(browserApprovalChallengeText(value));
    const signed = Buffer.from(
      await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, bytes),
    );
    const publicKey = createPublicKey({ key: jwk, format: "jwk" });
    const options = { key: publicKey, dsaEncoding: "ieee-p1363" as const };
    expect(verify("sha256", bytes, options, signed)).toBe(true);
    expect(
      validateBrowserApprovalProofInput({
        challengeId: value.challengeId,
        signature: signed.toString("base64url"),
      }).ok,
    ).toBe(true);
    for (const patch of changedBindings()) {
      expect(
        verify(
          "sha256",
          new TextEncoder().encode(browserApprovalChallengeText({ ...value, ...patch })),
          options,
          signed,
        ),
      ).toBe(false);
    }
  });
});

function changedBindings(): readonly Partial<BrowserApprovalChallenge>[] {
  return [
    { purpose: "renew" },
    { subjectId: `bra_${"e".repeat(32)}` },
    { challengeId: `bch_${"e".repeat(32)}` },
    { installationId: "e".repeat(32) },
    { serverInstanceId: "e".repeat(32) },
    { origin: "http://127.0.0.1:1984" },
    { nonce: "B".repeat(42) + "A" },
    { issuedAtMs: 1_001 },
    { expiresAtMs: 2_000 },
  ];
}

const browserPhysicalInventories = ["requests", "approvals"] as const;

function browserInventoryMember(
  field: "requests" | "approvals",
): BrowserApprovalRequestDescriptor | BrowserApprovalDescriptor {
  return field === "requests" ? requestDescriptor() : approvalDescriptor();
}

describe("browser management physical inventory admission", () => {
  for (const field of browserPhysicalInventories) {
    it(`retains the original dense ${field} and result references`, () => {
      const value = {
        state: "active",
        requests: [],
        approvals: [],
        [field]: [browserInventoryMember(field)],
      };
      const result = validateBrowserApprovalManagementResult(value);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(value);
    });
    it(`refuses a one-hole ${field} inventory`, () => {
      const members: unknown[] = [browserInventoryMember(field)];
      expect(Reflect.deleteProperty(members, "0")).toBe(true);
      const value = { state: "active", requests: [], approvals: [], [field]: members };
      expect(validateBrowserApprovalManagementResult(value)).toEqual({
        ok: false,
        errors: [`browser management ${field} are invalid`],
      });
    });
    it(`refuses invalid ${field} despite caller every and map overrides`, () => {
      const members: unknown[] = [{}];
      let calls = 0;
      Object.defineProperties(members, {
        every: {
          value: (): boolean => {
            calls += 1;
            return true;
          },
        },
        map: {
          value: (): string[] => {
            calls += 1;
            return ["forged"];
          },
        },
      });
      const result = validateBrowserApprovalManagementResult({
        state: "active",
        requests: [],
        approvals: [],
        [field]: members,
      });
      expect(result.ok).toBe(false);
      expect(calls).toBe(0);
    });
    it(`refuses duplicate ${field} despite a caller map inventing unique identities`, () => {
      const member = browserInventoryMember(field);
      const members = [member, member];
      let calls = 0;
      Object.defineProperty(members, "map", {
        value: (): string[] => {
          calls += 1;
          return ["first", "second"];
        },
      });
      const result = validateBrowserApprovalManagementResult({
        state: "active",
        requests: [],
        approvals: [],
        [field]: members,
      });
      expect(result.ok).toBe(false);
      expect(calls).toBe(0);
    });
  }
  it("retains own undefined approval and truthful presence types", () => {
    type ActiveProof = Extract<BrowserApprovalProofResult, { readonly state: "active" }>;
    expectTypeOf<Required<ActiveProof>["approval"]>().toEqualTypeOf<
      BrowserApprovalDescriptor | undefined
    >();
    const value = { state: "active", approval: undefined };
    const result = validateBrowserApprovalProofResult(value);
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.state !== "active") throw new TypeError("Expected active proof");
    expect(result.value).toBe(value);
    expect(Object.hasOwn(result.value, "approval")).toBe(true);
    if ("approval" in result.value) {
      expectTypeOf(result.value.approval).toEqualTypeOf<BrowserApprovalDescriptor | undefined>();
      expect(result.value.approval).toBeUndefined();
    }
  });
});

interface BrowserSecondObservationFixture {
  readonly value: {
    readonly state: "active";
    readonly requests: readonly unknown[];
    readonly approvals: readonly unknown[];
  };
  readonly members: readonly unknown[];
  readonly receivers: readonly unknown[];
  readonly reads: () => number;
}

function browserSecondObservation(
  field: "requests" | "approvals",
  second: unknown,
): BrowserSecondObservationFixture {
  const first = browserInventoryMember(field);
  const members: unknown[] = [first];
  const receivers: unknown[] = [];
  let reads = 0;
  Object.defineProperty(members, "0", {
    configurable: true,
    get(this: unknown): unknown {
      receivers.push(this);
      reads += 1;
      return reads === 1 ? first : second;
    },
  });
  return {
    value: {
      state: "active",
      requests: field === "requests" ? members : [],
      approvals: field === "approvals" ? members : [],
    },
    members,
    receivers,
    reads: (): number => reads,
  };
}

describe("browser management consumed second observation", () => {
  for (const field of browserPhysicalInventories) {
    it(`refuses ${field} whose second physical observation is not a descriptor`, () => {
      const fixture = browserSecondObservation(field, {});
      const result = validateBrowserApprovalManagementResult(fixture.value);
      expect(result.ok).toBe(false);
      expect(fixture.reads()).toBe(2);
      expect(fixture.receivers).toHaveLength(2);
      expect(fixture.receivers[0]).toBe(fixture.members);
      expect(fixture.receivers[1]).toBe(fixture.members);
    });
    it(`retains a healthy independent second ${field} descriptor observation`, () => {
      const second = field === "requests" ? requestDescriptor(2) : approvalDescriptor(2);
      const fixture = browserSecondObservation(field, second);
      const result = validateBrowserApprovalManagementResult(fixture.value);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(fixture.value);
      expect(fixture.reads()).toBe(2);
      expect(fixture.receivers).toHaveLength(2);
      expect(fixture.receivers[0]).toBe(fixture.members);
      expect(fixture.receivers[1]).toBe(fixture.members);
    });
  }
});
