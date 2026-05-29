/**
 * page.tsx now exports the Home dashboard (HomePage).
 * Tests cover: product heading, surface nav cards, quick-start section, axe.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import HomePage from "./page";

describe("HomePage (home dashboard)", () => {
  it("renders the Keiko product heading", () => {
    render(<HomePage />);
    expect(
      screen.getByRole("heading", { level: 1, name: /keiko developer-assist ui/i }),
    ).toBeInTheDocument();
  });

  it("renders surface navigation cards with links to all primary areas", () => {
    render(<HomePage />);
    expect(screen.getByRole("link", { name: /open the workflow launch surface/i })).toHaveAttribute(
      "href",
      "/launch",
    );
    expect(screen.getByRole("link", { name: /open the evidence browser/i })).toHaveAttribute(
      "href",
      "/evidence",
    );
    expect(
      screen.getByRole("link", { name: /open the configuration and model inspector/i }),
    ).toHaveAttribute("href", "/config");
  });

  it("surface nav landmark is present and keyboard-reachable", () => {
    render(<HomePage />);
    const nav = screen.getByRole("navigation", { name: /surface navigation/i });
    expect(nav).toBeInTheDocument();
    // Links inside the nav are the primary keyboard targets
    const links = screen.getAllByRole("link");
    expect(links.length).toBeGreaterThanOrEqual(3);
  });

  it("renders the quick-start section", () => {
    render(<HomePage />);
    expect(screen.getByRole("heading", { name: /quick start/i })).toBeInTheDocument();
  });

  it("has no axe-detectable accessibility violations", async () => {
    const { container } = render(<HomePage />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
