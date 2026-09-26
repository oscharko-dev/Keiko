import { describe, expect, it } from "vitest";

import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";

import { productionGitDeliveryModeGrants } from "../coding-runtime/productionRuntimeWorkspaceAuthority.js";
import { productionScopedGitDeliveryAuthority } from "./runBoundAuthority.test-support.js";

const MODES: readonly CodingWorkbenchMode[] = [
  "governed-assist",
  "supervised-coding",
  "autonomous-delivery",
];

// Epic #3384 correction 5, item 2: `productionScopedGitDeliveryAuthority`'s per-mode grant is no
// longer a hand-restated copy of the production formula — it calls `productionGitDeliveryModeGrants`
// directly. This test still pins the connection explicitly, so a future edit that reintroduces a
// hardcoded literal into the fixture (instead of calling the producer) fails here immediately,
// rather than silently drifting from production the way #3386's original fixture did (AGENTS.md §7:
// "a fixture never restates a formula the code under test owns").
describe("productionScopedGitDeliveryAuthority stays derived from productionGitDeliveryModeGrants", () => {
  it.each(MODES)("matches the production per-mode grant for %s", (mode) => {
    const port = productionScopedGitDeliveryAuthority(
      () => "project",
      () => "project",
      mode,
    );
    const active = port.current("2026-07-13T12:00:00.000Z");
    const expected = productionGitDeliveryModeGrants(mode);

    expect(active).toBeDefined();
    for (const actionClass of expected.actionClasses) {
      expect(active?.authority.actionClasses).toContain(actionClass);
    }
    expect(active?.authority.connectorScopes).toEqual(expected.connectorScopes);
  });

  it("carries no undeclared delivery-substrate or connector-access outside the production grant", () => {
    for (const mode of MODES) {
      const port = productionScopedGitDeliveryAuthority(
        () => "project",
        () => "project",
        mode,
      );
      const active = port.current("2026-07-13T12:00:00.000Z");
      const expected = productionGitDeliveryModeGrants(mode);
      const extra = (active?.authority.actionClasses ?? []).filter(
        (actionClass) =>
          (actionClass === "delivery-substrate" || actionClass === "connector-access") &&
          !expected.actionClasses.includes(actionClass),
      );
      expect(extra, mode).toEqual([]);
    }
  });
});
