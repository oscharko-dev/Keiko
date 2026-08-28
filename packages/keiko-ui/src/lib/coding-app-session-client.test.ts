import { describe, expect, it, vi } from "vitest";
import type { CodingAppSessionPairingAttestation } from "@oscharko-dev/keiko-contracts";
import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";

import {
  codingAppSessionPairingSettled,
  redeemCodingAppSessionPairingFragment,
  redeemCodingAppSessionPairingOnBoot,
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

  it("wires the default browser seams: reads the hash, posts the pairing, strips the fragment", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ schemaVersion: "1" }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const replaceState = vi.spyOn(window.history, "replaceState");
    try {
      window.location.hash = encodeCodingAppSessionPairingFragment(attestation);
      await expect(redeemCodingAppSessionPairingFragment()).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(path).toBe("/api/coding-workbench/app-session/pair");
      expect(JSON.parse(String(init.body))).toEqual(attestation);
      expect(replaceState).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      replaceState.mockRestore();
      window.location.hash = "";
    }
  });
});

describe("boot pairing ordering (#2478, Qodo #2514 finding 3)", () => {
  it("starts the boot redemption from settled() and keeps it single-flight", async () => {
    // jsdom location carries no pairing fragment, so the boot attempt resolves false without
    // posting — the point here is identity (single flight) and settled() joining that promise.
    const settled = codingAppSessionPairingSettled();
    const first = redeemCodingAppSessionPairingOnBoot();
    const second = redeemCodingAppSessionPairingOnBoot();
    expect(settled).toBe(first);
    expect(second).toBe(first);
    expect(codingAppSessionPairingSettled()).toBe(first);
    await expect(first).resolves.toBe(false);
  });
});
