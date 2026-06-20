import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASSURED_COMMAND_RULES,
  candidateFileText,
  candidateWritePath,
  planGateCommands,
  relativizeCoverageSummary,
  targetSourceRelPath,
  writeCandidateInto,
} from "./assuredPreFilterRunner.js";
import type {
  EditorTestGenerationWirePatch,
  EditorTestGenerationWireTarget,
} from "@oscharko-dev/keiko-contracts";
import { isCommandAllowed } from "@oscharko-dev/keiko-tools";

describe("targetSourceRelPath", () => {
  it("returns the document path for a single-document target", () => {
    const target: EditorTestGenerationWireTarget = {
      kind: "file",
      document: { path: "src/widget.ts", languageId: "typescript", text: "" },
    };
    expect(targetSourceRelPath(target)).toBe("src/widget.ts");
  });

  it("returns the first document for a changed-file-set target", () => {
    const target: EditorTestGenerationWireTarget = {
      kind: "changed-file-set",
      documents: [
        { path: "src/a.ts", languageId: "typescript", text: "" },
        { path: "src/b.ts", languageId: "typescript", text: "" },
      ],
    };
    expect(targetSourceRelPath(target)).toBe("src/a.ts");
  });
});

describe("planGateCommands", () => {
  it("defaults to the vitest TS/JS toolchain gate commands writing reports under the assured dir", () => {
    const cmds = planGateCommands();
    expect(cmds.build).toEqual({ command: "npx", args: ["--no-install", "tsc", "--noEmit"] });
    expect(cmds.test).toEqual({ command: "npx", args: ["--no-install", "vitest", "run"] });
    expect(cmds.coverage.args).toContain("--coverage");
    expect(cmds.coverage.args.some((a) => a.includes(".keiko-assured/patched"))).toBe(true);
    expect(cmds.baseline.args.some((a) => a.includes(".keiko-assured/baseline"))).toBe(true);
    expect(cmds.mutation).toEqual({
      command: "npx",
      args: ["--no-install", "stryker", "run", ".keiko-assured/mutation/stryker.conf.json"],
    });
  });
});

describe("ASSURED_COMMAND_RULES", () => {
  it("allows only no-install npx invocations for the assured toolchain", () => {
    expect(isCommandAllowed(ASSURED_COMMAND_RULES, "npx", ["--no-install", "tsc"])).toMatchObject({
      allowed: true,
    });
    expect(
      isCommandAllowed(ASSURED_COMMAND_RULES, "npx", ["--no-install", "vitest", "run"]),
    ).toMatchObject({ allowed: true });
    expect(
      isCommandAllowed(ASSURED_COMMAND_RULES, "npx", [
        "--no-install",
        "stryker",
        "run",
        ".keiko-assured/mutation/stryker.conf.json",
      ]),
    ).toMatchObject({ allowed: true });
    expect(isCommandAllowed(ASSURED_COMMAND_RULES, "npx", ["eslint"])).toMatchObject({
      allowed: false,
    });
    expect(isCommandAllowed(ASSURED_COMMAND_RULES, "npx", ["--yes", "vitest"])).toMatchObject({
      allowed: false,
    });
  });

  it("returns the identical vitest command set when 'vitest' is passed explicitly", () => {
    expect(planGateCommands("vitest")).toEqual(planGateCommands());
  });

  it("builds hardened Playwright gate commands for a browser-smoke candidate (Issue #1203)", () => {
    const cmds = planGateCommands("playwright");
    // Same hardened, no-install toolchain as the vitest path.
    expect(cmds.build).toEqual({ command: "npx", args: ["--no-install", "tsc", "--noEmit"] });
    expect(cmds.test).toEqual({ command: "npx", args: ["--no-install", "playwright", "test"] });
    // No vitest coverage flags and no Stryker: an end-to-end smoke has no coverage/mutation oracle, so
    // those gates emit no report and the candidate stays unverified (never assured).
    expect(cmds.coverage.args).not.toContain("--coverage");
    expect(cmds.mutation).not.toEqual({ command: "npx", args: ["--no-install", "stryker", "run"] });
  });

  it("allows the hardened no-install playwright command through the assured command rules", () => {
    expect(
      isCommandAllowed(ASSURED_COMMAND_RULES, "npx", ["--no-install", "playwright", "test"]),
    ).toMatchObject({ allowed: true });
    // A bare playwright invocation that would auto-install is still denied by the install flag rule.
    expect(isCommandAllowed(ASSURED_COMMAND_RULES, "npx", ["--yes", "playwright"])).toMatchObject({
      allowed: false,
    });
  });
});

describe("relativizeCoverageSummary", () => {
  it("strips the disposable root prefix from absolute coverage keys", () => {
    const summary = {
      "/tmp/keiko-assured-x/src/widget.ts": { lines: { covered: 9 } },
      total: { lines: { covered: 9 } },
    };
    expect(relativizeCoverageSummary(summary, "/tmp/keiko-assured-x")).toEqual({
      "src/widget.ts": { lines: { covered: 9 } },
      total: { lines: { covered: 9 } },
    });
  });

  it("passes through a non-object summary unchanged", () => {
    expect(relativizeCoverageSummary(undefined, "/tmp/x")).toBeUndefined();
  });
});

describe("candidateFileText", () => {
  it("concatenates the edit newText fragments", () => {
    expect(candidateFileText([{ newText: "a" }, { newText: "b\n" }])).toBe("ab\n");
  });
});

describe("writeCandidateInto", () => {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

  function patch(path: string): EditorTestGenerationWirePatch {
    return {
      patchId: "p",
      files: [{ path, changeKind: "added", edits: [{ range, newText: "test('x', () => {});\n" }] }],
    };
  }

  it("writes safe candidate files inside the disposable root", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-candidate-"));
    try {
      writeCandidateInto(root, patch("tests/generated.test.ts"));
      expect(readFileSync(join(root, "tests/generated.test.ts"), "utf8")).toContain("test(");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects absolute, traversal, denied, and NUL-containing paths", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-candidate-"));
    try {
      for (const unsafe of [
        "/tmp/generated.test.ts",
        "../generated.test.ts",
        ".env",
        `tests/bad\u0000name.test.ts`,
      ]) {
        expect(() => candidateWritePath(root, unsafe)).toThrow();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects writes through a symlinked parent that escapes the disposable root", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-candidate-"));
    const outside = mkdtempSync(join(tmpdir(), "keiko-candidate-outside-"));
    try {
      mkdirSync(join(root, "tests"));
      symlinkSync(outside, join(root, "tests", "escape"));
      expect(() => candidateWritePath(root, "tests/escape/generated.test.ts")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
