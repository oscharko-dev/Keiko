import type { ReactNode } from "react";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import {
  redeemCodingAppSessionPairingOnBoot,
  useCodingAppSessionRedemptions,
} from "@/lib/coding-app-session-client";
import { KeikoDesktop } from "./KeikoDesktop";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: (): { replace: typeof replace } => ({ replace }),
}));

vi.mock("./AppShell", () => ({
  AppShell: (): ReactNode => <section aria-label="Mock app shell" />,
}));

// Only the boot entry is mocked; `redeemCodingAppSessionPairingFragment` stays the real
// implementation so the same-document arrival tests below exercise its actual address-bar and
// network effects instead of a recorded mock call (#3390 review).
vi.mock("@/lib/coding-app-session-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coding-app-session-client")>();
  return {
    ...actual,
    redeemCodingAppSessionPairingOnBoot: vi.fn(() => Promise.resolve(false)),
  };
});

const PAIR_PATH = "/api/coding-workbench/app-session/pair";

const PAIRING_FRAGMENT = encodeCodingAppSessionPairingFragment({
  requestId: "desktop-arrival",
  issuedAtMs: 2,
  claim: "d".repeat(64),
});

/** A fragment navigation inside the open tab: the URL changes and `hashchange` fires, but the
 * document is never reloaded, so no boot effect runs again. */
function navigateSameDocument(hash: string): void {
  window.history.replaceState(null, "", `/${hash}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

describe("KeikoDesktop", () => {
  afterEach(() => {
    replace.mockClear();
    window.history.replaceState(null, "", "/");
  });

  it("mounts the workspace app shell", () => {
    render(<KeikoDesktop />);

    expect(screen.getByRole("region", { name: "Mock app shell" })).toBeInTheDocument();
  });

  it("redeems a launcher pairing fragment on boot (#2478)", () => {
    render(<KeikoDesktop />);

    expect(redeemCodingAppSessionPairingOnBoot).toHaveBeenCalled();
  });

  // #3390, rehearsal run-30: the raw history strip does not survive Next's history updater, which
  // re-applies the canonical URL it captured at hydration -- fragment included -- on the next router
  // state change. Only a replace through the router itself moves that canonical URL.
  it("moves the router's canonical URL to the clean location after redeeming a fragment", async () => {
    window.location.hash = encodeCodingAppSessionPairingFragment({
      requestId: "desktop-boot",
      issuedAtMs: 1,
      claim: "c".repeat(64),
    });
    render(<KeikoDesktop />);

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/", { scroll: false });
    });
  });

  it("performs no navigation at all on an ordinary boot without a fragment", async () => {
    render(<KeikoDesktop />);

    await waitFor(() => {
      expect(redeemCodingAppSessionPairingOnBoot).toHaveBeenCalled();
    });
    expect(replace).not.toHaveBeenCalled();
  });

  // #3390, real runs 30 and 32: opening the launcher URL in the tab that already shows the app is
  // a same-document fragment navigation. The boot effect never runs again, so without a hashchange
  // path the attestation was neither redeemed nor stripped and stayed in the address bar. Asserts
  // the real redemption's own effect (the address bar is cleaned) rather than a mocked call.
  it("redeems a pairing fragment that arrives through a same-document navigation", async () => {
    render(<KeikoDesktop />);
    await waitFor(() => {
      expect(redeemCodingAppSessionPairingOnBoot).toHaveBeenCalled();
    });

    navigateSameDocument(PAIRING_FRAGMENT);

    await waitFor(() => {
      expect(window.location.hash).toBe("");
    });
  });

  it("leaves hash changes without a pairing fragment alone", () => {
    render(<KeikoDesktop />);

    navigateSameDocument("#main");

    expect(window.location.hash).toBe("#main");
  });

  it("stops listening for pairing arrivals once unmounted", () => {
    const { unmount } = render(<KeikoDesktop />);
    unmount();

    navigateSameDocument(PAIRING_FRAGMENT);

    expect(window.location.hash).toBe(PAIRING_FRAGMENT);
  });

  // #3390 review: the router's mount effect patches `history.replaceState` to sync external calls
  // into its canonical URL once installed, so a same-document arrival needs no router replace --
  // unlike the boot path above. This drives the real redeemer (only `OnBoot` is mocked) against a
  // stubbed network and fails if the `hashchange` listener is ever removed.
  it("pins the clean address bar and posts the pairing after a same-document arrival (#3390)", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ schemaVersion: "1" }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(<KeikoDesktop />);
      await waitFor(() => {
        expect(redeemCodingAppSessionPairingOnBoot).toHaveBeenCalled();
      });

      navigateSameDocument(PAIRING_FRAGMENT);

      await waitFor(() => {
        expect(window.location.hash).toBe("");
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(path).toBe(PAIR_PATH);
      expect(init.method).toBe("POST");
      expect(replace).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // F65: after a lane restart the operator re-pairs through a fragment-only launcher link in the tab
  // that shows the app; every read that depends on the session must run again.
  it("re-runs the session reads after a same-document re-pair (F65)", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ schemaVersion: "1" }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const redemptions = renderHook(() => useCodingAppSessionRedemptions());
      const before = redemptions.result.current;
      render(<KeikoDesktop />);
      await waitFor(() => {
        expect(redeemCodingAppSessionPairingOnBoot).toHaveBeenCalled();
      });

      navigateSameDocument(PAIRING_FRAGMENT);

      await waitFor(() => {
        expect(redemptions.result.current).toBe(before + 1);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
