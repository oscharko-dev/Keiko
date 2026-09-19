import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingAppSessionPairingAttestation } from "@oscharko-dev/keiko-contracts";
import {
  CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX,
  CODING_APP_SESSION_PAIRING_REQUEST_ID_MAX_CHARS,
  encodeCodingAppSessionPairingFragment,
} from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";

import {
  codingAppSessionPairingSettled,
  ensureLocalCodingAppSession,
  redeemCodingAppSessionPairingFragment,
  redeemCodingAppSessionPairingNavigation,
  redeemCodingAppSessionPairingOnBoot,
  repairLocalCodingAppSession,
  repairLocalCodingAppSessionWithEvidence,
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

  it("ensures a local app-session through the injected browser seam", async () => {
    const target = seams("");
    const postLocalSession = vi.fn(() => Promise.resolve<unknown>({ schemaVersion: "1" }));

    await expect(ensureLocalCodingAppSession({ ...target.seams, postLocalSession })).resolves.toBe(
      true,
    );

    expect(postLocalSession).toHaveBeenCalledOnce();
  });

  it("fails closed when local app-session ensure cannot reach the BFF", async () => {
    const target = seams("");
    const postLocalSession = vi.fn(() => Promise.reject(new TypeError("offline")));

    await expect(ensureLocalCodingAppSession({ ...target.seams, postLocalSession })).resolves.toBe(
      false,
    );
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

describe("repairLocalCodingAppSession (ADR-0141 D5)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A restarted BFF denies every open surface at once; each of them asking for its own session
  // would post one local-session request per surface.
  it("shares one local-session request among concurrent repairs", async () => {
    let acknowledge: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          acknowledge = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = repairLocalCodingAppSession();
    const second = repairLocalCodingAppSession();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
    });
    acknowledge(new Response(JSON.stringify({ schemaVersion: "1" }), { status: 200 }));

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("never lets a denied local-session request re-enter the repair it is running", async () => {
    // The BFF answers the ensure request itself with the same 403 DENIED as a stale-session read.
    // Routed through the self-heal, the repair would join its own attempt in flight and never
    // settle; it must instead fail closed after exactly one request.
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: "DENIED", message: "no" } }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(repairLocalCodingAppSession()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("starts a fresh repair once the previous one settled", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ schemaVersion: "1" }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(repairLocalCodingAppSession()).resolves.toBe(true);
    await expect(repairLocalCodingAppSession()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// #3557 review: the repair's own request carries the id its evidence names.
describe("repairLocalCodingAppSessionWithEvidence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the local-session request under the correlation id it returns", async () => {
    const fetchMock = vi.fn((_path: string, _init: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ schemaVersion: "1" }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const repair = await repairLocalCodingAppSessionWithEvidence();

    expect(repair.repaired).toBe(true);
    const headers = fetchMock.mock.calls[0]?.[1].headers as Record<string, string>;
    expect(headers["X-Keiko-Correlation-Id"]).toBe(repair.correlationId);
  });

  it("gives every joiner of one repair the same correlation id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ schemaVersion: "1" }), { status: 200 })),
      ),
    );

    const [first, second] = await Promise.all([
      repairLocalCodingAppSessionWithEvidence(),
      repairLocalCodingAppSessionWithEvidence(),
    ]);

    expect(second.correlationId).toBe(first.correlationId);
  });
});

// #3557 review: a failed repair carries the class of its own failed request.
describe("repairLocalCodingAppSessionWithEvidence failure class", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    [
      "an unavailable BFF",
      (): Promise<Response> => Promise.resolve(new Response("{}", { status: 503 })),
      "unavailable",
    ],
    [
      "a transport failure",
      (): Promise<Response> => Promise.reject(new TypeError("Failed to fetch")),
      "unavailable",
    ],
  ] as const)("classifies %s", async (_label, respond, errorKind) => {
    vi.stubGlobal("fetch", vi.fn(respond));

    const repair = await repairLocalCodingAppSessionWithEvidence();

    expect(repair).toMatchObject({ repaired: false, errorKind });
  });
});
