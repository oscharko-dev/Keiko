import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { redeemCodingAppSessionPairingOnBoot } from "@/lib/coding-app-session-client";
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
}));

describe("KeikoDesktop", () => {
  afterEach(() => {
    replace.mockClear();
    window.location.hash = "";
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
});
