import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import {
  redeemCodingAppSessionPairingFragment,
  redeemCodingAppSessionPairingOnBoot,
} from "@/lib/coding-app-session-client";
import { KeikoDesktop } from "./KeikoDesktop";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: (): { replace: typeof replace } => ({ replace }),
}));

vi.mock("./AppShell", () => ({
  AppShell: (): ReactNode => <section aria-label="Mock app shell" />,
}));

vi.mock("@/lib/coding-app-session-client", () => ({
  redeemCodingAppSessionPairingOnBoot: vi.fn(() => Promise.resolve(false)),
  redeemCodingAppSessionPairingFragment: vi.fn(() => Promise.resolve(true)),
}));

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
    vi.mocked(redeemCodingAppSessionPairingFragment).mockClear();
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
  // path the attestation was neither redeemed nor stripped and stayed in the address bar.
  it("redeems a pairing fragment that arrives through a same-document navigation", async () => {
    render(<KeikoDesktop />);
    await waitFor(() => {
      expect(redeemCodingAppSessionPairingOnBoot).toHaveBeenCalled();
    });

    navigateSameDocument(PAIRING_FRAGMENT);

    await waitFor(() => {
      expect(redeemCodingAppSessionPairingFragment).toHaveBeenCalledTimes(1);
    });
  });

  it("leaves hash changes without a pairing fragment alone", () => {
    render(<KeikoDesktop />);

    navigateSameDocument("#main");

    expect(redeemCodingAppSessionPairingFragment).not.toHaveBeenCalled();
  });

  it("stops listening for pairing arrivals once unmounted", () => {
    const { unmount } = render(<KeikoDesktop />);
    unmount();

    navigateSameDocument(PAIRING_FRAGMENT);

    expect(redeemCodingAppSessionPairingFragment).not.toHaveBeenCalled();
  });
});
