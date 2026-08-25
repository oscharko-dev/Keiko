import { describe, expect, it } from "vitest";

import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts";
import {
  DEFAULT_VERIFICATION_LIMITS,
  probeNetworkIsolation,
  probeVerificationCapabilities,
  SDK_VERSION,
} from "./index.js";

describe("SDK package surface", () => {
  it("keeps SDK_VERSION aligned with the product version contract", () => {
    expect(SDK_VERSION).toBe(KEIKO_PRODUCT_VERSION);
  });

  it("exposes current enforcement capability and an explicit default verification disposition", () => {
    const capabilities = probeVerificationCapabilities({
      steps: [
        {
          kind: "test",
          scriptName: "test",
          command: "npm",
          args: ["test"],
          limits: DEFAULT_VERIFICATION_LIMITS,
        },
      ],
    });
    expect(probeNetworkIsolation().backend).toBe(capabilities.networkIsolation.backend);
    expect(typeof capabilities.memoryProcessTreeEnforced).toBe("boolean");
    expect(typeof capabilities.defaultRunnable).toBe("boolean");
    expect(capabilities.steps[0]).toMatchObject({
      kind: "test",
      requiresMemoryCeiling: false,
      requiresNetworkIsolation: true,
    });
    if (!capabilities.defaultRunnable) {
      expect(capabilities.defaultDenialReasons).toContain("network-isolation-unavailable");
    }
  });
});
