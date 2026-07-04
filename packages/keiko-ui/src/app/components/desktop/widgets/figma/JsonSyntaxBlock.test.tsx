// GEN-PERF-WIDGET-002 — JsonSyntaxBlock must not explode a large JSON payload into
// 10^5–10^6 per-token spans. Above MAX_HIGHLIGHT_JSON_BYTES it falls back to a single
// un-tokenized text node while still rendering the full content.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JsonSyntaxBlock, MAX_HIGHLIGHT_JSON_BYTES } from "./JsonSyntaxBlock";

describe("JsonSyntaxBlock size cutoff (GEN-PERF-WIDGET-002)", () => {
  it("highlights small JSON with per-token spans", () => {
    const small = JSON.stringify({ id: "n1", w: 10, active: true, meta: null }, null, 2);
    const { container } = render(<JsonSyntaxBlock text={small} className="json" />);
    const tokens = container.querySelectorAll('[class^="json-token"]');
    expect(tokens.length).toBeGreaterThan(0);
    expect(container.querySelector('[data-highlight-disabled="true"]')).toBeNull();
  });

  it("falls back to a plain text node above the byte cutoff (no span explosion)", () => {
    // Build a payload comfortably above the cap whose highlighted form would be
    // hundreds of thousands of spans.
    const nodes = Array.from({ length: 20_000 }, (_, i) => ({
      id: `node-${String(i)}`,
      x: i,
      y: i * 2,
      visible: true,
    }));
    const big = JSON.stringify(nodes, null, 2);
    expect(big.length).toBeGreaterThan(MAX_HIGHLIGHT_JSON_BYTES);

    const { container } = render(<JsonSyntaxBlock text={big} className="json" />);
    const tokens = container.querySelectorAll('[class^="json-token"]');
    expect(tokens.length).toBe(0);
    expect(container.querySelector('[data-highlight-disabled="true"]')).not.toBeNull();
    // Full content is still present.
    expect(container.textContent).toContain("node-19999");
  });
});

describe("JsonSyntaxBlock focusable scroll region (GEN-UI-KEYBOARD-005)", () => {
  it("exposes a named, keyboard-focusable region for the highlighted <pre> when ariaLabel is given", () => {
    const small = JSON.stringify({ id: "n1", w: 10 }, null, 2);
    render(<JsonSyntaxBlock text={small} className="json" ariaLabel="Figma export JSON" />);
    const region = screen.getByRole("region", { name: /figma export json/i });
    expect(region.tagName).toBe("PRE");
    expect(region).toHaveAttribute("tabindex", "0");
  });

  it("exposes a named, keyboard-focusable region for the un-tokenized fallback <pre> too", () => {
    const nodes = Array.from({ length: 20_000 }, (_, i) => ({ id: `node-${String(i)}`, x: i }));
    const big = JSON.stringify(nodes, null, 2);
    expect(big.length).toBeGreaterThan(MAX_HIGHLIGHT_JSON_BYTES);
    render(<JsonSyntaxBlock text={big} className="json" ariaLabel="Screen-IR JSON for scr-1" />);
    const region = screen.getByRole("region", { name: /screen-ir json for scr-1/i });
    expect(region.tagName).toBe("PRE");
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toHaveAttribute("data-highlight-disabled", "true");
  });

  it("keeps the plain non-focusable <pre> when no ariaLabel is provided (behaviour-preserving)", () => {
    const small = JSON.stringify({ id: "n1" }, null, 2);
    const { container } = render(<JsonSyntaxBlock text={small} className="json" />);
    expect(screen.queryByRole("region")).toBeNull();
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre).not.toHaveAttribute("tabindex");
  });
});
