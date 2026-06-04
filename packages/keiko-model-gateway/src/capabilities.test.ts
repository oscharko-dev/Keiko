import { describe, expect, it } from "vitest";
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
