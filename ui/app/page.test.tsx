import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import HomePage from "./page";

describe("HomePage placeholder", () => {
  it("renders a main landmark and the primary heading", () => {
    render(<HomePage />);
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: /developer-assist ui/i }),
    ).toBeInTheDocument();
  });

  it("exposes a banner landmark and a named primary navigation", () => {
    render(<HomePage />);
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /primary/i })).toBeInTheDocument();
  });

  it("has no axe-detectable accessibility violations", async () => {
    const { container } = render(<HomePage />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
