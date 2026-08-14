// @vitest-environment jsdom
import "../../vitest.setup";

import { describe, expect, it } from "vitest";

import { installDebugMonacoStyles } from "./debug-monaco-styles.js";

describe("installDebugMonacoStyles", () => {
  it("scopes breakpoint and paused-value decoration rules to one container and uses only editor tokens", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const stylesBefore = document.head.querySelectorAll(
      "style[data-keiko-debug-decoration-style]",
    ).length;
    const installation = installDebugMonacoStyles(container);
    const scope = container.getAttribute("data-keiko-debug-decorations");
    if (scope === null) throw new Error("debug decoration scope missing");
    const style = document.head.querySelector(
      `style[data-keiko-debug-decoration-style="${scope}"]`,
    );
    const styleContent = style?.textContent ?? "";

    expect(scope).toMatch(/^keiko-debug-\d+$/);
    expect(styleContent).toContain(`[data-keiko-debug-decorations="${scope}"]`);
    expect(styleContent).toContain("var(--ed-breakpoint)");
    expect(styleContent).toContain("var(--ed-breakpoint-disabled)");
    expect(styleContent).toContain("var(--ed-breakpoint-ring)");
    expect(styleContent).toContain("var(--ed-logpoint)");
    expect(styleContent).toContain("var(--ed-inlay-value-fg)");
    expect(styleContent).toContain("var(--ed-inlay-value-bg)");
    expect(styleContent).not.toMatch(/#[0-9a-f]{3,8}\b/i);

    // Epic #2096 a11y-sweep finding 4: the "hit" (currently paused) breakpoint must be distinguishable
    // by shape, not only by the ring color's contrast against --ed-breakpoint-ring. The ::after spike
    // is a non-color cue layered on top of the existing ring.
    expect(styleContent).toContain("keiko-debug-breakpoint-hit::after");
    // The current-execution-line marker (rendered when paused on a line with no breakpoint at all)
    // must exist as its own distinct, non-circular glyph rather than reusing a breakpoint shape.
    expect(styleContent).toContain(".keiko-debug-current-line");

    installation.dispose();
    expect(container.hasAttribute("data-keiko-debug-decorations")).toBe(false);
    expect(document.head.querySelectorAll("style[data-keiko-debug-decoration-style]")).toHaveLength(
      stylesBefore,
    );
    container.remove();
  });

  it("does not let an obsolete mount remove the replacement mount's scope marker", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const first = installDebugMonacoStyles(container);
    const firstScope = container.getAttribute("data-keiko-debug-decorations");
    const second = installDebugMonacoStyles(container);
    const secondScope = container.getAttribute("data-keiko-debug-decorations");

    expect(firstScope).not.toBe(secondScope);
    first.dispose();
    expect(container.getAttribute("data-keiko-debug-decorations")).toBe(secondScope);

    second.dispose();
    expect(container.hasAttribute("data-keiko-debug-decorations")).toBe(false);
    container.remove();
  });
});
