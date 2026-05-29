import { describe, expect, it } from "vitest";
import { buildBugPrompt } from "../../../src/workflows/bug-investigation/prompt.js";
import { parseFailureEvidence } from "../../../src/workflows/bug-investigation/failure-parse.js";
import { makeEntry, makePack } from "./_support.js";
import type { BugReportInput } from "../../../src/workflows/bug-investigation/types.js";

const REPORT: BugReportInput = {
  description: "half() returns the wrong value",
  failingOutput: "AssertionError: expected 5 to equal 3",
  stackTrace: "    at half (src/buggy.ts:1:40)",
};

describe("buildBugPrompt (AC #9 prompt construction)", () => {
  it("requests root cause, a minimal diff, a regression test, and uncertainty", () => {
    const evidence = parseFailureEvidence(REPORT);
    const messages = buildBugPrompt(REPORT, evidence, makePack([]), "vitest");
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("root-cause");
    expect(system).toContain("```diff");
    expect(system).toContain("## Regression test");
    expect(system).toContain("## Uncertainty");
    expect(system).toContain("vitest");
  });

  it("instructs the model to omit the diff when evidence is insufficient (investigation-only)", () => {
    const messages = buildBugPrompt(REPORT, parseFailureEvidence(REPORT), makePack([]), "vitest");
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    expect(system.toLowerCase()).toContain("omit the diff");
    expect(system.toLowerCase()).toContain("do not invent a fix");
  });

  it("forbids editing CI, git hooks, and lockfiles in the scope rule", () => {
    const messages = buildBugPrompt(REPORT, parseFailureEvidence(REPORT), makePack([]), "vitest");
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain(".github/");
    expect(system).toContain(".husky/");
    expect(system).toContain("lockfile");
  });

  it("includes the description, failing output, and implicated locations in the user message", () => {
    const evidence = parseFailureEvidence(REPORT);
    const messages = buildBugPrompt(REPORT, evidence, makePack([]), "vitest");
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    expect(user).toContain("half() returns the wrong value");
    expect(user).toContain("expected 5 to equal 3");
    expect(user).toContain("src/buggy.ts:1");
  });

  it("embeds redacted context excerpts when the pack is non-empty", () => {
    const pack = makePack([makeEntry({ path: "src/buggy.ts", excerpt: "n / 3" })]);
    const messages = buildBugPrompt(REPORT, parseFailureEvidence(REPORT), pack, "vitest");
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    expect(user).toContain("--- src/buggy.ts ---");
    expect(user).toContain("n / 3");
  });

  it("appends a rejection reason on a retry", () => {
    const messages = buildBugPrompt(
      REPORT,
      parseFailureEvidence(REPORT),
      makePack([]),
      "vitest",
      "out-of-scope",
    );
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    expect(user).toContain("rejected: out-of-scope");
  });
});
