import { describe, expect, it } from "vitest";

import * as codeIntelligence from "./codeIntelligenceSurface.js";
import * as workspaceRoot from "./index.js";

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
  it("keeps TypeScript-backed runtime values out of the workspace root barrel", () => {
    for (const exportName of TYPE_SCRIPT_BACKED_RUNTIME_EXPORTS) {
      expect(exportName in workspaceRoot).toBe(false);
      expect(exportName in codeIntelligence).toBe(true);
    }
  });
});
