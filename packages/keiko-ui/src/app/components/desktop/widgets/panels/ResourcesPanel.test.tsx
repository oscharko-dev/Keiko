import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ResourcesPanel } from "./ResourcesPanel";

describe("ResourcesPanel", () => {
  it("renders the shared resources placeholder", () => {
    render(<ResourcesPanel />);

    expect(screen.getByText("resources")).toBeInTheDocument();
    expect(screen.getByText(/Shared assets & references/i)).toBeInTheDocument();
  });
});
