// GEN-UI-A11Y-004 — the app-level status live-region channel.
//
// Proves the provider mounts one always-present polite (role="status") + assertive (role="alert")
// region pair, and that useAnnouncer routes a message to the correct region.

import type { ReactNode } from "react";
import { render, screen, act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AnnouncerProvider, useAnnouncer, useOptionalAnnouncer } from "./AnnouncerContext";

function Harness({ children }: { readonly children: ReactNode }): ReactNode {
  return <AnnouncerProvider>{children}</AnnouncerProvider>;
}

describe("AnnouncerProvider / useAnnouncer", () => {
  it("mounts a polite status region and an assertive alert region", () => {
    render(<Harness>content</Harness>);

    const polite = screen.getByRole("status");
    expect(polite).toHaveAttribute("aria-live", "polite");
    expect(polite).toHaveAttribute("aria-atomic", "true");

    const assertive = screen.getByRole("alert");
    expect(assertive).toHaveAttribute("aria-live", "assertive");
    expect(assertive).toHaveAttribute("aria-atomic", "true");
  });

  it("posts a polite announcement to the status region by default", () => {
    let announce: ((message: string, opts?: { assertive?: boolean }) => void) | null = null;
    function Poster(): ReactNode {
      announce = useAnnouncer().announce;
      return null;
    }
    render(
      <Harness>
        <Poster />
      </Harness>,
    );

    act(() => {
      announce?.("Window created");
    });

    expect(screen.getByRole("status").textContent).toContain("Window created");
    // The assertive region stays empty for a polite announcement.
    expect(screen.getByRole("alert").textContent).not.toContain("Window created");
  });

  it("routes an assertive announcement to the alert region", () => {
    let announce: ((message: string, opts?: { assertive?: boolean }) => void) | null = null;
    function Poster(): ReactNode {
      announce = useAnnouncer().announce;
      return null;
    }
    render(
      <Harness>
        <Poster />
      </Harness>,
    );

    act(() => {
      announce?.("Save failed", { assertive: true });
    });

    expect(screen.getByRole("alert").textContent).toContain("Save failed");
    expect(screen.getByRole("status").textContent).not.toContain("Save failed");
  });

  it("throws when useAnnouncer is used outside a provider", () => {
    function Bare(): ReactNode {
      useAnnouncer();
      return null;
    }
    // Silence the expected React error boundary console output for this negative case.
    expect(() => render(<Bare />)).toThrow(/AnnouncerProvider/u);
  });

  it("returns a no-op channel from useOptionalAnnouncer outside a provider", () => {
    let api: ReturnType<typeof useOptionalAnnouncer> | null = null;
    function Reader(): ReactNode {
      api = useOptionalAnnouncer();
      return null;
    }
    render(<Reader />);

    expect(api).not.toBeNull();
    // Calling the no-op announce must not throw.
    expect(() => api?.announce("ignored")).not.toThrow();
  });
});
