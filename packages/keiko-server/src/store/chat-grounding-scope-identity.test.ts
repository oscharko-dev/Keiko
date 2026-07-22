import { describe, expect, it } from "vitest";
import {
  isGroundingScopeIdentity,
  type Chat,
  type ChatLocalKnowledgeScope,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { deriveChatGroundingScopeIdentity } from "./chat-grounding-scope-identity.js";

function chat(patch: Partial<Chat> = {}): Chat {
  return {
    id: "chat-1",
    projectPath: "/customer/repository",
    title: "Release",
    selectedModel: "chat-model",
    branchLabel: undefined,
    status: undefined,
    connectedScope: {
      kind: "directory",
      relativePaths: ["private/source"],
      root: "/customer/repository",
      connectedAtMs: 10,
    },
    localKnowledgeScope: undefined,
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  };
}

describe("deriveChatGroundingScopeIdentity", () => {
  it("is stable across non-scope updates and normalizes legacy open status", () => {
    const original = deriveChatGroundingScopeIdentity(chat());
    const updated = deriveChatGroundingScopeIdentity(
      chat({ title: "Renamed", selectedModel: "other-model", updatedAt: 999, status: "open" }),
    );

    expect(updated).toBe(original);
    expect(isGroundingScopeIdentity(original)).toBe(true);
  });

  it("changes for connected, local-knowledge, and closed-status revisions", () => {
    const original = deriveChatGroundingScopeIdentity(chat());
    const connected = deriveChatGroundingScopeIdentity(
      chat({
        connectedScope: {
          kind: "directory",
          relativePaths: ["different/source"],
          root: "/customer/repository",
          connectedAtMs: 11,
        },
      }),
    );
    const capsuleId = "capsule-sensitive-id" as Extract<
      ChatLocalKnowledgeScope,
      { readonly kind: "capsule" }
    >["capsuleId"];
    const local = deriveChatGroundingScopeIdentity(
      chat({ localKnowledgeScope: { kind: "capsule", capsuleId, connectedAtMs: 12 } }),
    );
    const closed = deriveChatGroundingScopeIdentity(chat({ status: "closed" }));

    expect(new Set([original, connected, local, closed]).size).toBe(4);
  });

  it("never exposes source paths or connector identities", () => {
    const token = deriveChatGroundingScopeIdentity(chat());

    expect(token).not.toContain("customer");
    expect(token).not.toContain("private");
    expect(token).toMatch(/^gsi-v1:[0-9a-f]{64}$/u);
  });
});
