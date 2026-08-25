import { describe, expect, it } from "vitest";

import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts";
import {
  DEFAULT_VERIFICATION_LIMITS,
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
    expect(capabilities.networkIsolation).toEqual({ backend: "none", enforced: false });
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

    const attested = probeVerificationCapabilities({ steps: [] }, "enforce-or-fail-closed", {
      backend: "bubblewrap",
      enforced: true,
    });
    expect(attested.networkIsolation).toEqual({ backend: "bubblewrap", enforced: true });
    expect(attested.defaultDenialReasons).not.toContain("network-isolation-unavailable");

    const inherited = probeVerificationCapabilities(
      {
        steps: [
          {
            kind: "test",
            scriptName: "test",
            command: "npm",
            args: ["test"],
            limits: DEFAULT_VERIFICATION_LIMITS,
          },
        ],
      },
      "inherit",
      { backend: "bubblewrap", enforced: true },
    );
    expect(inherited.steps[0]).toMatchObject({
      requiresNetworkIsolation: true,
      runnable: false,
      denialReasons: ["network-isolation-unavailable"],
    });

    expect(() =>
      probeVerificationCapabilities({ steps: [] }, "enforce-or-fail-closed", {
        backend: "none",
        enforced: true,
      } as never),
    ).toThrow(TypeError);

    expect(() =>
      probeVerificationCapabilities({ steps: [] }, "enforce-or-fail-closed", {
        backend: "unknown",
        enforced: true,
      } as never),
    ).toThrow(TypeError);
    expect(() =>
      probeVerificationCapabilities({ steps: [] }, "enforce-or-fail-closed", {
        backend: "bubblewrap",
        enforced: "yes",
      } as never),
    ).toThrow(TypeError);
  });
});
