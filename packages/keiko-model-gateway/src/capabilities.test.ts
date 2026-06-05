import { describe, expect, it } from "vitest";
import { CONVERSATION_CAPABILITY_CONTRACT_VERSION } from "@oscharko-dev/keiko-contracts";
import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import {
  CAPABILITY_REGISTRY,
  createDefaultChatCapability,
  findCapability,
  listCapabilities,
  resolveCostClass,
  selectCheapest,
} from "./capabilities.js";

describe("capability registry", () => {
  it("ships no deployment-specific built-in models", () => {
    expect(CAPABILITY_REGISTRY).toHaveLength(0);
    expect(listCapabilities()).toHaveLength(0);
  });

  it("creates generic local chat capabilities for runtime-configured models", () => {
    const cap = createDefaultChatCapability("example-chat-model");
    expect(cap).toMatchObject({
      id: "example-chat-model",
      kind: "chat",
      toolCalling: true,
      structuredOutput: true,
      costClass: "medium",
      latencyClass: "standard",
    });
  });

  // AC #2: unknown discovered chat models are usable for text but not image/document/workflow.
  it("defaults supportsImageInput to false for runtime-configured chat models", () => {
    const cap = createDefaultChatCapability("example-chat-model");
    expect(cap.supportsImageInput).toBe(false);
  });

  it("defaults supportsDocumentInput to false for runtime-configured chat models", () => {
    const cap = createDefaultChatCapability("example-chat-model");
    expect(cap.supportsDocumentInput).toBe(false);
  });

  it("defaults workflowEligible to false for runtime-configured chat models", () => {
    const cap = createDefaultChatCapability("example-chat-model");
    expect(cap.workflowEligible).toBe(false);
  });

  it("declares the default capability as kind 'chat'", () => {
    const cap = createDefaultChatCapability("example-chat-model");
    expect(cap.kind).toBe("chat");
  });
});

describe("findCapability over a registry seeded with a default chat capability", () => {
  it("returns supportsImageInput === false (AC #2 pin against the in-memory factory path)", () => {
    // Simulate the discovery path: a chat model id is encountered, the default
    // capability is materialised in-process, and a caller looks it up. The
    // conservative-default guarantee must hold end-to-end, not only inside the
    // factory.
    const factoryDefault = createDefaultChatCapability("example-chat-model");
    const registry: readonly ModelCapability[] = [factoryDefault];
    const found = registry.find((c) => c.id === "example-chat-model");
    expect(found?.supportsImageInput).toBe(false);
    expect(found?.supportsDocumentInput).toBe(false);
    expect(found?.workflowEligible).toBe(false);
  });
});

describe("CONVERSATION_CAPABILITY_CONTRACT_VERSION", () => {
  it("is pinned to 2 (bumped from the implicit v1 by Conversation Center fields)", () => {
    expect(CONVERSATION_CAPABILITY_CONTRACT_VERSION).toBe(2);
  });
});

describe("findCapability", () => {
  it("returns undefined for runtime-configured ids", () => {
    expect(findCapability("example-chat-model")).toBeUndefined();
  });
});

describe("listCapabilities", () => {
  it("returns a snapshot of every registered model", () => {
    expect(listCapabilities().map((c) => c.id)).toEqual(CAPABILITY_REGISTRY.map((c) => c.id));
  });
});

describe("selectCheapest", () => {
  it("returns undefined when no built-in capability satisfies the requirements", () => {
    expect(selectCheapest({ kind: "chat", toolCalling: true })).toBeUndefined();
  });
});

describe("resolveCostClass", () => {
  it("returns 'unknown' for runtime-configured / unregistered model ids", () => {
    expect(resolveCostClass("example-chat-model")).toBe("unknown");
    expect(resolveCostClass("")).toBe("unknown");
  });
});
