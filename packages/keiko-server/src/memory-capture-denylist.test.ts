import { describe, expect, it } from "vitest";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { memoryTextSecretEgressRejectionReason } from "@oscharko-dev/keiko-memory-capture";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import { memoryCapturePolicyForDeps } from "./memory-capture-policy.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore } from "./store/index.js";

function deps(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: createInMemoryEvidenceStore(),
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    ...overrides,
  };
}

describe("memory category denylist provisioning", () => {
  it("provisions the health-data and identifiable-third-party defaults", () => {
    const policy = memoryCapturePolicyForDeps(deps());
    expect(memoryTextSecretEgressRejectionReason("The medical record changed.", policy)).toBe(
      "denied-category",
    );
    expect(memoryTextSecretEgressRejectionReason("My colleague is moving teams.", policy)).toBe(
      "denied-category",
    );
  });

  it("adds a deployment-specific category alongside the built-in defaults, never replacing them", () => {
    const memoryDeniedCategoryMatchers = [
      { category: "deployment-specific", matchers: [/\brestricted fixture category\b/iu] },
    ];
    const policy = memoryCapturePolicyForDeps(deps({ memoryDeniedCategoryMatchers }));
    expect(
      memoryTextSecretEgressRejectionReason("A restricted fixture category is present.", policy),
    ).toBe("denied-category");
    // The built-in health-data and identifiable-third-party protections must survive a partial
    // deployment override — an operator adding one custom category never silently drops them.
    expect(memoryTextSecretEgressRejectionReason("The medical record changed.", policy)).toBe(
      "denied-category",
    );
    expect(memoryTextSecretEgressRejectionReason("My colleague is moving teams.", policy)).toBe(
      "denied-category",
    );
  });

  it("lets a deployment override a specific built-in category by reusing its category name", () => {
    const memoryDeniedCategoryMatchers = [
      { category: "health-data", matchers: [/\bcustom health marker\b/iu] },
    ];
    const policy = memoryCapturePolicyForDeps(deps({ memoryDeniedCategoryMatchers }));
    expect(memoryTextSecretEgressRejectionReason("A custom health marker was noted.", policy)).toBe(
      "denied-category",
    );
    // The default health-data matchers are superseded by the same-named deployment entry...
    expect(memoryTextSecretEgressRejectionReason("The medical record changed.", policy)).toBeNull();
    // ...while the untouched identifiable-third-party default is unaffected.
    expect(memoryTextSecretEgressRejectionReason("My colleague is moving teams.", policy)).toBe(
      "denied-category",
    );
  });
});
