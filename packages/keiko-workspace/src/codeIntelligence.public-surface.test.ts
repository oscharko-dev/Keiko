import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import * as codeIntelligence from "./codeIntelligenceSurface.js";

const TYPE_SCRIPT_BACKED_RUNTIME_EXPORTS = [
  "buildCodeIntelligenceIndex",
  "lookupCodeIntelligenceAtoms",
  "queryCodeIntelligenceIndex",
  "importGraphAdapter",
  "testSourcePairingAdapter",
  "createDefaultStructuralRegistry",
  "createEcosystemStructureAdapters",
  "runStructuralAdapters",
] as const;

describe("code-intelligence public surface", () => {
  it("keeps the TypeScript compiler out of a direct workspace root import", () => {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", 'await import("@oscharko-dev/keiko-workspace");'],
      { encoding: "utf8", env: { ...process.env, NODE_DEBUG: "esm" } },
    );

    expect(result.status).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("node_modules/typescript/");
  });

  it("publishes all TypeScript-backed runtime values through the explicit subpath", () => {
    for (const exportName of TYPE_SCRIPT_BACKED_RUNTIME_EXPORTS) {
      expect(exportName in codeIntelligence).toBe(true);
    }
  });
});
