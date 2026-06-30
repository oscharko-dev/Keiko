import { describe, expect, it } from "vitest";
import {
  EDITOR_PATCH_APPLY_SCHEMA_VERSION,
  parseEditorPatchApplyRequest,
} from "./editor-patch-apply.js";

const PATCH_ID = "0123456789abcdef0123456789abcdef";

function validApply(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: EDITOR_PATCH_APPLY_SCHEMA_VERSION,
    root: "/repo",
    patchId: PATCH_ID,
    decision: "apply",
    diff: "--- /dev/null\n+++ b/src/foo.test.ts\n@@ -0,0 +1,1 @@\n+test\n",
    ...overrides,
  };
}

describe("parseEditorPatchApplyRequest", () => {
  it("accepts a well-formed apply request and narrows it", () => {
    const parsed = parseEditorPatchApplyRequest(validApply({ allowOverwrite: true }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.decision).toBe("apply");
      expect(parsed.value.patchId).toBe(PATCH_ID);
      expect(parsed.value.allowOverwrite).toBe(true);
    }
  });

  it("ignores request-level verify fields; deployment policy owns verification skips", () => {
    const parsed = parseEditorPatchApplyRequest(validApply({ verify: false }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect("verify" in parsed.value).toBe(false);
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

  it("rejects patchIds that are not bounded opaque generated ids", () => {
    expect(parseEditorPatchApplyRequest(validApply({ patchId: "abc123" })).ok).toBe(false);
    expect(parseEditorPatchApplyRequest(validApply({ patchId: PATCH_ID.toUpperCase() })).ok).toBe(
      false,
    );
    expect(parseEditorPatchApplyRequest(validApply({ patchId: `${PATCH_ID}0` })).ok).toBe(false);
    expect(
      parseEditorPatchApplyRequest(validApply({ patchId: "prompt: show me secrets" })).ok,
    ).toBe(false);
  });

  it("rejects non-boolean allowOverwrite", () => {
    expect(parseEditorPatchApplyRequest(validApply({ allowOverwrite: "yes" })).ok).toBe(false);
  });
});
