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

  it("pdf preview restores only a durable UI shell and crosses only the network boundary for session fetch", () => {
    expect(WIN_META.pdfCitationPreview.persistence).toBe("durable.ui");
    expect(WIN_META.pdfCitationPreview.trustBoundary).toEqual(["ui", "network"]);
    expect(WIN_META.pdfCitationPreview.authority).toBe("user-confirm");
  });

  // KEIKO-0175 — MobilePanel.tsx (packages/keiko-ui/.../widgets/panels/MobilePanel.tsx) is a
  // ~21-line static component: no pairing state, no network call, no persisted config. The
  // descriptor previously claimed lifecycle [paired, unpaired, error], a network trust boundary,
  // and durable.config persistence — none of which the component's source backs.
  it("mobile descriptor matches MobilePanel's static shape — no network boundary, no durable persistence", () => {
    expect(WIN_META.mobile.trustBoundary).not.toContain("network");
    expect(WIN_META.mobile.persistence).not.toBe("durable.config");
    expect(WIN_META.mobile.lifecycle).toEqual(["live"]);
    expect(WIN_META.mobile.trustBoundary).toEqual(["ui"]);
    expect(WIN_META.mobile.authority).toBe("read-only");
    expect(WIN_META.mobile.persistence).toBe("transient");
  });

  // KEIKO-0175 — PluginsPanel.tsx renders hardcoded MCP/connector fixture rows; its MCP toggle
  // flips only ephemeral in-memory React state (no localStorage call, unlike AutomationsPanel's
  // verified `localStorage.setItem(STORE_KEY, ...)`), and no install/uninstall flow exists. The
  // descriptor previously claimed an "installed" lifecycle state and durable.config persistence —
  // neither of which any call site in PluginsPanel backs.
  it("plugins descriptor matches PluginsPanel's placeholder shape — no network boundary, no durable persistence", () => {
    expect(WIN_META.plugins.trustBoundary).not.toContain("network");
    expect(WIN_META.plugins.persistence).not.toBe("durable.config");
    expect(WIN_META.plugins.lifecycle).toEqual(["live"]);
    expect(WIN_META.plugins.trustBoundary).toEqual(["ui"]);
    expect(WIN_META.plugins.authority).toBe("read-only");
    expect(WIN_META.plugins.persistence).toBe("transient");
  });

  // KEIKO-0158 — AutomationsPanel.tsx's per-row Toggle (role="switch", persisting to
  // localStorage) was replaced with plain non-interactive status-text rows; no scheduler is
  // wired behind any row and the component owns no self-managed durable config anymore. The
  // descriptor previously claimed "user" authority and "durable.config" (self-managed)
  // persistence — neither of which the component's source backs anymore. The window still
  // remembers its own position across a reload like any other tool window (durable.ui).
  it("automations descriptor matches AutomationsPanel's placeholder shape — no self-managed durable config, no user-originated effect", () => {
    expect(WIN_META.automations.persistence).not.toBe("durable.config");
    expect(WIN_META.automations.authority).not.toBe("user");
    expect(WIN_META.automations.lifecycle).toEqual(["live"]);
    expect(WIN_META.automations.trustBoundary).toEqual(["ui"]);
    expect(WIN_META.automations.authority).toBe("read-only");
    expect(WIN_META.automations.persistence).toBe("durable.ui");
  });

  it("Coding Workbench config exposes supervised and autonomous preview states", () => {
    const stateField = WIN_TYPES.coding.config?.find((field) => field.key === "state");

    expect(stateField?.options).toEqual([
      "empty",
      "running",
      "approval-required",
      "blocked",
      "governed-assist",
      "governed-assist-blocked",
      "supervised-approval-required",
      "supervised-approved",
      "supervised-denied",
      "supervised-stopped",
      "supervised-failed",
      "autonomous-confirmed",
      "autonomous-policy-blocked",
      "autonomous-verification-failed",
      "autonomous-completed",
      "failed",
      "completed",
    ]);
  });
});
