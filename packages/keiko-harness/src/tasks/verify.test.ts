import { describe, expect, it } from "vitest";
import { buildVerify } from "./verify.js";

// verify.ts had no dedicated test file (KEIKO-0587, KEIKO-0634): every sibling task builder in
// this directory has one, and the only prior coverage was a single shallow assertion in
// policy.test.ts (allowsTools only). buildVerify's whole design point is that it is deterministic,
// tool-free, patch-free, and verification-free by construction — assert every `allows*` flag
// directly so a future accidental copy-paste (e.g. from investigate-bug.ts, which shares the same
// field list) cannot silently flip one of them without a test failing.
describe("buildVerify", () => {
  it("is deterministic and tool-free: no tools, patch, or verification allowed", () => {
    const plan = buildVerify({ workspaceRoot: "/repo" });
    expect(plan.allowsTools).toBe(false);
    expect(plan.allowsPatch).toBe(false);
    expect(plan.allowsVerification).toBe(false);
  });

  it("targets the supplied workspace root with no messages", () => {
    const plan = buildVerify({ workspaceRoot: "/repo" });
    expect(plan.targetFile).toBe("/repo");
    expect(plan.messages).toEqual([]);
  });

  it("remains tool-free and targets the workspace root even when targetFiles is supplied", () => {
    const plan = buildVerify({ workspaceRoot: "/repo", targetFiles: ["src/a.ts"] });
    expect(plan.allowsTools).toBe(false);
    expect(plan.allowsPatch).toBe(false);
    expect(plan.allowsVerification).toBe(false);
    expect(plan.targetFile).toBe("/repo");
  });
});
