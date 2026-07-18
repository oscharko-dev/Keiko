import { describe, expect, it } from "vitest";

import { CODING_APP_SESSION_CHANNEL_BODY_MAX_CHARS } from "./channelContract.js";
import { createFakeSessionPairingPort, fakePairingRequestBody } from "./_support.js";
import {
  createCodingAppSessionChannel,
  type CodingAppSessionContentSource,
} from "./sessionChannel.js";
import { createSessionRegistry } from "./sessionRegistry.js";

const CANARY = { kind: "probe", body: "bounded-canary-payload" } as const;

function pairedChannel(contentSource?: CodingAppSessionContentSource): {
  readonly channel: ReturnType<typeof createCodingAppSessionChannel>;
  readonly cookieToken: string;
} {
  const channel = createCodingAppSessionChannel({
    registry: createSessionRegistry(),
    pairingPort: createFakeSessionPairingPort(),
    ...(contentSource ? { contentSource } : {}),
  });
  const result = channel.pair(fakePairingRequestBody());
  if (!result.paired) throw new Error("expected pairing to succeed");
  return { channel, cookieToken: result.cookieToken };
}

describe("createCodingAppSessionChannel", () => {
  it("cannot pair without a pairing authority (fail closed)", () => {
    const channel = createCodingAppSessionChannel({ registry: createSessionRegistry() });
    expect(channel.pair(fakePairingRequestBody())).toEqual({ paired: false });
    expect(channel.sessionCount()).toBe(0);
  });

  it("does not pair when the authority denies a well-formed attestation", () => {
    const channel = createCodingAppSessionChannel({
      registry: createSessionRegistry(),
      pairingPort: createFakeSessionPairingPort({ shouldApprove: () => false }),
    });
    expect(channel.pair(fakePairingRequestBody())).toEqual({ paired: false });
    expect(channel.sessionCount()).toBe(0);
  });

  it("denies a malformed attestation even with an authority present", () => {
    const channel = createCodingAppSessionChannel({
      registry: createSessionRegistry(),
      pairingPort: createFakeSessionPairingPort(),
    });
    expect(channel.pair({ requestId: "bad id!", issuedAtMs: -1, claim: "" })).toEqual({
      paired: false,
    });
  });

  it("serves content-free to an unpaired reader", () => {
    const { channel } = pairedChannel(createStatic(CANARY));
    expect(channel.snapshot(undefined).content).toBeNull();
    expect(channel.snapshot("sess_deadbeefdeadbeefdeadbeef.forged").content).toBeNull();
  });

  it("serves content-free to a paired reader when no content source is wired", () => {
    const { channel, cookieToken } = pairedChannel();
    expect(channel.snapshot(cookieToken).content).toBeNull();
  });

  it("serves the bounded payload to a paired reader with a content source", () => {
    const { channel, cookieToken } = pairedChannel(createStatic(CANARY));
    expect(channel.snapshot(cookieToken).content).toEqual(CANARY);
  });

  it("fails closed to content-free when the content source exceeds the bound", () => {
    const oversize = {
      kind: "probe",
      body: "x".repeat(CODING_APP_SESSION_CHANNEL_BODY_MAX_CHARS + 1),
    };
    const { channel, cookieToken } = pairedChannel(createStatic(oversize));
    expect(channel.snapshot(cookieToken).content).toBeNull();
  });

  it("unpaired and paired-without-content reads are byte-identical (no oracle)", () => {
    const { channel: withContent, cookieToken } = pairedChannel(createStatic(CANARY));
    const unpaired = JSON.stringify(withContent.snapshot(undefined));
    const { channel: noContent, cookieToken: token2 } = pairedChannel();
    expect(JSON.stringify(noContent.snapshot(token2))).toBe(unpaired);
    expect(withContent.snapshot(cookieToken).content).not.toBeNull();
  });

  it("rotation cuts access for the prior cookie and grants it to the new one", () => {
    const { channel, cookieToken } = pairedChannel(createStatic(CANARY));
    const rotated = channel.rotate(cookieToken);
    expect(rotated.rotated).toBe(true);
    expect(channel.snapshot(cookieToken).content).toBeNull();
    if (rotated.rotated) expect(channel.snapshot(rotated.cookieToken).content).toEqual(CANARY);
  });

  it("sign-out revokes the session", () => {
    const { channel, cookieToken } = pairedChannel(createStatic(CANARY));
    channel.signOut(cookieToken);
    expect(channel.snapshot(cookieToken).content).toBeNull();
    expect(channel.sessionCount()).toBe(0);
  });

  it("rotate and sign-out on an unpaired cookie are safe no-ops", () => {
    const channel = createCodingAppSessionChannel({
      registry: createSessionRegistry(),
      pairingPort: createFakeSessionPairingPort(),
    });
    expect(channel.rotate(undefined)).toEqual({ rotated: false });
    expect(() => {
      channel.signOut(undefined);
    }).not.toThrow();
  });

  // #2478: verifySession is the read-authority primitive the W1.5 route guard enforces with.
  it("verifySession grants only a live cookie and nothing after revocation or rotation", () => {
    const { channel, cookieToken } = pairedChannel();
    expect(channel.verifySession(cookieToken)?.principalLabel).toBe("test-operator");
    expect(channel.verifySession(undefined)).toBeUndefined();
    expect(channel.verifySession("sess_000000000000000000000000.wrong")).toBeUndefined();
    const rotated = channel.rotate(cookieToken);
    expect(rotated.rotated).toBe(true);
    expect(channel.verifySession(cookieToken)).toBeUndefined();
    if (rotated.rotated) {
      channel.signOut(rotated.cookieToken);
      expect(channel.verifySession(rotated.cookieToken)).toBeUndefined();
    }
  });
});

function createStatic(content: { kind: string; body: string }): CodingAppSessionContentSource {
  return { contentFor: () => content };
}
