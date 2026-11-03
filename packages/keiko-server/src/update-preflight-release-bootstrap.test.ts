import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateBundledCatalog } from "./update-preflight-catalog.js";
import { impactFromCatalog } from "./update-preflight-impact.js";

describe("published-source updater bootstrap impact", () => {
  it("reports the 1.2.6 repair prerequisite while admitting its verified forward path", () => {
    const raw: unknown = JSON.parse(
      readFileSync(new URL("../../../release-impact.catalog.json", import.meta.url), "utf8"),
    );
    const catalog = validateBundledCatalog(raw);
    expect(catalog).toBeDefined();
    const result = impactFromCatalog(catalog, "1.2.6", "1.2.7");

    expect(result.targetReviewed).toBe(true);
    expect(result.impact?.userActionRequired).toBe(true);
    expect(result.impact?.remediations).toEqual(["repair-required"]);
    expect(result.impact?.stateImpact).toEqual([
      expect.objectContaining({
        store: "updater-state",
        userActionRequired: true,
        remediation: "repair-required",
      }),
      expect.objectContaining({
        store: "portable-install-state",
        userActionRequired: true,
        remediation: "repair-required",
      }),
    ]);
    expect(result.impact?.releaseNoteBullets).toContain(
      "Published 1.2.6 and earlier source updaters need the verified one-time bootstrap before using the corrected automatic handoff. Back up local state and preserve private keys when replacing the application bundle.",
    );
    expect(result.blockers).toEqual([]);
  });
});
