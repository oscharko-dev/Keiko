import { describe, expect, it } from "vitest";
import type { ModelCapability } from "@/lib/types";
import { isAgentWorkflowModel, directoryPickerError } from "./NewWindowDialog";
import { ApiError } from "@/lib/api";
import { WIN_TYPES } from "../windows/WindowsRegistry";

function model(patch: Partial<ModelCapability>): ModelCapability {
  return {
    id: "test-model",
    kind: "chat",
    contextWindow: 1,
    maxOutputTokens: 1,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test",
    preferredUseCases: [],
    knownLimitations: [],
    ...patch,
  };
}

describe("isAgentWorkflowModel", () => {
  it("allows only chat models with tool calling and structured output", () => {
    expect(isAgentWorkflowModel(model({ id: "example-chat-model" }))).toBe(true);
    expect(
      isAgentWorkflowModel(
        model({ id: "example-chat-model-unstructured", structuredOutput: false }),
      ),
    ).toBe(false);
    expect(isAgentWorkflowModel(model({ id: "basic-chat", toolCalling: false }))).toBe(false);
    expect(isAgentWorkflowModel(model({ id: "embedding", kind: "embedding" }))).toBe(false);
    expect(isAgentWorkflowModel(model({ id: "example-vision-model", kind: "ocr-vision" }))).toBe(
      false,
    );
  });
});

describe("chat window config", () => {
  it("does not expose a dead model field in the new-window dialog", () => {
    expect(WIN_TYPES.chat.config?.some((field) => field.key === "model")).toBe(false);
  });
});

// M2 (#532) — arbitrary-folder browse error mapping
describe("directoryPickerError", () => {
  it("returns an absolute-path prompt for a 400 BAD_ROOT error", () => {
    const err = new ApiError("BAD_ROOT", "relative path", 400);
    expect(directoryPickerError(err)).toBe("Enter an absolute folder path.");
  });

  it("returns an exclusion message for a 403 DENIED error", () => {
    const err = new ApiError("DENIED", "excluded", 403);
    expect(directoryPickerError(err)).toBe("That location is excluded.");
  });

  it("passes through the raw message for other ApiErrors", () => {
    const err = new ApiError("INTERNAL_ERROR", "something went wrong", 500);
    expect(directoryPickerError(err)).toBe("something went wrong");
  });

  it("passes through the message for plain Error objects", () => {
    expect(directoryPickerError(new Error("network timeout"))).toBe("network timeout");
  });

  it("returns a generic fallback for non-Error values", () => {
    expect(directoryPickerError("string error")).toBe("Unable to read directories.");
    expect(directoryPickerError(null)).toBe("Unable to read directories.");
  });
});
