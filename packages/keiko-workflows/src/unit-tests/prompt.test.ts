import { describe, expect, it } from "vitest";
import { buildPrompt } from "./prompt.js";
import type { TestStrategy, TestStyle } from "./frontend.js";
import type { TestConventions, UnitTestWorkflowInput } from "./types.js";
import { makeEntry, makePack } from "./_support.js";

function conventions(overrides: Partial<TestConventions> = {}): TestConventions {
  return {
    framework: "vitest",
    testDirs: ["tests"],
    fileNamingStyle: "mirrored",
    assertionStyleSamples: [],
    ...overrides,
  };
}

function strategy(style: TestStyle = "unit"): TestStrategy {
  return {
    style,
    reason: `reason-${style}`,
    verification: style === "browser-smoke" ? "playwright" : "vitest",
  };
}

function fileInput(overrides: Partial<UnitTestWorkflowInput> = {}): UnitTestWorkflowInput {
  return {
    workspaceRoot: "/repo",
    target: { kind: "file", filePath: "src/add.ts" },
    modelId: "m",
    ...overrides,
  };
}

describe("buildPrompt (AC #9)", () => {
  it("yields a system message then a user message", () => {
    const msgs = buildPrompt(fileInput(), conventions(), strategy(), makePack([]));
    expect(msgs.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("names the detected framework and naming style in the system message", () => {
    const msgs = buildPrompt(
      fileInput(),
      conventions({ framework: "jest" }),
      strategy(),
      makePack([]),
    );
    expect(msgs[0]?.content).toContain("jest");
    expect(msgs[0]?.content).toContain("mirrored");
  });

  it("specifies the fenced-diff output contract and the test-only constraint", () => {
    const system =
      buildPrompt(fileInput(), conventions(), strategy(), makePack([]))[0]?.content ?? "";
    expect(system).toContain("```diff");
    expect(system).toContain("never modify");
    expect(system).toContain("--- /dev/null");
    expect(system).toContain("@@");
    expect(system).toContain("*** Begin Patch");
    expect(system).toContain("\\n+");
  });

  it("includes assertion-style samples when present", () => {
    const conv = conventions({ assertionStyleSamples: ["expect(add(1,2)).toBe(3)"] });
    const system = buildPrompt(fileInput(), conv, strategy(), makePack([]))[0]?.content ?? "";
    expect(system).toContain("expect(add(1,2)).toBe(3)");
  });

  it("describes a function target when targetFunction is set", () => {
    const input = fileInput({
      target: { kind: "file", filePath: "src/add.ts", targetFunction: "add" },
    });
    const user = buildPrompt(input, conventions(), strategy(), makePack([]))[1]?.content ?? "";
    expect(user).toContain("function add");
    expect(user).toContain("src/add.ts");
  });

  it("embeds redacted context excerpts in the user message", () => {
    const pack = makePack([makeEntry({ path: "src/add.ts", excerpt: "export const add = ..." })]);
    const user = buildPrompt(fileInput(), conventions(), strategy(), pack)[1]?.content ?? "";
    expect(user).toContain("src/add.ts");
    expect(user).toContain("export const add");
  });

  it("appends the rejection reason on a retry", () => {
    const user =
      buildPrompt(fileInput(), conventions(), strategy(), makePack([]), "out-of-scope")[1]
        ?.content ?? "";
    expect(user).toContain("out-of-scope");
    expect(user).toContain("ONLY test files");
  });

  it("describes module and changedFiles targets", () => {
    const moduleUser =
      buildPrompt(
        fileInput({ target: { kind: "module", moduleDir: "src/math" } }),
        conventions(),
        strategy(),
        makePack([]),
      )[1]?.content ?? "";
    expect(moduleUser).toContain("src/math");
    const changedUser =
      buildPrompt(
        fileInput({ target: { kind: "changedFiles", filePaths: ["src/a.ts", "src/b.ts"] } }),
        conventions(),
        strategy(),
        makePack([]),
      )[1]?.content ?? "";
    expect(changedUser).toContain("src/a.ts");
    expect(changedUser).toContain("src/b.ts");
  });

  it("is deterministic for identical inputs (pure)", () => {
    const a = buildPrompt(fileInput(), conventions(), strategy(), makePack([]));
    const b = buildPrompt(fileInput(), conventions(), strategy(), makePack([]));
    expect(a).toEqual(b);
  });
});

describe("buildPrompt — per-style adaptation (Issue #1203)", () => {
  function system(style: TestStyle): string {
    return buildPrompt(fileInput(), conventions(), strategy(style), makePack([]))[0]?.content ?? "";
  }

  it("unit style instructs edge-case coverage and no component idioms", () => {
    const content = system("unit");
    expect(content).toContain("unit tests");
    expect(content).toContain("edge cases");
    expect(content).not.toContain("@testing-library/react");
  });

  it("component style instructs @testing-library/react render/screen idioms", () => {
    const content = system("component");
    expect(content).toContain("React component tests");
    expect(content).toContain("@testing-library/react");
    expect(content).toContain("screen");
  });

  it("interaction style instructs @testing-library/user-event", () => {
    const content = system("interaction");
    expect(content).toContain("@testing-library/user-event");
    expect(content).toContain("userEvent.setup()");
  });

  it("accessibility-smoke style instructs an accessibility assertion", () => {
    const content = system("accessibility-smoke");
    expect(content).toContain("accessibility");
    expect(content).toContain("axe");
  });

  it("browser-smoke style instructs a minimal Playwright smoke test", () => {
    const content = system("browser-smoke");
    expect(content).toContain("Browser test runner: Playwright");
    expect(content).not.toContain("Test framework: vitest");
    expect(content).toContain("@playwright/test");
    expect(content).toContain("smoke");
    expect(content).toContain("end-to-end");
  });

  it("browser-smoke style asks for a Playwright route smoke, not unit tests", () => {
    const user =
      buildPrompt(fileInput(), conventions(), strategy("browser-smoke"), makePack([]))[1]
        ?.content ?? "";
    expect(user).toContain("minimal Playwright browser smoke test");
    expect(user).toContain("route or application entry point");
    expect(user).toContain("src/add.ts");
    expect(user).not.toContain("unit tests");
  });

  it("keeps the same fenced-diff output contract for every style", () => {
    for (const style of [
      "unit",
      "component",
      "interaction",
      "accessibility-smoke",
      "browser-smoke",
    ] as const) {
      expect(system(style)).toContain("```diff");
    }
  });
});
