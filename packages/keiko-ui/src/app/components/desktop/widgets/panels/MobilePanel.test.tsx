import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MobilePanel } from "./MobilePanel";

describe("MobilePanel", () => {
  it("renders the mobile continuation placeholder", () => {
    render(<MobilePanel />);

    expect(screen.getByText("Keiko Mobile")).toBeInTheDocument();
  });

  it("discloses the QR placeholder is not yet available instead of instructing a scan (KEIKO-0867)", () => {
    render(<MobilePanel />);

    expect(screen.getByText(/not yet available/i)).toBeInTheDocument();
    expect(screen.queryByText(/scan to continue/i)).not.toBeInTheDocument();
  });

  it("exposes a named region landmark for assistive tech (KEIKO-0669)", () => {
    render(<MobilePanel />);

    expect(screen.getByRole("region", { name: /keiko mobile/i })).toBeInTheDocument();
  });
});
