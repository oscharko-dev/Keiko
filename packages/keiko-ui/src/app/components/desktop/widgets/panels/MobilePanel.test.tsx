import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MobilePanel } from "./MobilePanel";

describe("MobilePanel", () => {
  it("renders the mobile continuation placeholder", () => {
    render(<MobilePanel />);

    expect(screen.getByText("Keiko Mobile")).toBeInTheDocument();
    expect(screen.getByText("Scan to continue this workspace on your phone.")).toBeInTheDocument();
  });
});
