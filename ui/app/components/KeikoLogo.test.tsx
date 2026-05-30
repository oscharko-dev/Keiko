import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { KeikoLogo } from "./KeikoLogo";

describe("KeikoLogo", () => {
  it("renders with aria-hidden by default", () => {
    const { container } = render(<KeikoLogo />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders with a title and exposes role=img with accessible name", () => {
    render(<KeikoLogo title="Keiko logo" />);
    const img = screen.getByRole("img", { name: /keiko logo/i });
    expect(img).toBeInTheDocument();
  });

  it("does not set aria-hidden when a title is provided", () => {
    const { container } = render(<KeikoLogo title="Keiko" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBeNull();
  });

  it("applies className to the outer svg", () => {
    const { container } = render(<KeikoLogo className="w-8 h-8 text-accent" />);
    const svg = container.querySelector("svg");
    // SVG className is an SVGAnimatedString in jsdom — access via getAttribute
    expect(svg?.getAttribute("class")).toContain("text-accent");
  });

  it("uses currentColor fill so the color is driven by CSS", () => {
    const { container } = render(<KeikoLogo />);
    const innerG = container.querySelector("g[fill='currentColor']");
    expect(innerG).not.toBeNull();
  });

  it("has no axe-detectable accessibility violations (aria-hidden)", async () => {
    const { container } = render(<KeikoLogo aria-hidden="true" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe-detectable accessibility violations (role=img)", async () => {
    const { container } = render(<KeikoLogo title="Keiko logo" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
