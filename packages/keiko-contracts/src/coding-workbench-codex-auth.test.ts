import { describe, expect, it } from "vitest";

import {
  CODING_WORKBENCH_SCHEMA_VERSION,
  type CodingWorkbenchModelSource,
} from "./coding-workbench.js";
import {
  buildCodingWorkbenchRuntimeProfile,
  CODEX_REDISTRIBUTION_APPROVED,
  deriveCodexRuntimeAuthorization,
  selectCodingWorkbenchRuntimeProfile,
} from "./coding-workbench-codex-auth.js";

// KEIKO-0708 / #3321: selectCodingWorkbenchRuntimeProfile used to return
// codexSubscriptionAllowed: false and runtimeBinarySources: [] as bare literals for the Codex
// model source, with nothing at the point of the decision saying why. This suite pins the
// decision to the named CODEX_REDISTRIBUTION_APPROVED kill switch and its derivation,
// deriveCodexRuntimeAuthorization: both fields must come from that derivation, never
// hand-written literals that could silently drift from the constant.
describe("deriveCodexRuntimeAuthorization", () => {
  // Direct coverage of every (codex, approved) combination. This is the test that actually
  // exercises the derivation logic both ways -- unlike asserting against the module constant
  // (which is always false today and so can never observe the "approved" branch), driving
  // `approved` as an explicit parameter fails if the production code reverts to bare literals,
  // and fails if it reverts to deriving from `approved` alone without also gating on `codex`.
  it("requires BOTH codex and approved to authorize Codex runtime binaries", () => {
    expect(deriveCodexRuntimeAuthorization(false, false)).toEqual({
      codexSubscriptionAllowed: false,
      runtimeBinarySources: [],
    });
    expect(deriveCodexRuntimeAuthorization(true, false)).toEqual({
      codexSubscriptionAllowed: false,
      runtimeBinarySources: [],
    });
    expect(deriveCodexRuntimeAuthorization(true, true)).toEqual({
      codexSubscriptionAllowed: true,
      runtimeBinarySources: ["managed-sidecar-runtime"],
    });
  });

  // The regression this suite exists to prevent: a non-Codex model source (codex: false) must
  // never report codexSubscriptionAllowed: true or carry Codex runtime binary sources, even if
  // redistribution approval is later granted (approved: true). Before this fix, the unconditional
  // `codexSubscriptionAllowed: CODEX_REDISTRIBUTION_APPROVED` would have made this contradiction
  // real the moment the constant flipped to true.
  it("stays unauthorized for a non-Codex model source even when redistribution is approved", () => {
    expect(deriveCodexRuntimeAuthorization(false, true)).toEqual({
      codexSubscriptionAllowed: false,
      runtimeBinarySources: [],
    });
  });
});

describe("selectCodingWorkbenchRuntimeProfile", () => {
  it("keeps the named redistribution kill switch at its documented unapproved default", () => {
    expect(CODEX_REDISTRIBUTION_APPROVED).toBe(false);
  });

  // KEIKO-0708 / #3321 finding 2: asserting selectCodingWorkbenchRuntimeProfile's output against
  // deriveCodexRuntimeAuthorization(true, CODEX_REDISTRIBUTION_APPROVED) is tautological -- with
  // the constant pinned false today, both sides collapse to {false, []} even if the wrapper
  // reverted to hand-written bare literals instead of calling the derivation. Driving
  // buildCodingWorkbenchRuntimeProfile's own `approved` parameter directly, and asserting a
  // literal expected value (not one recomputed from the same production function), actually
  // exercises the wrapper's derivation logic rather than only the already-covered
  // deriveCodexRuntimeAuthorization helper.
  it("derives codexSubscriptionAllowed and runtimeBinarySources from the approved parameter, not bare literals", () => {
    expect(buildCodingWorkbenchRuntimeProfile("chatgpt-codex-subscription-profile", true)).toEqual({
      schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
      modelSource: "chatgpt-codex-subscription-profile",
      runtimeSource: "codex-cli-adapter",
      adapterKind: "codex-cli-adapter",
      sidecarGatewayAllowed: false,
      codexSubscriptionAllowed: true,
      runtimeBinarySources: ["managed-sidecar-runtime"],
    });

    expect(
      buildCodingWorkbenchRuntimeProfile(
        "chatgpt-codex-subscription-profile",
        CODEX_REDISTRIBUTION_APPROVED,
      ),
    ).toEqual(selectCodingWorkbenchRuntimeProfile("chatgpt-codex-subscription-profile"));
  });

  it("selects the Codex adapter for subscription profiles, gated by the redistribution kill switch", () => {
    expect(selectCodingWorkbenchRuntimeProfile("chatgpt-codex-subscription-profile")).toEqual({
      schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
      modelSource: "chatgpt-codex-subscription-profile",
      runtimeSource: "codex-cli-adapter",
      adapterKind: "codex-cli-adapter",
      sidecarGatewayAllowed: false,
      codexSubscriptionAllowed: false,
      runtimeBinarySources: [],
    });
  });

  it("selects the sidecar adapter for gateway model sources, which the Codex kill switch can never authorize", () => {
    const gatewayModelSources: readonly CodingWorkbenchModelSource[] = [
      "keiko-model-gateway",
      "openai-api-key-through-gateway",
    ];
    for (const modelSource of gatewayModelSources) {
      expect(selectCodingWorkbenchRuntimeProfile(modelSource)).toEqual({
        schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
        modelSource,
        runtimeSource: "keiko-sidecar",
        adapterKind: "model-gateway-sidecar",
        sidecarGatewayAllowed: true,
        codexSubscriptionAllowed: false,
        runtimeBinarySources: [],
      });

      // Pins finding 1's regression directly at the public API: even if
      // CODEX_REDISTRIBUTION_APPROVED were true, a gateway model source is not Codex and must
      // never report itself authorized for Codex runtime binaries.
      expect(
        deriveCodexRuntimeAuthorization(modelSource === "chatgpt-codex-subscription-profile", true),
      ).toEqual({
        codexSubscriptionAllowed: false,
        runtimeBinarySources: [],
      });
    }
  });
});

function c1bCoverageProfile(): Record<string, unknown> {
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    profileId: "codex-subscription",
    modelSource: "chatgpt-codex-subscription-profile",
    runtimeSource: "codex-cli-adapter",
    status: "connected",
    authMethod: "chatgpt-device-code",
    credentialStore: "keyring",
    stateScope: "os-credential-store",
    stateRoot: "os-credential-store",
    usesGlobalCodexHome: false,
    runtimeBinarySources: ["managed-sidecar-runtime"],
    supportsBrowserLogin: true,
    supportsDeviceCode: true,
    supportsAccessToken: true,
    deploymentPolicyDisabled: false,
    headless: false,
  };
}

describe("C1B Codex primitive refusal coverage", () => {
  it.each(["source", "public"] as const)(
    "preserves healthy profile reference through %s",
    async (seam) => {
      const module =
        seam === "source"
          ? await import("./coding-workbench-codex-auth.js")
          : await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-codex-auth");
      const input = c1bCoverageProfile();
      expect(module.validateCodingWorkbenchCodexSubscriptionProfile(input)).toEqual({
        ok: true,
        value: input,
      });
    },
  );
  it.each([
    "schemaVersion",
    "modelSource",
    "runtimeSource",
    "status",
    "profileId",
    "authMethod",
    "credentialStore",
    "stateScope",
    "stateRoot",
    "usesGlobalCodexHome",
    "supportsBrowserLogin",
    "supportsDeviceCode",
    "supportsAccessToken",
    "deploymentPolicyDisabled",
    "headless",
  ])("rejects malformed profile %s without hiding later diagnostics", async (field) => {
    const module = await import("./coding-workbench-codex-auth.js");
    const input = { ...c1bCoverageProfile(), [field]: 7 };
    const result = module.validateCodingWorkbenchCodexSubscriptionProfile(input);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("malformed profile admitted");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(field);
  });
  it("keeps malformed binary members and later Boolean diagnostics eager", async () => {
    const module = await import("./coding-workbench-codex-auth.js");
    const result = module.validateCodingWorkbenchCodexSubscriptionProfile({
      ...c1bCoverageProfile(),
      runtimeBinarySources: [7, "invalid"],
      headless: 7,
      extra: true,
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        "profile.extra is not allowed",
        "profile.runtimeBinarySources[0] is invalid",
        "profile.runtimeBinarySources[1] is invalid",
        "profile.headless must be a boolean",
      ],
    });
  });
  it.each([null, { method: "invalid" }, { method: "chatgpt-device-code", extra: true }])(
    "refuses malformed setup request %j",
    async (input) => {
      const module = await import("./coding-workbench-codex-auth.js");
      expect(module.validateCodingWorkbenchCodexAuthSetupRequest(input).ok).toBe(false);
    },
  );
  it.each([
    "schemaVersion",
    "profileId",
    "method",
    "modelSource",
    "runtimeSource",
    "credentialStore",
    "stateScope",
    "stateRoot",
    "usesGlobalCodexHome",
    "commandLabel",
    "requiresSecretInput",
    "credentialTransport",
  ])("refuses malformed setup plan %s", async (field) => {
    const module = await import("./coding-workbench-codex-auth.js");
    const input = {
      schemaVersion: "1",
      profileId: "codex-subscription",
      method: "codex-access-token",
      modelSource: "chatgpt-codex-subscription-profile",
      runtimeSource: "codex-cli-adapter",
      credentialStore: "keyring",
      stateScope: "os-credential-store",
      stateRoot: "os-credential-store",
      usesGlobalCodexHome: false,
      ...module.codingWorkbenchCodexAuthMethodRowFor("codex-access-token"),
    };
    expect(module.validateCodingWorkbenchCodexAuthSetupPlan(input).ok).toBe(true);
    const result = module.validateCodingWorkbenchCodexAuthSetupPlan({ ...input, [field]: 7 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("malformed setup plan admitted");
    expect(result.errors.some((error) => error.includes(field))).toBe(true);
  });
  it.each([
    "validateCodingWorkbenchCodexSubscriptionProfile",
    "validateCodingWorkbenchCodexAuthSetupPlan",
  ] as const)("refuses non-object at %s", async (name) => {
    const module = await import("./coding-workbench-codex-auth.js");
    expect(module[name](null).ok).toBe(false);
  });
});
