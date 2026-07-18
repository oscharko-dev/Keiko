import { describe, expect, it, vi } from "vitest";
import {
  encodeCodingAppSessionPairingFragment,
  type CodingAppSessionPairingAttestation,
} from "@oscharko-dev/keiko-contracts";

import {
  redeemCodingAppSessionPairingFragment,
  type CodingAppSessionPairingSeams,
} from "./coding-app-session-client";

const attestation = {
  requestId: "req_launcher-1",
  issuedAtMs: 1_720_000_000_000,
  claim: "c".repeat(64),
};

function seams(fragment: string): {
  seams: CodingAppSessionPairingSeams;
  stripped: () => number;
  posted: () => readonly unknown[];
} {
  const strip = vi.fn();
  const post = vi.fn((_attestation: CodingAppSessionPairingAttestation) =>
    Promise.resolve<unknown>({ schemaVersion: "1" }),
  );
  return {
    seams: { readFragment: () => fragment, stripFragment: strip, postPairing: post },
    stripped: () => strip.mock.calls.length,
    posted: () => post.mock.calls.map((call) => call[0]),
  };
}

describe("redeemCodingAppSessionPairingFragment (#2478)", () => {
  it("redeems a launcher fragment and strips it before the attestation is posted onward", async () => {
    const fragment = encodeCodingAppSessionPairingFragment(attestation);
    const target = seams(fragment);
    await expect(redeemCodingAppSessionPairingFragment(target.seams)).resolves.toBe(true);
    expect(target.stripped()).toBe(1);
    expect(target.posted()).toEqual([attestation]);
  });

  it("ignores locations without the pairing fragment", async () => {
    for (const fragment of ["", "#", "#section-2", "#keiko-app-sessio=x"]) {
      const target = seams(fragment);
      await expect(redeemCodingAppSessionPairingFragment(target.seams)).resolves.toBe(false);
      expect(target.stripped()).toBe(0);
      expect(target.posted()).toEqual([]);
    }
  });

  it("strips a malformed pairing fragment without posting anything", async () => {
    const target = seams("#keiko-app-session=%7B%22requestId%22%3A1%7D");
    await expect(redeemCodingAppSessionPairingFragment(target.seams)).resolves.toBe(false);
    expect(target.stripped()).toBe(1);
    expect(target.posted()).toEqual([]);
  });

  it("fails closed when the pair endpoint is unreachable", async () => {
    const fragment = encodeCodingAppSessionPairingFragment(attestation);
    const strip = vi.fn();
    const post = vi.fn(() => Promise.reject(new TypeError("offline")));
    await expect(
      redeemCodingAppSessionPairingFragment({
        readFragment: () => fragment,
        stripFragment: strip,
        postPairing: post,
      }),
    ).resolves.toBe(false);
    expect(strip).toHaveBeenCalledTimes(1);
  });

  it("is a no-op outside a browser context", async () => {
    await expect(redeemCodingAppSessionPairingFragment(undefined)).resolves.toBe(false);
  });
});
