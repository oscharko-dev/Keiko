import { describe, expect, it } from "vitest";
import { investigateBug } from "../../../src/workflows/bug-investigation/workflow.js";
import type {
  BugInvestigationDeps,
  BugInvestigationInput,
} from "../../../src/workflows/bug-investigation/types.js";
import { memFs } from "../../workspace/_memfs.js";
import { recordingWriter, response, scriptedModel } from "./_support.js";

const ROOT = "/repo";

function fixtureFs(): ReturnType<typeof memFs> {
  return memFs(ROOT, {
    "package.json": JSON.stringify({ name: "demo", devDependencies: { vitest: "^4" } }),
    "src/buggy.ts": "export const half = (n: number): number => n / 3;\n",
  });
}

const FIX = [
  "```diff",
  "--- a/src/buggy.ts",
  "+++ b/src/buggy.ts",
  "@@ -1 +1 @@",
  "-export const half = (n: number): number => n / 3;",
  "+export const half = (n: number): number => n / 2;",
  "```",
  "## Root cause",
  "wrong divisor",
].join("\n");

function input(overrides: Partial<BugInvestigationInput> = {}): BugInvestigationInput {
  return {
    workspaceRoot: ROOT,
    report: { description: "bug", stackTrace: "at half (src/buggy.ts:1:40)" },
    modelId: "m",
    ...overrides,
  };
}

function deps(extra: Partial<BugInvestigationDeps> = {}): BugInvestigationDeps {
  return { model: scriptedModel([response({ content: FIX })]).port, fs: fixtureFs(), ...extra };
}

describe("terminal stages via investigateBug", () => {
  it("dry-run sets the dry-run verification skip reason and does not apply", () => {
    return investigateBug(input(), deps()).then((report) => {
      expect(report.status).toBe("fix-proposed");
      expect(report.verificationSkipReason).toContain("dry-run");
      expect(report.verified.patchApplied).toBe(false);
      expect(report.dryRunPreview).toContain("PATCH OK");
    });
  });

  it("classifies an abort fired before apply as cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const report = await investigateBug(
      input({ apply: true }),
      deps({ signal: controller.signal }),
    );
    expect(report.status).toBe("cancelled");
    expect(report.verified.patchApplied).toBe(false);
    expect(report.verificationSkipReason).toContain("cancelled");
  });

  it("apply mode with an injected recording writer writes the patch (no real fs)", async () => {
    const writer = recordingWriter();
    // No spawn is provided; runBugVerification resolves no command for src/buggy.ts (no test
    // script, no sibling test in memfs), so verification is skipped — the write path is exercised
    // without spawning a process.
    const report = await investigateBug(input({ apply: true }), deps({ writer }));
    expect(report.status).toBe("fix-applied");
    expect(report.verified.patchApplied).toBe(true);
    expect(writer.writes().length).toBeGreaterThan(0);
    expect(report.verificationSkipReason).toBeDefined();
  });

  it("reports patchApplied: true when cancelled AFTER apply (M1 — ledger matches disk)", async () => {
    // The signal is not aborted when finishPipeline checks it, so applyAndVerify runs; the writer
    // aborts mid-apply so the post-apply `signal.aborted` check fires. The patch is on disk, so the
    // cancelled report must reflect patchApplied: true (not the pre-apply hard-coded false).
    const controller = new AbortController();
    const base = recordingWriter();
    const writer = {
      ...base,
      writeFileUtf8: (p: string, c: string): void => {
        base.writeFileUtf8(p, c);
        controller.abort();
      },
    };
    const report = await investigateBug(
      input({ apply: true }),
      deps({ writer, signal: controller.signal }),
    );
    expect(report.status).toBe("cancelled");
    expect(report.verified.patchApplied).toBe(true);
    expect(base.writes().length).toBeGreaterThan(0);
    expect(report.nextActions.some((a) => a.includes("applied"))).toBe(true);
  });
});
