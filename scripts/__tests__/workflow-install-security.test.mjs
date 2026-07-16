import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const workflows = [".github/workflows/e2e-extended.yml", ".github/workflows/portable-assets.yml"];

describe("workflow package installation security", () => {
  it.each(workflows)("disables implicit lifecycle scripts in %s", (workflow) => {
    const source = readFileSync(resolve(repoRoot, workflow), "utf8");
    const installCommands = source
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("run: npm ci"));
    expect(installCommands.length).toBeGreaterThan(0);
    expect(installCommands.every((line) => line === "run: npm ci --ignore-scripts")).toBe(true);
  });

  it("invokes the locked Playwright CLI without on-demand npx installation", () => {
    const source = readFileSync(resolve(repoRoot, ".github/workflows/e2e-extended.yml"), "utf8");
    expect(source).not.toMatch(/^\s*run:\s+npx\b/mu);
    expect(source).toContain(
      "run: node node_modules/playwright/cli.js install --with-deps chromium",
    );
  });
});
