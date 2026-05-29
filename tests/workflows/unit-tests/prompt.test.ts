import { describe, expect, it } from "vitest";
import { buildPrompt } from "../../../src/workflows/unit-tests/prompt.js";
import type {
  TestConventions,
  UnitTestWorkflowInput,
} from "../../../src/workflows/unit-tests/types.js";
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
    const msgs = buildPrompt(fileInput(), conventions(), makePack([]));
    expect(msgs.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("names the detected framework and naming style in the system message", () => {
    const msgs = buildPrompt(fileInput(), conventions({ framework: "jest" }), makePack([]));
    expect(msgs[0]?.content).toContain("jest");
    expect(msgs[0]?.content).toContain("mirrored");
  });

  it("specifies the fenced-diff output contract and the test-only constraint", () => {
    const system = buildPrompt(fileInput(), conventions(), makePack([]))[0]?.content ?? "";
    expect(system).toContain("```diff");
    expect(system).toContain("never modify");
  });

  it("includes assertion-style samples when present", () => {
    const conv = conventions({ assertionStyleSamples: ["expect(add(1,2)).toBe(3)"] });
    const system = buildPrompt(fileInput(), conv, makePack([]))[0]?.content ?? "";
    expect(system).toContain("expect(add(1,2)).toBe(3)");
  });

  it("describes a function target when targetFunction is set", () => {
    const input = fileInput({
      target: { kind: "file", filePath: "src/add.ts", targetFunction: "add" },
    });
    const user = buildPrompt(input, conventions(), makePack([]))[1]?.content ?? "";
    expect(user).toContain("function add");
    expect(user).toContain("src/add.ts");
  });

  it("embeds redacted context excerpts in the user message", () => {
    const pack = makePack([makeEntry({ path: "src/add.ts", excerpt: "export const add = ..." })]);
    const user = buildPrompt(fileInput(), conventions(), pack)[1]?.content ?? "";
    expect(user).toContain("src/add.ts");
    expect(user).toContain("export const add");
  });

  it("appends the rejection reason on a retry", () => {
    const user =
      buildPrompt(fileInput(), conventions(), makePack([]), "out-of-scope")[1]?.content ?? "";
    expect(user).toContain("out-of-scope");
    expect(user).toContain("ONLY test files");
  });

  it("describes module and changedFiles targets", () => {
    const moduleUser =
      buildPrompt(
        fileInput({ target: { kind: "module", moduleDir: "src/math" } }),
        conventions(),
        makePack([]),
      )[1]?.content ?? "";
    expect(moduleUser).toContain("src/math");
    const changedUser =
      buildPrompt(
        fileInput({ target: { kind: "changedFiles", filePaths: ["src/a.ts", "src/b.ts"] } }),
        conventions(),
        makePack([]),
      )[1]?.content ?? "";
    expect(changedUser).toContain("src/a.ts");
    expect(changedUser).toContain("src/b.ts");
  });

  it("is deterministic for identical inputs (pure)", () => {
    const a = buildPrompt(fileInput(), conventions(), makePack([]));
    const b = buildPrompt(fileInput(), conventions(), makePack([]));
    expect(a).toEqual(b);
  });
});
