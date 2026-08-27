import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import * as contractsRoot from "./index.js";
import { KEIKO_CONTRACTS_VERSION } from "./version.js";

const unreferencedRuntimeSubpaths = [
  "./runtime/evaluation-gates",
  "./runtime/figma-codegen",
  "./runtime/git-delivery-provider",
  "./runtime/qualityIntelligence/editableRevision",
  "./runtime/verification-summary",
  "./runtime/workflow-descriptor",
  "./runtime/workflow-handoff",
] as const;

describe("contracts runtime surface", () => {
  it("keeps the root barrel type-only while runtime values remain available from their domain module", () => {
    expect(Object.keys(contractsRoot)).toEqual([]);
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(KEIKO_CONTRACTS_VERSION).toBe(manifest.version);
  });

  it("does not publish unreferenced runtime-only subpaths", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { exports: Record<string, unknown> };

    for (const subpath of unreferencedRuntimeSubpaths) {
      expect(manifest.exports).not.toHaveProperty(subpath);
    }
  });
});
