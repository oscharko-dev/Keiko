// Issue #189 — tests for the LeftRail navigation links.
// Verifies that all page-route links (MemoriaViva, Quality Intelligence,
// Local Knowledge) render with correct href and accessible name.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LeftRail } from "./LeftRail";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function renderRail(): void {
  render(
    <LeftRail
      openTools={new Set()}
      onTool={vi.fn()}
      onNewChat={vi.fn()}
      theme="dark"
      onToggleTheme={vi.fn()}
    />,
  );
}

describe("LeftRail — page-route links", () => {
  it("renders the left rail as a labeled navigation landmark", () => {
    renderRail();
    expect(
      screen.getByRole("navigation", { name: "Primary workspace navigation" }),
    ).toBeInTheDocument();
  });

  it("renders the MemoriaViva link with correct href and accessible name", () => {
    renderRail();
    const link = screen.getByRole("link", { name: "MemoriaViva" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/memoriaviva");
  });

  it("renders the Quality Intelligence link with correct href and accessible name", () => {
    renderRail();
    const link = screen.getByRole("link", { name: "Quality Intelligence" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/quality-intelligence");
  });

  it("renders the Local Knowledge link with correct href and accessible name", () => {
    renderRail();
    const link = screen.getByRole("link", { name: "Local Knowledge" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/local-knowledge");
  });
});
