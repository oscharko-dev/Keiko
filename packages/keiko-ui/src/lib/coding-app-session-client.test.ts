import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CodingAppSessionPairingAttestation } from "@oscharko-dev/keiko-contracts";
import {
  CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX,
  CODING_APP_SESSION_PAIRING_REQUEST_ID_MAX_CHARS,
  encodeCodingAppSessionPairingFragment,
} from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";

import {
  codingAppSessionPairingSettled,
  redeemCodingAppSessionPairingFragment,
  redeemCodingAppSessionPairingNavigation,
  redeemCodingAppSessionPairingOnBoot,
  useCodingAppSessionRedemptions,
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

describe("pairing redeemed without a page load (F65)", () => {
  it("counts a posted redemption and re-renders every reader of the count", async () => {
    const view = renderHook(() => useCodingAppSessionRedemptions());
    const before = view.result.current;
    const arrival = seams(encodeCodingAppSessionPairingFragment(attestation));

    await act(async () => {
      await expect(redeemCodingAppSessionPairingNavigation(arrival.seams)).resolves.toBe(true);
    });

    expect(arrival.posted()).toHaveLength(1);
    expect(arrival.stripped()).toBe(1);
    expect(view.result.current).toBe(before + 1);
  });

  it("counts neither a navigation without a fragment nor one whose post failed", async () => {
    const view = renderHook(() => useCodingAppSessionRedemptions());
    const before = view.result.current;
    const failing: CodingAppSessionPairingSeams = {
      readFragment: () => encodeCodingAppSessionPairingFragment(attestation),
      stripFragment: vi.fn(),
      postPairing: () => Promise.reject(new TypeError("pair endpoint unreachable")),
    };

    await act(async () => {
      await expect(redeemCodingAppSessionPairingNavigation(seams("").seams)).resolves.toBe(false);
      await expect(redeemCodingAppSessionPairingNavigation(failing)).resolves.toBe(false);
    });

    expect(view.result.current).toBe(before);
  });

  // PR #3452 review: a navigation whose pairing fragment the decoder refuses posts nothing, strips
  // the fragment and changes no reader, whatever makes it invalid.
  const fragmentOf = (value: unknown): string =>
    `${CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX}${encodeURIComponent(JSON.stringify(value))}`;
  const longestRequestId = "r".repeat(CODING_APP_SESSION_PAIRING_REQUEST_ID_MAX_CHARS);

  it.each([
    ["an empty payload", CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX],
    ["broken percent-encoding", `${CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX}%E0%A4%A`],
    ["a payload that is not JSON", `${CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX}%7BrequestId`],
    ["an array", fragmentOf([attestation])],
    ["a missing key", fragmentOf({ requestId: attestation.requestId, claim: attestation.claim })],
    ["an extra key", fragmentOf({ ...attestation, principalLabel: "operator" })],
    ["a mistyped issuedAtMs", fragmentOf({ ...attestation, issuedAtMs: "1720000000000" })],
    ["a negative issuedAtMs", fragmentOf({ ...attestation, issuedAtMs: -1 })],
    [
      "an unsafe issuedAtMs",
      fragmentOf({ ...attestation, issuedAtMs: Number.MAX_SAFE_INTEGER + 2 }),
    ],
    [
      "a request id one past its maximum",
      fragmentOf({ ...attestation, requestId: `${longestRequestId}r` }),
    ],
    [
      "a request id outside its alphabet",
      fragmentOf({ ...attestation, requestId: "req launcher" }),
    ],
    ["an empty claim", fragmentOf({ ...attestation, claim: "" })],
    ["a claim one past its length", fragmentOf({ ...attestation, claim: "c".repeat(65) })],
    ["a claim outside lowercase hex", fragmentOf({ ...attestation, claim: "C".repeat(64) })],
  ])("counts no navigation whose fragment carries %s", async (_label, fragment) => {
    const view = renderHook(() => useCodingAppSessionRedemptions());
    const before = view.result.current;
    const arrival = seams(fragment);

    await act(async () => {
      await expect(redeemCodingAppSessionPairingNavigation(arrival.seams)).resolves.toBe(false);
    });

    expect(arrival.posted()).toEqual([]);
    expect(arrival.stripped()).toBe(1);
    expect(view.result.current).toBe(before);
  });

  // The valid boundaries the decoder accepts, kept apart from the refusals above.
  it.each([
    ["the longest request id", { ...attestation, requestId: longestRequestId }],
    ["a one-character request id", { ...attestation, requestId: "r" }],
    ["issuedAtMs zero", { ...attestation, issuedAtMs: 0 }],
    ["the largest safe issuedAtMs", { ...attestation, issuedAtMs: Number.MAX_SAFE_INTEGER }],
  ])("counts a navigation at the boundary: %s", async (_label, boundary) => {
    const view = renderHook(() => useCodingAppSessionRedemptions());
    const before = view.result.current;
    const arrival = seams(encodeCodingAppSessionPairingFragment(boundary));

    await act(async () => {
      await expect(redeemCodingAppSessionPairingNavigation(arrival.seams)).resolves.toBe(true);
    });

    expect(arrival.posted()).toEqual([boundary]);
    expect(view.result.current).toBe(before + 1);
  });

  it("does not count the boot redemption, which every read already waits for", async () => {
    const view = renderHook(() => useCodingAppSessionRedemptions());
    const before = view.result.current;

    await act(async () => {
      await redeemCodingAppSessionPairingOnBoot();
    });

    expect(view.result.current).toBe(before);
  });
});
