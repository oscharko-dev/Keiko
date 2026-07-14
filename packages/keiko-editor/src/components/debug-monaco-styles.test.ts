// @vitest-environment jsdom
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

    expect(scope).toMatch(/^keiko-debug-\d+$/);
    expect(style?.textContent).toContain(`[data-keiko-debug-decorations="${scope}"]`);
    expect(style?.textContent).toContain("var(--ed-breakpoint)");
    expect(style?.textContent).toContain("var(--ed-breakpoint-disabled)");
    expect(style?.textContent).toContain("var(--ed-breakpoint-ring)");
    expect(style?.textContent).toContain("var(--ed-logpoint)");
    expect(style?.textContent).toContain("var(--ed-inlay-value-fg)");
    expect(style?.textContent).toContain("var(--ed-inlay-value-bg)");
    expect(style?.textContent).not.toMatch(/#[0-9a-f]{3,8}\b/i);

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
