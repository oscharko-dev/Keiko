// Epic #518 / Issue #528 — workspace descriptor meta table production assertion.
//
// In dev / test the module-evaluation throw in descriptor-meta.ts catches
// any inconsistency before any user action. This test is the production
// assertion: it loads the meta table, runs the validator across every
// entry, and fails CI if any descriptor is misconfigured.
//
// Also pins:
//   - the meta table covers EVERY WindowType in the registry (no
//     descriptor escapes validation),
//   - WIN_META keys are exactly the WindowsRegistry WIN_TYPES keys.

import { describe, expect, it } from "vitest";
import { validateWorkspaceDescriptorMeta } from "@oscharko-dev/keiko-contracts";
import { WIN_META, validateAllDescriptorMeta } from "./descriptor-meta";
import { WIN_TYPES } from "./WindowsRegistry";

describe("descriptor meta table — production assertion (epic #518 #528 / ADR-0029)", () => {
  it("validateAllDescriptorMeta returns no errors", () => {
    const errors = validateAllDescriptorMeta();
    expect(errors).toEqual([]);
  });

  it("every WindowType has a meta entry — no descriptor escapes validation", () => {
    const winTypes = Object.keys(WIN_TYPES).sort();
    const metaTypes = Object.keys(WIN_META).sort();
    expect(metaTypes).toEqual(winTypes);
  });

  it("every meta entry passes the validator individually", () => {
    for (const type of Object.keys(WIN_META) as Array<keyof typeof WIN_META>) {
      const errors = validateWorkspaceDescriptorMeta(type, WIN_META[type]);
      expect(errors, `descriptor '${type}' failed validation`).toEqual([]);
    }
  });

  it("evidence-bearing review descriptor declares evidence trust + evidence-reference persistence", () => {
    expect(WIN_META.review.trustBoundary).toContain("evidence");
    expect(WIN_META.review.persistence).toBe("evidence-reference");
  });

  it("chat descriptor crosses the model trust boundary and requires user confirm", () => {
    expect(WIN_META.chat.trustBoundary).toContain("model");
    expect(WIN_META.chat.authority).toBe("user-confirm");
  });

  it("terminal descriptor crosses the tool trust boundary and requires user confirm", () => {
    expect(WIN_META.terminal.trustBoundary).toContain("tool");
    expect(WIN_META.terminal.authority).toBe("user-confirm");
  });

  it("inspector / notifications descriptors are ui-only with the ui trust boundary alone", () => {
    expect(WIN_META.inspector.authority).toBe("ui-only");
    expect(WIN_META.inspector.trustBoundary).toEqual(["ui"]);
    expect(WIN_META.notifications.authority).toBe("ui-only");
    expect(WIN_META.notifications.trustBoundary).toEqual(["ui"]);
  });
});
