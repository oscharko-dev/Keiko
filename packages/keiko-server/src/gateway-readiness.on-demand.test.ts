import { describe, expect, it, vi } from "vitest";
import { UNVERIFIED_GATEWAY } from "@oscharko-dev/keiko-contracts";
import { ensureOnDemandConversationReadiness } from "./gateway-readiness.js";
import type { UiHandlerDeps } from "./deps.js";

// Focused branch pins for the fresh-install on-demand verification: the field twin covers the
// journey; these cover the guards that must NOT probe.

function holderWith(
  observation: ReturnType<NonNullable<UiHandlerDeps["gatewayConfig"]>["verifiedCapability"]>,
  generation = 3,
): NonNullable<UiHandlerDeps["gatewayConfig"]> {
  return {
    storagePath: "/dev/null",
    current: () => undefined,
    present: () => true,
    set: () => undefined,
    verification: () => UNVERIFIED_GATEWAY,
    generation: () => generation,
    recordVerification: () => undefined,
    verifiedCapability: () => observation,
    recordVerifiedCapability: () => undefined,
    clearVerifiedCapability: () => false,
  };
}

describe("ensureOnDemandConversationReadiness guards", () => {
  it("returns without probing when no gateway is configured", async () => {
    await expect(
      ensureOnDemandConversationReadiness({} as UiHandlerDeps, "chat-model"),
    ).resolves.toBeUndefined();
  });

  it("returns without probing for an empty model id", async () => {
    const deps = { gatewayConfig: holderWith(undefined) } as unknown as UiHandlerDeps;
    await expect(ensureOnDemandConversationReadiness(deps, "")).resolves.toBeUndefined();
  });

  it("returns without probing when the model is already conversation-ready", async () => {
    const deps = {
      gatewayConfig: holderWith({
        modelId: "chat-model",
        generation: 3,
        checkedAt: "2026-08-19T00:00:00.000Z",
        fields: { conversationReady: true },
      }),
    } as unknown as UiHandlerDeps;
    await expect(ensureOnDemandConversationReadiness(deps, "chat-model")).resolves.toBeUndefined();
  });

  it("respects an observed not-ready at the current generation without re-probing", async () => {
    const verifiedCapability = vi.fn(() => ({
      modelId: "chat-model",
      generation: 3,
      checkedAt: "2026-08-19T00:00:00.000Z",
      fields: { conversationReady: false },
    }));
    const deps = {
      gatewayConfig: { ...holderWith(undefined), verifiedCapability },
    } as unknown as UiHandlerDeps;
    // currentGatewayConfig(deps) is undefined here, so a probe attempt would throw inside
    // runGatewayReadiness's provider selection — resolving cleanly proves the guard returned
    // BEFORE any probing.
    await expect(ensureOnDemandConversationReadiness(deps, "chat-model")).resolves.toBeUndefined();
  });
});
