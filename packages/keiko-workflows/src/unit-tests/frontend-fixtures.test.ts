// Fixture-driven proof of convention-driven frontend test-style selection (Issue #1203). Runs the
// real detector + selector against the on-disk fixture projects under
// tests/fixtures/frontend-test-generation/ so detection is proven grounded in real package manifests
// and framework config, and asserts each project's expected test file uses the idioms of its style.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectWorkspace } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { detectFrontendStack, selectTestStrategy, type TestStyle } from "./frontend.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "tests",
  "fixtures",
  "frontend-test-generation",
);

function projectDir(name: string): string {
  return join(FIXTURES, name);
}

function styleFor(project: string, anchorRelPath: string): TestStyle {
  const root = projectDir(project);
  const workspace = detectWorkspace(root, nodeWorkspaceFs);
  const stack = detectFrontendStack(workspace, nodeWorkspaceFs, anchorRelPath);
  return selectTestStrategy({
    targetPath: anchorRelPath,
    framework: workspace.testFramework,
    stack,
  }).style;
}

function expectedTestText(project: string, relPath: string): string {
  const path = join(projectDir(project), relPath);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, "utf8");
}

describe("frontend test-generation fixtures (Issue #1203)", () => {
  it("library-project: a Vitest library file selects the unit style", () => {
    expect(styleFor("library-project", "src/sum.ts")).toBe("unit");
    const text = expectedTestText("library-project", "tests/sum.test.ts");
    expect(text).toContain('from "vitest"');
    expect(text).toContain("expect(");
    expect(text).not.toContain("@testing-library/react");
  });

  it("rtl-project: a React component with RTL + user-event selects the interaction style", () => {
    expect(styleFor("rtl-project", "src/Counter.tsx")).toBe("interaction");
    const text = expectedTestText("rtl-project", "tests/Counter.test.tsx");
    expect(text).toContain("@testing-library/react");
    expect(text).toContain("render(");
    expect(text).toContain("screen.getByRole");
    expect(text).toContain("userEvent.setup()");
  });

  it("playwright-project: an app entry point in a Playwright project selects browser-smoke", () => {
    expect(styleFor("playwright-project", "app/page.tsx")).toBe("browser-smoke");
    const text = expectedTestText("playwright-project", "e2e/home.spec.ts");
    expect(text).toContain("@playwright/test");
    expect(text).toContain("page.goto");
    expect(text).toContain("toBeVisible()");
  });

  it("playwright-project: a non-entry library file is NOT browser-smoke (AC3)", () => {
    // Same project (Playwright present) but a plain library path → unit, never browser-smoke.
    expect(styleFor("playwright-project", "src/lib/format.ts")).toBe("unit");
  });

  it("unsupported-project: a React component without a supported stack is unsupported (AC5)", () => {
    expect(styleFor("unsupported-project", "src/Widget.tsx")).toBe("unsupported");
    expect(existsSync(join(projectDir("unsupported-project"), "tests"))).toBe(false);
  });
});
