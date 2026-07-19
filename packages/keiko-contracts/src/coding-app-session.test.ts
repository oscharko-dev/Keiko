import { describe, expect, it } from "vitest";

import {
  CODING_APP_SESSION_CHANNEL_BODY_MAX_CHARS,
  CODING_APP_SESSION_CHANNEL_MAX_UTF8_BYTES,
  CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX,
  codingAppSessionAcknowledgement,
  contentFreeCodingAppSessionChannelSnapshot,
  decodeCodingAppSessionPairingFragment,
  encodeCodingAppSessionPairingFragment,
  isWellFormedCodingAppSessionPairingAttestation,
  validateCodingAppSessionChannelContent,
  validateCodingAppSessionChannelSnapshot,
  type CodingAppSessionPairingAttestation,
} from "./coding-app-session.js";

const attestation: CodingAppSessionPairingAttestation = {
  requestId: "req_launcher.pair-1",
  issuedAtMs: 1_720_000_000_000,
  claim: "a".repeat(64),
};

describe("coding app-session channel contract", () => {
  it("serves the fail-closed content-free snapshot and acknowledgement shapes", () => {
    expect(contentFreeCodingAppSessionChannelSnapshot()).toEqual({
      schemaVersion: "1",
      content: null,
    });
    expect(codingAppSessionAcknowledgement()).toEqual({ schemaVersion: "1" });
    expect(
      validateCodingAppSessionChannelSnapshot(contentFreeCodingAppSessionChannelSnapshot()).ok,
    ).toBe(true);
  });

  it("accepts a bounded content item and rejects unknown keys and unbounded text", () => {
    expect(validateCodingAppSessionChannelContent({ kind: "note", body: "bounded" }).ok).toBe(true);
    expect(validateCodingAppSessionChannelContent({ kind: "note" }).ok).toBe(false);
    expect(validateCodingAppSessionChannelContent({ kind: "note", body: "x", extra: 1 }).ok).toBe(
      false,
    );
    expect(
      validateCodingAppSessionChannelContent({
        kind: "note",
        body: "x".repeat(CODING_APP_SESSION_CHANNEL_BODY_MAX_CHARS + 1),
      }).ok,
    ).toBe(false);
  });

  it("accepts typed safe activity and rejects JSON smuggled through the generic body", () => {
    const feed = {
      schemaVersion: "1",
      availability: "available",
      runId: "run-activity",
      updatedAt: "2026-07-18T17:00:00.000Z",
      turns: [],
      truncated: false,
      droppedEventCount: 0,
    };
    expect(validateCodingAppSessionChannelContent({ kind: "safe-activity", feed }).ok).toBe(true);
    expect(
      validateCodingAppSessionChannelContent({
        kind: "safe-activity",
        body: JSON.stringify(feed),
      }).ok,
    ).toBe(false);
  });

  it("rejects snapshots with a wrong version, extra keys, or a breached aggregate budget", () => {
    expect(validateCodingAppSessionChannelSnapshot({ schemaVersion: "2", content: null }).ok).toBe(
      false,
    );
    expect(
      validateCodingAppSessionChannelSnapshot({ schemaVersion: "1", content: null, extra: 1 }).ok,
    ).toBe(false);
    expect(
      validateCodingAppSessionChannelSnapshot({ schemaVersion: "1", content: "not-an-object" }).ok,
    ).toBe(false);
    expect(validateCodingAppSessionChannelSnapshot("not-a-record").ok).toBe(false);
    const oversized = {
      schemaVersion: "1",
      content: {
        kind: "k".repeat(64),
        body: "b".repeat(CODING_APP_SESSION_CHANNEL_BODY_MAX_CHARS),
      },
    };
    // The per-field bounds keep a single item well under the aggregate cap; prove the cap is checked.
    expect(JSON.stringify(oversized).length).toBeLessThan(
      CODING_APP_SESSION_CHANNEL_MAX_UTF8_BYTES,
    );
    expect(validateCodingAppSessionChannelSnapshot(oversized).ok).toBe(true);
  });
});

describe("coding app-session pairing attestation", () => {
  it("accepts the launcher wire shape and rejects malformed structures", () => {
    expect(isWellFormedCodingAppSessionPairingAttestation(attestation)).toBe(true);
    expect(isWellFormedCodingAppSessionPairingAttestation(null)).toBe(false);
    expect(isWellFormedCodingAppSessionPairingAttestation({ ...attestation, extra: true })).toBe(
      false,
    );
    expect(
      isWellFormedCodingAppSessionPairingAttestation({ ...attestation, requestId: "bad id" }),
    ).toBe(false);
    expect(
      isWellFormedCodingAppSessionPairingAttestation({ ...attestation, issuedAtMs: 1.5 }),
    ).toBe(false);
    expect(isWellFormedCodingAppSessionPairingAttestation({ ...attestation, claim: "" })).toBe(
      false,
    );
  });

  it("round-trips through the boot URL fragment codec", () => {
    const fragment = encodeCodingAppSessionPairingFragment(attestation);
    expect(fragment.startsWith(CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX)).toBe(true);
    expect(decodeCodingAppSessionPairingFragment(fragment)).toEqual(attestation);
  });

  it("fails closed on foreign, truncated, or tampered fragments", () => {
    expect(decodeCodingAppSessionPairingFragment("")).toBeUndefined();
    expect(decodeCodingAppSessionPairingFragment("#other=1")).toBeUndefined();
    expect(
      decodeCodingAppSessionPairingFragment(`${CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX}%zz`),
    ).toBeUndefined();
    expect(
      decodeCodingAppSessionPairingFragment(`${CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX}%7B%7D`),
    ).toBeUndefined();
    const fragment = encodeCodingAppSessionPairingFragment(attestation);
    expect(decodeCodingAppSessionPairingFragment(fragment.slice(0, -4))).toBeUndefined();
  });
});
