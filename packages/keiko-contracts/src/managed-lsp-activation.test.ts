import { describe, expect, it } from "vitest";

import {
  MANAGED_LSP_ACTIVATION_REASON_CODES,
  MANAGED_LSP_ACTIVATION_SCHEMA_VERSION,
  MANAGED_LSP_EFFECTIVE_STATES,
  MANAGED_LSP_LANGUAGES,
  type ManagedLspActivationInput,
  parseManagedLspActivationStatus,
  resolveManagedLspActivation,
} from "./managed-lsp-activation.js";

function activeInput(): ManagedLspActivationInput {
  return {
    schemaVersion: MANAGED_LSP_ACTIVATION_SCHEMA_VERSION,
    language: "python",
    configurationRevision: 7,
    productSupport: "supported",
    deploymentPolicy: "allowed",
    provisioning: "provisioned",
    workspaceActivation: "enabled",
    legacyEnvironment: "unset",
    negotiation: "negotiated",
    runtimeHealth: "healthy",
    restartRequired: false,
    workspaceTrust: "trusted",
  };
}

function resolvedState(input: unknown): string {
  return resolveManagedLspActivation(input).state;
}

describe("managed LSP activation vocabulary", () => {
  it("pins frozen, closed language, state, and reason tables", () => {
    expect(MANAGED_LSP_ACTIVATION_SCHEMA_VERSION).toBe("1");
    expect(MANAGED_LSP_LANGUAGES).toStrictEqual(["python", "go", "shell", "java", "rust"]);
    expect(MANAGED_LSP_EFFECTIVE_STATES).toStrictEqual([
      "disabled",
      "disabledByPolicy",
      "notProvisioned",
      "available",
      "starting",
      "active",
      "degraded",
      "unhealthy",
      "restartRequired",
    ]);
    expect(MANAGED_LSP_ACTIVATION_REASON_CODES).toContain("INVALID_INPUT");
    expect(MANAGED_LSP_ACTIVATION_REASON_CODES).toContain("STATE_UNAVAILABLE");
    expect(MANAGED_LSP_ACTIVATION_REASON_CODES).toContain("WORKSPACE_UNTRUSTED");
    expect(Object.isFrozen(MANAGED_LSP_LANGUAGES)).toBe(true);
    expect(Object.isFrozen(MANAGED_LSP_EFFECTIVE_STATES)).toBe(true);
    expect(Object.isFrozen(MANAGED_LSP_ACTIVATION_REASON_CODES)).toBe(true);
  });
});

describe("resolveManagedLspActivation", () => {
  it("resolves the healthy negotiated baseline to active", () => {
    expect(resolveManagedLspActivation(activeInput())).toStrictEqual({
      ok: true,
      schemaVersion: "1",
      language: "python",
      configurationRevision: 7,
      state: "active",
      reasonCode: "ACTIVE",
      policyResult: "allowed",
    });
  });

  it("fails closed with a typed reason when workspace trust is restricted or absent", () => {
    for (const input of [
      { ...activeInput(), workspaceTrust: "restricted" as const },
      Object.fromEntries(Object.entries(activeInput()).filter(([key]) => key !== "workspaceTrust")),
    ]) {
      expect(resolveManagedLspActivation(input)).toMatchObject({
        ok: true,
        state: "disabledByPolicy",
        reasonCode: "WORKSPACE_UNTRUSTED",
        policyResult: "denied",
      });
    }
  });

  it.each([
    ["product support", { productSupport: "unsupported" }, "disabled"],
    ["deployment policy", { deploymentPolicy: "denied" }, "disabledByPolicy"],
    ["legacy deployment ceiling", { legacyEnvironment: "disabled" }, "disabledByPolicy"],
    ["provisioning", { provisioning: "notProvisioned" }, "notProvisioned"],
    ["workspace setting", { workspaceActivation: "disabled" }, "disabled"],
    ["unset workspace setting", { workspaceActivation: "unset" }, "disabled"],
    ["not started", { negotiation: "notStarted" }, "available"],
    ["startup", { negotiation: "starting" }, "starting"],
    ["missing negotiated capability", { negotiation: "requiredCapabilityMissing" }, "degraded"],
    ["unknown health", { runtimeHealth: "unknown" }, "degraded"],
    ["degraded health", { runtimeHealth: "degraded" }, "degraded"],
    ["unhealthy runtime", { runtimeHealth: "unhealthy" }, "unhealthy"],
    ["pending restart", { restartRequired: true }, "restartRequired"],
    ["canonical state unavailable", { canonicalState: "unavailable" }, "disabled"],
    ["canonical state rejected", { canonicalState: "rejected" }, "disabled"],
  ] as const)("downgrades active for %s", (_label, change, expected) => {
    expect(resolvedState({ ...activeInput(), ...change })).toBe(expected);
  });

  it.each(["unavailable", "rejected"] as const)(
    "resolves canonical state %s to disabled/STATE_UNAVAILABLE",
    (canonicalState) => {
      expect(resolveManagedLspActivation({ ...activeInput(), canonicalState })).toMatchObject({
        state: "disabled",
        reasonCode: "STATE_UNAVAILABLE",
        policyResult: "denied",
      });
    },
  );

  it("prioritizes product-unsupported (order 1) over canonical-state-unavailable (order 1a)", () => {
    expect(
      resolveManagedLspActivation({
        ...activeInput(),
        productSupport: "unsupported",
        canonicalState: "unavailable",
      }),
    ).toMatchObject({ state: "disabled", reasonCode: "PRODUCT_UNSUPPORTED" });
  });

  it("prioritizes canonical-state-unavailable (order 1a) over policy denial (order 2)", () => {
    expect(
      resolveManagedLspActivation({
        ...activeInput(),
        canonicalState: "rejected",
        deploymentPolicy: "denied",
      }),
    ).toMatchObject({ state: "disabled", reasonCode: "STATE_UNAVAILABLE" });
  });

  it.each(["allowed", "denied"] as const)(
    "does not let legacy enablement or workspace settings widen %s policy",
    (deploymentPolicy) => {
      for (const workspaceActivation of ["unset", "disabled", "enabled"] as const) {
        for (const legacyEnvironment of ["unset", "disabled", "enabled"] as const) {
          const state = resolvedState({
            ...activeInput(),
            deploymentPolicy,
            workspaceActivation,
            legacyEnvironment,
          });
          const expected =
            deploymentPolicy === "denied" || legacyEnvironment === "disabled"
              ? "disabledByPolicy"
              : workspaceActivation === "enabled"
                ? "active"
                : "disabled";
          expect(state).toBe(expected);
        }
      }
    },
  );

  it("applies precedence deterministically from product support through health", () => {
    expect(
      resolveManagedLspActivation({
        ...activeInput(),
        productSupport: "unsupported",
        deploymentPolicy: "denied",
        provisioning: "notProvisioned",
        workspaceActivation: "disabled",
        runtimeHealth: "unhealthy",
      }),
    ).toMatchObject({ state: "disabled", reasonCode: "PRODUCT_UNSUPPORTED" });
    expect(
      resolveManagedLspActivation({
        ...activeInput(),
        deploymentPolicy: "denied",
        provisioning: "notProvisioned",
        workspaceActivation: "disabled",
      }),
    ).toMatchObject({ state: "disabledByPolicy", reasonCode: "POLICY_DENIED" });
  });

  it.each([
    null,
    {},
    { ...activeInput(), schemaVersion: "2" },
    { ...activeInput(), deploymentPolicy: "admin-override" },
    { ...activeInput(), workspaceTrust: "operator-approved" },
    { ...activeInput(), workspaceActivation: "enabled", extra: true },
    { ...activeInput(), canonicalState: "missing" },
  ])("fails closed for malformed, unknown, or schema-skewed input", (input) => {
    expect(resolveManagedLspActivation(input)).toStrictEqual({
      ok: false,
      state: "disabled",
      reasonCode: "INVALID_INPUT",
      policyResult: "denied",
    });
  });

  it("never throws when hostile property access fails", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error("hostile ownKeys");
        },
      },
    );
    expect(() => resolveManagedLspActivation(hostile)).not.toThrow();
    expect(resolvedState(hostile)).toBe("disabled");
  });
});

describe("parseManagedLspActivationStatus", () => {
  it("accepts the content-free effective status and rejects extra content fields", () => {
    const status = resolveManagedLspActivation(activeInput());
    expect(parseManagedLspActivationStatus(status).ok).toBe(true);
    for (const field of ["path", "env", "source", "stderr", "command", "credential"]) {
      expect(parseManagedLspActivationStatus({ ...status, [field]: "SENTINEL_SECRET" }).ok).toBe(
        false,
      );
    }
  });

  it.each([
    ["active with denied policy", { policyResult: "denied" }],
    ["ACTIVE reason on disabled", { state: "disabled", reasonCode: "ACTIVE" }],
    ["policy reason without policy state", { state: "active", reasonCode: "POLICY_DENIED" }],
    ["healthy reason on unhealthy", { state: "unhealthy", reasonCode: "ACTIVE" }],
  ])("rejects internally inconsistent status: %s", (_label, change) => {
    const status = resolveManagedLspActivation(activeInput());
    expect(parseManagedLspActivationStatus({ ...status, ...change }).ok).toBe(false);
  });

  it("keeps SQL outside the exact five-language managed scope", () => {
    expect(resolveManagedLspActivation({ ...activeInput(), language: "sql" })).toStrictEqual({
      ok: false,
      state: "disabled",
      reasonCode: "INVALID_INPUT",
      policyResult: "denied",
    });
  });
});

import { parseManagedLspActivationInput } from "./managed-lsp-activation.js";
import * as activationPublic from "@oscharko-dev/keiko-contracts/runtime/managed-lsp-activation";

function observedActivationField(
  value: object,
  field: string,
  values: readonly unknown[],
): () => number {
  let reads = 0;
  Object.defineProperty(value, field, {
    enumerable: true,
    get: (): unknown => values[Math.min(reads++, values.length - 1)],
  });
  return (): number => reads;
}

describe("3918 managed activation concrete construction observations", () => {
  for (const [surface, parseInput, parseStatus] of [
    ["source", parseManagedLspActivationInput, parseManagedLspActivationStatus],
    [
      "public",
      activationPublic.parseManagedLspActivationInput,
      activationPublic.parseManagedLspActivationStatus,
    ],
  ] as const) {
    it.each([
      ["language", "python", "unsupported"],
      ["configurationRevision", 7, Number.NaN],
      ["productSupport", "supported", "unsupported-value"],
      ["deploymentPolicy", "allowed", "unsupported-value"],
      ["provisioning", "provisioned", "unsupported-value"],
      ["workspaceActivation", "enabled", "unsupported-value"],
      ["legacyEnvironment", "unset", "unsupported-value"],
      ["negotiation", "negotiated", "unsupported-value"],
      ["runtimeHealth", "healthy", "unsupported-value"],
      ["restartRequired", false, "false"],
    ] as const)(`${surface} refuses invalid copied %s`, (field, initial, final) => {
      const value = activeInput();
      const reads = observedActivationField(value, field, [initial, final]);
      expect(parseInput(value)).toEqual({
        ok: false,
        errors: ["activation input is invalid or contains unknown fields"],
      });
      expect(reads()).toBe(2);
    });
    it.each([
      ["workspaceTrust", "trusted", "unsupported-value"],
      ["canonicalState", "available", "unsupported-value"],
      ["canonicalState", "available", undefined],
    ] as const)(`${surface} admits the actual optional %s copy`, (field, initial, final) => {
      const value = activeInput();
      const reads = observedActivationField(value, field, [initial, initial, initial, final]);
      expect(parseInput(value)).toEqual({
        ok: false,
        errors: ["activation input is invalid or contains unknown fields"],
      });
      expect(reads()).toBe(4);
    });
    it(`${surface} preserves valid copied observations and optional omission`, () => {
      const value = activeInput();
      const reads = observedActivationField(value, "configurationRevision", [7, 8]);
      const result = parseInput(value);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("healthy copied activation was refused");
      expect(result.value.configurationRevision).toBe(8);
      expect(reads()).toBe(2);
      const omitted = parseInput({ ...activeInput(), canonicalState: undefined });
      expect(omitted.ok).toBe(true);
      if (!omitted.ok) throw new Error("healthy optional omission was refused");
      expect(Object.hasOwn(omitted.value, "canonicalState")).toBe(false);
    });
    it(`${surface} refuses a wrong primitive at the consistency policy observation`, () => {
      const value = resolveManagedLspActivation(activeInput());
      const reads = observedActivationField(value, "policyResult", ["allowed", {}]);
      expect(parseStatus(value)).toEqual({
        ok: false,
        errors: ["activation status is invalid or contains unknown fields"],
      });
      expect(reads()).toBe(2);
    });
    it(`${surface} preserves independent closed policy observations`, () => {
      const value = resolveManagedLspActivation(activeInput());
      const reads = observedActivationField(value, "policyResult", ["denied", "allowed"]);
      expect(parseStatus(value).ok).toBe(true);
      expect(reads()).toBe(2);
    });
    it(`${surface} preserves the inspection error class for an invalid second state`, () => {
      const value = resolveManagedLspActivation(activeInput());
      const reads = observedActivationField(value, "state", ["active", "unsupported"]);
      expect(parseStatus(value)).toEqual({
        ok: false,
        errors: ["payload could not be inspected: TypeError"],
      });
      expect(reads()).toBe(2);
    });
  }
});

for (const surface of ["source", "public"] as const) {
  it(`${surface}: preserves protocol key enumeration before closed-field refusal`, async () => {
    const module =
      surface === "source"
        ? await import("./managed-lsp-activation.js")
        : await import("@oscharko-dev/keiko-contracts/runtime/managed-lsp-activation");
    const trace: string[] = [];
    const value = new Proxy(
      {},
      {
        ownKeys(): string[] {
          trace.push("ownKeys");
          return ["unexpected", "schemaVersion"];
        },
        getOwnPropertyDescriptor(_target, key): PropertyDescriptor {
          trace.push(`descriptor:${String(key)}`);
          return { configurable: true, enumerable: true, value: undefined, writable: true };
        },
        get(_target, key): never {
          trace.push(`get:${String(key)}`);
          throw new TypeError("Protocol field inspection after key enumeration");
        },
      },
    );
    expect(module.parseManagedLspActivationInput(value)).toEqual({
      ok: false,
      errors: ["payload could not be inspected: TypeError"],
    });
    expect(trace).toEqual([
      "ownKeys",
      "descriptor:unexpected",
      "descriptor:schemaVersion",
      "get:schemaVersion",
    ]);
  });

  it(`${surface}: retains ignored symbol and non-enumerable protocol metadata`, async () => {
    const module =
      surface === "source"
        ? await import("./managed-lsp-activation.js")
        : await import("@oscharko-dev/keiko-contracts/runtime/managed-lsp-activation");
    const value = activeInput();
    let reads = 0;
    const inspect = (): never => {
      reads += 1;
      throw new TypeError("Ignored metadata was read");
    };
    Object.defineProperty(value, "ignoredMetadata", { enumerable: false, get: inspect });
    Object.defineProperty(value, Symbol("ignoredMetadata"), { enumerable: true, get: inspect });
    expect(module.parseManagedLspActivationInput(value).ok).toBe(true);
    expect(reads).toBe(0);
  });

  it(`${surface}: rejects a non-string protocol vocabulary member without coercion`, async () => {
    const module =
      surface === "source"
        ? await import("./managed-lsp-activation.js")
        : await import("@oscharko-dev/keiko-contracts/runtime/managed-lsp-activation");
    let coercions = 0;
    const foreign = {
      toString: (): never => {
        coercions += 1;
        throw new TypeError("Protocol enum coercion");
      },
    };
    const value = { ...activeInput(), language: foreign };
    expect(module.parseManagedLspActivationInput(value)).toEqual({
      ok: false,
      errors: ["activation input is invalid or contains unknown fields"],
    });
    expect(coercions).toBe(0);
  });
}
