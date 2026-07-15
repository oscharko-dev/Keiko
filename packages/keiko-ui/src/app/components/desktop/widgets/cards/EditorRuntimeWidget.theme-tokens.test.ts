import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const runtimeDirectory = import.meta.dirname;
const runtimeCss = readFileSync(join(runtimeDirectory, "EditorRuntimeWidget.module.css"), "utf8");
const runtimeSource = readFileSync(join(runtimeDirectory, "EditorRuntimeWidget.tsx"), "utf8");

describe("EditorRuntimeWidget governed inlay tokens", () => {
  it("adopts the existing editor inlay tokens on the runtime component scope", () => {
    expect(runtimeCss).toContain("--ed-inlay-fg: var(--fg-dim)");
    expect(runtimeCss).toContain("--ed-inlay-bg: color-mix(in oklch, var(--fg) 8%, transparent)");
    expect(runtimeCss).toContain("--ed-inlay-value-fg: var(--info)");
    expect(runtimeCss).toContain(
      "--ed-inlay-value-bg: color-mix(in oklch, var(--info) 14%, transparent)",
    );
    expect(runtimeSource).toContain("runtimeStyles.themeTokens");
  });
});
