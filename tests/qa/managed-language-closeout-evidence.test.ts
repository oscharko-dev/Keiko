import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface RootPackageJson {
  readonly scripts: Readonly<Record<string, string>>;
}

const CLOSEOUT_DOCS = [
  "docs/keiko-editor/2094-managed-language-intelligence-regression-evidence.md",
  "docs/keiko-editor/2094-managed-language-intelligence-security-performance-review.md",
] as const;

function readPackageJson(): RootPackageJson {
  return JSON.parse(readFileSync("package.json", "utf8")) as RootPackageJson;
}

function readCloseoutDocs(): string {
  return CLOSEOUT_DOCS.map((path) => readFileSync(path, "utf8")).join("\n");
}

describe("managed-language quality closeout evidence (#2282)", () => {
  it("collects the complete managed-LSP package test surface", () => {
    const script = readPackageJson().scripts["test:managed-lsp-closeout"];
    expect(script).toContain("packages/keiko-server/src/editor/lsp");
    expect(script).toContain("managed-language-closeout-2282.static.test.ts");
    expect(script).not.toContain("managedLspControl.test.ts");
  });

  it("registers a real Settings-to-BFF-to-LSP browser proof", () => {
    const scripts = readPackageJson().scripts;
    expect(scripts["test:e2e:managed-language-closeout-2282"]).toBeDefined();
    expect(
      existsSync("tests/e2e/config/playwright.issue-2282-managed-language-closeout.config.ts"),
    ).toBe(true);
    expect(existsSync("tests/e2e/managed-language-closeout-2282.spec.ts")).toBe(true);
  });

  it("records the complete provider-operation-state matrix and dual percentiles", () => {
    const docs = readCloseoutDocs();
    expect(docs).toMatch(/675 provider-operation-state cells/i);
    expect(docs).toMatch(/Observed p50/i);
    expect(docs).toMatch(/Observed p95/i);
  });

  it("keeps setup and residual-risk claims current", () => {
    const demo = readFileSync(
      "docs/keiko-editor/2094-managed-language-intelligence-demo.md",
      "utf8",
    );
    const docs = readCloseoutDocs();
    expect(demo).toContain("Node.js 24.18.0");
    expect(demo).toContain("npm ci");
    expect(docs).not.toMatch(/findings remain outside this M6 verification-only/i);
    expect(docs).toMatch(/M5 conflict-UX findings were resolved/i);
  });
});
