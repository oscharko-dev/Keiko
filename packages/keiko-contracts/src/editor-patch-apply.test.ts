import { describe, expect, it } from "vitest";
import {
  EDITOR_PATCH_APPLY_SCHEMA_VERSION,
  parseEditorPatchApplyRequest,
} from "./editor-patch-apply.js";

function validApply(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: EDITOR_PATCH_APPLY_SCHEMA_VERSION,
    root: "/repo",
    patchId: "abc123",
    decision: "apply",
    diff: "--- /dev/null\n+++ b/src/foo.test.ts\n@@ -0,0 +1,1 @@\n+test\n",
    ...overrides,
  };
}

describe("parseEditorPatchApplyRequest", () => {
  it("accepts a well-formed apply request and narrows it", () => {
    const parsed = parseEditorPatchApplyRequest(
      validApply({ allowOverwrite: true, verify: false }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.decision).toBe("apply");
      expect(parsed.value.patchId).toBe("abc123");
      expect(parsed.value.allowOverwrite).toBe(true);
      expect(parsed.value.verify).toBe(false);
    }
  });

  it("accepts a reject request with an empty diff", () => {
    const parsed = parseEditorPatchApplyRequest(validApply({ decision: "reject", diff: "" }));
    expect(parsed.ok).toBe(true);
  });

  it("omits absent optional fields rather than defaulting them", () => {
    const parsed = parseEditorPatchApplyRequest(validApply());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect("allowOverwrite" in parsed.value).toBe(false);
      expect("verify" in parsed.value).toBe(false);
    }
  });

  it("rejects a non-object", () => {
    expect(parseEditorPatchApplyRequest(null).ok).toBe(false);
    expect(parseEditorPatchApplyRequest("x").ok).toBe(false);
  });

  it("rejects a wrong schema version", () => {
    const parsed = parseEditorPatchApplyRequest(validApply({ schemaVersion: "2" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.some((e) => e.includes("schemaVersion"))).toBe(true);
    }
  });

  it("rejects an empty diff for an apply decision", () => {
    const parsed = parseEditorPatchApplyRequest(validApply({ diff: "" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.some((e) => e.includes("non-empty"))).toBe(true);
    }
  });

  it("rejects an unknown decision", () => {
    expect(parseEditorPatchApplyRequest(validApply({ decision: "merge" })).ok).toBe(false);
  });

  it("rejects a missing patchId and a non-string diff", () => {
    expect(parseEditorPatchApplyRequest(validApply({ patchId: "" })).ok).toBe(false);
    expect(parseEditorPatchApplyRequest(validApply({ diff: 7 })).ok).toBe(false);
  });

  it("rejects non-boolean allowOverwrite / verify", () => {
    expect(parseEditorPatchApplyRequest(validApply({ allowOverwrite: "yes" })).ok).toBe(false);
    expect(parseEditorPatchApplyRequest(validApply({ verify: 1 })).ok).toBe(false);
  });
});
