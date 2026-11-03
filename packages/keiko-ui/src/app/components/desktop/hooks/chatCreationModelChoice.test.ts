import { describe, expect, it } from "vitest";
import {
  chatCreationModelChoiceOf,
  chatCreationModelConfig,
  isPersistableChatCreationModelId,
} from "./chatCreationModelChoice";

describe("pending Chat model choice", (): void => {
  it("keeps legacy absence distinct from an explicit automatic snapshot", (): void => {
    expect(chatCreationModelChoiceOf({})).toBeUndefined();
    expect(chatCreationModelConfig(undefined)).toEqual({});
    expect(chatCreationModelChoiceOf(chatCreationModelConfig({ kind: "automatic" }))).toEqual({
      kind: "automatic",
    });
  });

  it("preserves the exact explicit model reference at its persisted boundary", (): void => {
    const choice = { kind: "explicit", modelId: "local/model-original:release" } as const;
    expect(chatCreationModelChoiceOf(chatCreationModelConfig(choice))).toEqual(choice);
    expect(isPersistableChatCreationModelId("m".repeat(2_048))).toBe(true);
  });

  it.each([
    { newChatModelSelection: "unavailable" },
    { newChatModelSelection: "unknown" },
    { newChatModelSelection: true },
    { newChatModelSelection: "explicit" },
    { newChatModelSelection: "explicit", newChatModelId: "" },
    { newChatModelSelection: "explicit", newChatModelId: "   " },
    { newChatModelSelection: "explicit", newChatModelId: "m".repeat(2_049) },
    { newChatModelSelection: "explicit", newChatModelId: true },
    { newChatModelSelection: "explicit", newChatModelId: `ghp_${"A".repeat(36)}` },
    { newChatModelSelection: "automatic", newChatModelId: "another-model" },
    { newChatModelId: "unowned-model" },
  ])("refuses an incomplete or unsafe new snapshot (%j)", (cfg): void => {
    expect(chatCreationModelChoiceOf(cfg)).toBeNull();
  });
});
