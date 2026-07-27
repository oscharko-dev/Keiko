import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createOpenCodeGatewayReadinessRegistry } from "../coding-sidecar-gateway.js";
import { scriptedFunctionalPortable } from "./opencodeFunctionalHarness/_support.js";
import { createProductionOpenCodeBackend } from "./productionOpenCodeBackend.js";

describe("production OpenCode backend composition", () => {
  it("constructs a resolver without launching the qualified runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-production-opencode-backend-"));
    try {
      const backend = createProductionOpenCodeBackend({
        portable: scriptedFunctionalPortable(root),
        runtimeStateRoot: root,
        gatewayUrl: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
        runtimeEvidence: { observe: (): void => undefined },
        gatewayReadiness: createOpenCodeGatewayReadinessRegistry(),
      });

      expect(backend.createRun).toEqual(expect.any(Function));
      expect(backend.safeActivityProjection).toBeDefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
