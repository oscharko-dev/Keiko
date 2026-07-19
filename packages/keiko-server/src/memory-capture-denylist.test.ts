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

  it("accepts a reviewed deployment replacement without changing the shared scanner", () => {
    const memoryDeniedCategoryMatchers = [
      { category: "deployment-specific", matchers: [/\brestricted fixture category\b/iu] },
    ];
    const policy = memoryCapturePolicyForDeps(deps({ memoryDeniedCategoryMatchers }));
    expect(
      memoryTextSecretEgressRejectionReason("A restricted fixture category is present.", policy),
    ).toBe("denied-category");
    expect(memoryTextSecretEgressRejectionReason("The medical record changed.", policy)).toBeNull();
  });
});
