import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import { describe, expect, it, vi } from "vitest";
import { qualifyLiveModel } from "./coding-issue-journey-live.js";

function chatModel(overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id: "qualified-chat",
    kind: "chat",
    contextWindow: 1_050_000,
    maxOutputTokens: 8_192,
    toolCalling: false,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "high",
    latencyClass: "slow",
    throughputHint: "qualification",
    preferredUseCases: ["coding"],
    knownLimitations: [],
    ...overrides,
  };
}

describe("live journey model qualification", () => {
  it("refreshes an expired tool-calling proof before rejecting the configured model", async () => {
    const loadModels = vi
      .fn<() => Promise<readonly ModelCapability[]>>()
      .mockResolvedValueOnce([chatModel()])
      .mockResolvedValueOnce([chatModel({ toolCalling: true })]);
    const refreshToolCalling = vi.fn<(modelId: string) => Promise<void>>();
    const enableWorkflow = vi.fn<(modelId: string) => Promise<void>>();

    await expect(
      qualifyLiveModel({ loadModels, refreshToolCalling, enableWorkflow }),
    ).resolves.toBe(true);

    expect(refreshToolCalling).toHaveBeenCalledExactlyOnceWith("qualified-chat");
    expect(loadModels).toHaveBeenCalledTimes(2);
    expect(enableWorkflow).not.toHaveBeenCalled();
  });

  it("does not probe a current workflow-eligible tool-calling model", async () => {
    const loadModels = vi.fn(() => Promise.resolve([chatModel({ toolCalling: true })]));
    const refreshToolCalling = vi.fn<(modelId: string) => Promise<void>>();
    const enableWorkflow = vi.fn<(modelId: string) => Promise<void>>();

    await expect(
      qualifyLiveModel({ loadModels, refreshToolCalling, enableWorkflow }),
    ).resolves.toBe(false);

    expect(refreshToolCalling).not.toHaveBeenCalled();
    expect(enableWorkflow).not.toHaveBeenCalled();
  });

  it("fails before a paid probe when the configured chat model is ambiguous", async () => {
    const loadModels = vi.fn(() => Promise.resolve([chatModel(), chatModel({ id: "other-chat" })]));
    const refreshToolCalling = vi.fn<(modelId: string) => Promise<void>>();
    const enableWorkflow = vi.fn<(modelId: string) => Promise<void>>();

    await expect(
      qualifyLiveModel({ loadModels, refreshToolCalling, enableWorkflow }),
    ).rejects.toThrow("one unambiguous chat model");

    expect(refreshToolCalling).not.toHaveBeenCalled();
    expect(enableWorkflow).not.toHaveBeenCalled();
  });

  it("does not enable workflow eligibility after a failed readiness refresh", async () => {
    const failure = new Error("readiness failed");
    const loadModels = vi.fn(() => Promise.resolve([chatModel()]));
    const refreshToolCalling = vi.fn(() => Promise.reject(failure));
    const enableWorkflow = vi.fn<(modelId: string) => Promise<void>>();

    await expect(qualifyLiveModel({ loadModels, refreshToolCalling, enableWorkflow })).rejects.toBe(
      failure,
    );

    expect(loadModels).toHaveBeenCalledExactlyOnceWith();
    expect(enableWorkflow).not.toHaveBeenCalled();
  });

  it("rejects a different model identity published after readiness", async () => {
    const loadModels = vi
      .fn<() => Promise<readonly ModelCapability[]>>()
      .mockResolvedValueOnce([chatModel()])
      .mockResolvedValueOnce([chatModel({ id: "replacement", toolCalling: true })]);
    const refreshToolCalling = vi.fn<(modelId: string) => Promise<void>>();
    const enableWorkflow = vi.fn<(modelId: string) => Promise<void>>();

    await expect(
      qualifyLiveModel({ loadModels, refreshToolCalling, enableWorkflow }),
    ).rejects.toThrow("refresh the selected model");

    expect(enableWorkflow).not.toHaveBeenCalled();
  });

  it("rejects a readiness response that does not publish tool-calling support", async () => {
    const loadModels = vi
      .fn<() => Promise<readonly ModelCapability[]>>()
      .mockResolvedValue([chatModel()]);
    const refreshToolCalling = vi.fn<(modelId: string) => Promise<void>>();
    const enableWorkflow = vi.fn<(modelId: string) => Promise<void>>();

    await expect(
      qualifyLiveModel({ loadModels, refreshToolCalling, enableWorkflow }),
    ).rejects.toThrow("publish the refreshed tool-calling proof");

    expect(enableWorkflow).not.toHaveBeenCalled();
  });
});
