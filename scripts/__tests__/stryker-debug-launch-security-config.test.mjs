import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const expectedMutate = [
  "packages/keiko-sandbox/src/debug-capsule.ts",
  "packages/keiko-sandbox/src/debug-capsule-security-predicates.ts",
  "packages/keiko-tools/src/debug-launch-policy.ts",
  "packages/keiko-server/src/editor/processHardening.ts",
  "packages/keiko-server/src/editor/dap/dapCapsuleSupervisor.ts",
  "packages/keiko-server/src/editor/dap/dapEvidenceProjector.ts",
  "packages/keiko-server/src/editor/dap/dapFrameCodec.ts",
  "packages/keiko-server/src/editor/dap/dapLifecycleLedger.ts",
  "packages/keiko-server/src/editor/dap/dapNodeAdapter.ts",
  "packages/keiko-server/src/editor/dap/dapNodeCapsuleLauncher.ts",
  "packages/keiko-server/src/editor/dap/dapPrivateEndpoint.ts",
  "packages/keiko-server/src/editor/dap/dapProcessManager.ts",
  "packages/keiko-server/src/editor/dap/dapProductionService.ts",
  "packages/keiko-server/src/editor/dap/dapProtocolClient.ts",
  "packages/keiko-server/src/editor/dap/dapRestartThrottle.ts",
  "packages/keiko-server/src/editor/dap/debugCapsulePlan.ts",
  "packages/keiko-server/src/editor/dap/debugLaunchSecurityPredicates.ts",
  "packages/keiko-server/src/editor/dap/debugLaunchCatalog.ts",
  "packages/keiko-server/src/editor/dap/debugLaunchContext.ts",
  "packages/keiko-server/src/editor/dap/debugLaunchPlan.ts",
  "packages/keiko-server/src/editor/dap/testing/debugLaunchTopology.ts",
  "packages/keiko-server/src/editor/dap/debugSessionRegistry.ts",
  "packages/keiko-server/src/editor/dap/providers/dapAdapterProviders.ts",
  "packages/keiko-server/src/editor/dap/providers/nodeDebugAdapter.ts",
];

const expectedTests = [
  "packages/keiko-sandbox/src/debug-capsule.test.ts",
  "packages/keiko-sandbox/src/debug-capsule-security-predicates.test.ts",
  "packages/keiko-tools/src/debug-launch-policy.test.ts",
  "packages/keiko-server/src/editor/processHardening.test.ts",
  "packages/keiko-server/src/editor/dap/dapCapsuleSupervisor.test.ts",
  "packages/keiko-server/src/editor/dap/dapEvidenceProjector.test.ts",
  "packages/keiko-server/src/editor/dap/dapFrameCodec.test.ts",
  "packages/keiko-server/src/editor/dap/dapLifecycleLedger.test.ts",
  "packages/keiko-server/src/editor/dap/dapNodeAdapter.test.ts",
  "packages/keiko-server/src/editor/dap/dapNodeCapsuleLauncher.test.ts",
  "packages/keiko-server/src/editor/dap/dapPrivateEndpoint.test.ts",
  "packages/keiko-server/src/editor/dap/dapProcessManager.test.ts",
  "packages/keiko-server/src/editor/dap/dapProductionService.test.ts",
  "packages/keiko-server/src/editor/dap/dapProtocolClient.test.ts",
  "packages/keiko-server/src/editor/dap/dapRestartThrottle.test.ts",
  "packages/keiko-server/src/editor/dap/debugCapsulePlan.test.ts",
  "packages/keiko-server/src/editor/dap/debugLaunchSecurityPredicates.test.ts",
  "packages/keiko-server/src/editor/dap/debugLaunchCatalog.test.ts",
  "packages/keiko-server/src/editor/dap/debugLaunchContext.test.ts",
  "packages/keiko-server/src/editor/dap/debugLaunchPlan.test.ts",
  "packages/keiko-server/src/editor/dap/testing/debugLaunchReachability.spike.test.ts",
  "packages/keiko-server/src/editor/dap/debugSessionRegistry.test.ts",
  "packages/keiko-server/src/editor/dap/providers/dapAdapterProviders.test.ts",
  "packages/keiko-server/src/editor/dap/providers/nodeDebugAdapter.test.ts",
  "packages/keiko-server/src/editor/dap/debugLifecycleIntegration.test.ts",
];

async function loadConfig(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("debug launch security mutation configuration", () => {
  it("enforces the complete D13 runtime scope at one hundred percent", async () => {
    const [config, globalConfig] = await Promise.all([
      loadConfig("stryker.debug-launch.security.conf.json"),
      loadConfig("stryker.security.conf.json"),
    ]);

    expect(config.ignoreStatic).toBe(false);
    expect(config.thresholds).toStrictEqual({ break: 100, high: 100, low: 100 });
    expect(config.mutate).toStrictEqual(expectedMutate);
    expect(config.testFiles).toStrictEqual(expectedTests);
    expect(globalConfig.ignoreStatic).toBe(true);
    expect(globalConfig.mutate).toEqual(expect.arrayContaining(expectedMutate));
  });
});
