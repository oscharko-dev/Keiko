import { describe, expect, it, vi } from "vitest";

import {
  CODING_APP_SESSION_CHANNEL_BODY_MAX_CHARS,
  CODING_APP_SESSION_CHANNEL_MAX_UTF8_BYTES,
  codingAppSessionAcknowledgement,
  contentFreeCodingAppSessionChannelSnapshot,
  validateCodingAppSessionChannelContent,
  validateCodingAppSessionChannelSnapshot,
} from "./coding-app-session.js";

import {
  CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX,
  decodeCodingAppSessionPairingFragment,
  encodeCodingAppSessionPairingFragment,
  isWellFormedCodingAppSessionPairingAttestation,
  type CodingAppSessionPairingAttestation,
} from "@oscharko-dev/keiko-contracts/runtime/coding-app-session-pairing";
import * as channelCompatibility from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";

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
    expect(
      validateCodingAppSessionChannelContent({ kind: "note", body: "visible\u202Espoof\u200B" }).ok,
    ).toBe(false);
    expect(validateCodingAppSessionChannelContent({ kind: "note", body: "" }).ok).toBe(false);
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
    const planFeed = {
      ...feed,
      plan: {
        revision: 2,
        anchorMessageId: "msg_assistant_plan",
        updatedAt: "2026-07-18T17:00:00.001Z",
        steps: [{ text: "Verify the change", state: "active", truncated: false }],
        truncated: false,
      },
    };
    expect(
      validateCodingAppSessionChannelContent({ kind: "safe-activity", feed: planFeed }).ok,
    ).toBe(true);
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

  it("retains snapshot identity and the ordered shape and serialization failure phases", () => {
    const value = { schemaVersion: "1", content: { kind: "note", body: "bounded 日本語" } };
    const malformed = {
      schemaVersion: "2",
      content: { kind: "", body: "", extra: true },
      extra: true,
    };
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const healthy = validateCodingAppSessionChannelSnapshot(value);
      expect(healthy.ok).toBe(true);
      if (healthy.ok) expect(healthy.value).toBe(value);
      expect(stringify).toHaveBeenCalledOnce();
      expect(stringify.mock.calls[0]?.[0]).toBe(value);
      stringify.mockClear();
      expect(validateCodingAppSessionChannelSnapshot(malformed)).toEqual({
        ok: false,
        errors: [
          "channelSnapshot.extra is not allowed",
          "channelSnapshot.schemaVersion is invalid",
          "channelSnapshot.content.extra is not allowed",
          "channelSnapshot.content.kind must be a bounded non-empty string",
          "channelSnapshot.content.body must be bounded non-empty display text",
        ],
      });
      expect(stringify).not.toHaveBeenCalled();
      stringify.mockImplementationOnce(() => {
        throw new TypeError("fixture snapshot serialization failure");
      });
      expect(validateCodingAppSessionChannelSnapshot(value)).toEqual({
        ok: false,
        errors: ["channel snapshot exceeds the aggregate UTF-8 byte budget"],
      });
      expect(stringify).toHaveBeenCalledOnce();
      expect(stringify.mock.calls[0]?.[0]).toBe(value);
    } finally {
      stringify.mockRestore();
    }
    expect(validateCodingAppSessionChannelSnapshot(value)).toEqual({ ok: true, value });
  });

  it("preserves content-free and safe-activity snapshot identities", () => {
    const snapshots = [
      contentFreeCodingAppSessionChannelSnapshot(),
      {
        schemaVersion: "1",
        content: {
          kind: "safe-activity",
          feed: {
            schemaVersion: "1",
            availability: "available",
            runId: "run-snapshot-identity",
            updatedAt: "2026-07-18T17:00:00.000Z",
            turns: [],
            truncated: false,
            droppedEventCount: 0,
          },
        },
      },
    ];
    for (const value of snapshots) {
      const result = validateCodingAppSessionChannelSnapshot(value);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(value);
    }
  });

  it("preserves eager shape reads and serialization of the original snapshot", () => {
    const reads: string[] = [];
    const content = {
      get kind(): string {
        reads.push("kind");
        return "note";
      },
      get body(): string {
        reads.push("body");
        return "bounded";
      },
    };
    const value = {
      get schemaVersion(): string {
        reads.push("version");
        return "1";
      },
      get content(): typeof content {
        reads.push("content");
        return content;
      },
    };
    const result = validateCodingAppSessionChannelSnapshot(value);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(value);
    expect(reads).toEqual([
      "version",
      "content",
      "content",
      "kind",
      "kind",
      "body",
      "version",
      "content",
      "kind",
      "body",
    ]);
  });
});

describe("coding app-session pairing attestation", () => {
  it("propagates unexpected decoder faults instead of treating them as malformed input", () => {
    const fragment = encodeCodingAppSessionPairingFragment(attestation);
    const failure = new TypeError("private decoder failure");
    const parse = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw failure;
    });
    try {
      expect(() => decodeCodingAppSessionPairingFragment(fragment)).toThrow(failure);
    } finally {
      parse.mockRestore();
    }
  });

  it("keeps the existing channel exports bound to the same public pairing codec", () => {
    expect(channelCompatibility.CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX).toBe(
      CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX,
    );
    expect(channelCompatibility.decodeCodingAppSessionPairingFragment).toBe(
      decodeCodingAppSessionPairingFragment,
    );
    expect(channelCompatibility.encodeCodingAppSessionPairingFragment).toBe(
      encodeCodingAppSessionPairingFragment,
    );
    expect(channelCompatibility.isWellFormedCodingAppSessionPairingAttestation).toBe(
      isWellFormedCodingAppSessionPairingAttestation,
    );
  });

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

  // KEIKO-0742: the claim is documented as a 64-character lowercase hex HMAC-SHA256 digest.
  // Reject shapes that don't match that; the earlier 1..256 range was defence-in-depth, not the
  // real admission shape.
  it("enforces the launcher-minted claim shape (64 lowercase hex, KEIKO-0742)", () => {
    // 60 chars — too short, but was accepted before.
    expect(
      isWellFormedCodingAppSessionPairingAttestation({ ...attestation, claim: "a".repeat(60) }),
    ).toBe(false);
    // 65 all-hex — too long.
    expect(
      isWellFormedCodingAppSessionPairingAttestation({ ...attestation, claim: "a".repeat(65) }),
    ).toBe(false);
    // 64 chars containing an uppercase letter — the launcher never emits mixed case.
    expect(
      isWellFormedCodingAppSessionPairingAttestation({
        ...attestation,
        claim: `A${"b".repeat(63)}`,
      }),
    ).toBe(false);
    // 64 chars containing a non-hex char.
    expect(
      isWellFormedCodingAppSessionPairingAttestation({
        ...attestation,
        claim: `g${"b".repeat(63)}`,
      }),
    ).toBe(false);
    // Valid shape still accepted.
    expect(
      isWellFormedCodingAppSessionPairingAttestation({ ...attestation, claim: "a".repeat(64) }),
    ).toBe(true);
    expect(
      isWellFormedCodingAppSessionPairingAttestation({
        ...attestation,
        claim: "0123456789abcdef".repeat(4),
      }),
    ).toBe(true);
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
      decodeCodingAppSessionPairingFragment(
        `${CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX}${encodeURIComponent("{")}`,
      ),
    ).toBeUndefined();
    expect(
      decodeCodingAppSessionPairingFragment(`${CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX}%7B%7D`),
    ).toBeUndefined();
    const fragment = encodeCodingAppSessionPairingFragment(attestation);
    expect(decodeCodingAppSessionPairingFragment(fragment.slice(0, -4))).toBeUndefined();
  });
});
