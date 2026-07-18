import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { redeemCodingAppSessionPairingOnBoot } from "@/lib/coding-app-session-client";
import { KeikoDesktop } from "./KeikoDesktop";

vi.mock("./AppShell", () => ({
  AppShell: () => <section aria-label="Mock app shell" />,
}));

vi.mock("@/lib/coding-app-session-client", () => ({
  redeemCodingAppSessionPairingOnBoot: vi.fn(() => Promise.resolve(false)),
}));

describe("KeikoDesktop", () => {
  it("mounts the workspace app shell", () => {
    render(<KeikoDesktop />);

    expect(screen.getByRole("region", { name: "Mock app shell" })).toBeInTheDocument();
  });

  it("redeems a launcher pairing fragment on boot (#2478)", () => {
    render(<KeikoDesktop />);

    expect(redeemCodingAppSessionPairingOnBoot).toHaveBeenCalled();
  });
});
