import { describe, expect, it } from "vitest";
import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";

import type { UiHandlerDeps } from "../deps.js";
import {
  MAX_MODEL_ID_EVIDENCE_CHARS,
  modelIdEvidence,
  resolvedModelCapability,
} from "./model-id-evidence.js";

function provider(modelId: string): GatewayConfig["providers"][number] {
  return {
    modelId,
    baseUrl: "https://provider.example.invalid/v1",
    apiKey: "fake-test-key",
    timeoutMs: 5_000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
  };
}

function depsWithConfiguredProvider(modelId: string): UiHandlerDeps {
  return { config: { providers: [provider(modelId)] } } as unknown as UiHandlerDeps;
}

// #3557 review finding A: a request-supplied model id must never be logged as Activity Log
// evidence unless the effective capability source actually configures a model by that id.
describe("modelIdEvidence — the owning projection from a candidate model id to evidence", () => {
  it("never logs a caller-supplied value for a request model id no gateway configures", () => {
    // No gateway config at all: the built-in static registry ships empty by design, so this must
    // never leak a caller-chosen string through the "no config" fallback either.
    expect(modelIdEvidence({} as UiHandlerDeps, "patient-Alice-Jones")).toEqual({});
  });

  it("never logs a caller-supplied value the configured gateway does not name", () => {
    const deps = depsWithConfiguredProvider("breaker-chat");
    // "patient-Alice-Jones" is exactly the finding-A shape: a plausible, body-free-looking string
    // that is nonetheless unvalidated caller content and names no configured model.
    expect(modelIdEvidence(deps, "patient-Alice-Jones")).toEqual({});
  });

  it("logs a configured, opaque-shaped id as modelId unchanged", () => {
    const deps = depsWithConfiguredProvider("breaker-chat");
    expect(modelIdEvidence(deps, "breaker-chat")).toEqual({ modelId: "breaker-chat" });
  });

  it("falls back to a digest for a configured id that fails the opaque-id shape check", () => {
    // Follow-up finding: gateway config accepts any nonempty modelId, so an operator can configure
    // an email-shaped one. Logging it raw would fail `activityLogEvent`'s own opaque-id validation
    // and drop the WHOLE line; the digest keeps the line joinable without ever carrying the raw id.
    const deps = depsWithConfiguredProvider("alice@example.com");
    const evidence = modelIdEvidence(deps, "alice@example.com");
    expect(evidence.modelId).toBeUndefined();
    expect(evidence.modelIdDigest).toMatch(/^[a-f0-9]{16}$/);
    // Deterministic and never the raw value or a substring of it.
    expect(evidence.modelIdDigest).not.toContain("alice");
    expect(modelIdEvidence(deps, "alice@example.com")).toEqual(evidence);
  });

  // CodeRabbit boundary findings (chat-activity.test.ts:255): an empty candidate and the exact
  // 240-character bound, at the layer that now owns the decision.
  it("never logs an empty model id, even with a gateway configured", () => {
    const deps = depsWithConfiguredProvider("breaker-chat");
    expect(modelIdEvidence(deps, "")).toEqual({});
  });

  it("logs a configured id of exactly the 240-character bound unchanged", () => {
    const modelId = `model-${"x".repeat(MAX_MODEL_ID_EVIDENCE_CHARS - 6)}`;
    expect(modelId).toHaveLength(MAX_MODEL_ID_EVIDENCE_CHARS);
    const deps = depsWithConfiguredProvider(modelId);
    expect(modelIdEvidence(deps, modelId)).toEqual({ modelId });
  });

  it("bounds a configured id over the 240-character limit to exactly 240 characters", () => {
    const modelId = `model-${"x".repeat(300)}`;
    const deps = depsWithConfiguredProvider(modelId);
    expect(modelIdEvidence(deps, modelId)).toEqual({
      modelId: modelId.slice(0, MAX_MODEL_ID_EVIDENCE_CHARS),
    });
  });

  it("returns undefined for an unconfigured id and never throws", () => {
    expect(modelIdEvidence({} as UiHandlerDeps, undefined)).toEqual({});
  });
});

describe("resolvedModelCapability — the shared capability resolution", () => {
  it("resolves a configured model id to its capability", () => {
    const deps = depsWithConfiguredProvider("breaker-chat");
    expect(resolvedModelCapability(deps, "breaker-chat")?.id).toBe("breaker-chat");
  });

  it("resolves an unconfigured model id to undefined", () => {
    const deps = depsWithConfiguredProvider("breaker-chat");
    expect(resolvedModelCapability(deps, "not-configured")).toBeUndefined();
  });
});
