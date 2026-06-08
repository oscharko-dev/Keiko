// Issue #189 — tests for the LeftRail navigation links.
// Verifies that all page-route links (MemoriaViva, Quality Intelligence,
// Local Knowledge) render with correct href and accessible name.
// Epic #518 — also verifies aria-pressed state on toggle buttons (WCAG 4.1.2).

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

function renderRail(openTools: ReadonlySet<string> = new Set()): void {
  render(
    <LeftRail
      openTools={openTools}
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

describe("LeftRail — aria-pressed on toggle buttons (WCAG 4.1.2)", () => {
  it("sets aria-pressed=false on tool buttons when the panel is closed", () => {
    renderRail(new Set());
    const projectBtn = screen.getByRole("button", { name: "Project" });
    expect(projectBtn).toHaveAttribute("aria-pressed", "false");
  });

  it("sets aria-pressed=true on tool buttons when the panel is open", () => {
    renderRail(new Set(["project"]));
    const projectBtn = screen.getByRole("button", { name: "Project" });
    expect(projectBtn).toHaveAttribute("aria-pressed", "true");
  });

  it("sets aria-pressed=false on the Settings button when settings panel is closed", () => {
    renderRail(new Set());
    const settingsBtn = screen.getByRole("button", { name: "Settings" });
    expect(settingsBtn).toHaveAttribute("aria-pressed", "false");
  });

  it("sets aria-pressed=true on the Settings button when settings panel is open", () => {
    renderRail(new Set(["settings"]));
    const settingsBtn = screen.getByRole("button", { name: "Settings" });
    expect(settingsBtn).toHaveAttribute("aria-pressed", "true");
  });

  it("route Links (MemoriaViva, QI, LK) do NOT have aria-pressed", () => {
    renderRail();
    const links = screen.getAllByRole("link");
    for (const link of links) {
      expect(link).not.toHaveAttribute("aria-pressed");
    }
  });
});
