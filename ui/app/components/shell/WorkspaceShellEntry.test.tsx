import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { WorkspaceShellEntry } from "./WorkspaceShellEntry";

describe("WorkspaceShellEntry", () => {
  it("renders the welcome heading", () => {
    render(<WorkspaceShellEntry />);
    expect(
      screen.getByRole("heading", { level: 1, name: /welcome to keiko/i }),
    ).toBeInTheDocument();
  });

  it("renders trust-posture chips", () => {
    render(<WorkspaceShellEntry />);
    expect(screen.getByText(/local only/i)).toBeInTheDocument();
    expect(screen.getByText(/dry-run first/i)).toBeInTheDocument();
    expect(screen.getByText(/structured event stream/i)).toBeInTheDocument();
  });

  it("has no axe-detectable accessibility violations", async () => {
    const { container } = render(<WorkspaceShellEntry />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
