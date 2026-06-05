// Issue #144 / Epic #142: SettingsPanel surfaces conversation eligibility.
// These tests pin AC #3 ("The UI can explain why a model is unavailable for a
// capability without showing provider URLs or credentials") by asserting:
//   - the eligible badge renders for chat models;
//   - the reason text renders for embedding / ocr-vision models;
//   - the rendered markup contains no host-name pattern or credential-shape
//     literal (the no-leak invariant).

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelCapability } from "@/lib/types";
import { SettingsPanel } from "./SettingsPanel";

const fetchConfigMock = vi.fn();
const fetchModelsMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchConfig: (): Promise<unknown> => fetchConfigMock(),
  fetchModels: (): Promise<unknown> => fetchModelsMock(),
}));

// Issue #144: synthetic capability fixtures. Generic ids only — no customer
// model names. ModelCapability has no URL / api-key field by design; the
// no-leak assertion below pins that nothing in the rendered markup contains a
// host-name pattern or a credential-shape literal.
function chatCapability(id = "test-chat-1"): ModelCapability {
  return {
    id,
    kind: "chat",
    contextWindow: 0,
    maxOutputTokens: 0,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test fixture",
    preferredUseCases: ["Chat"],
    knownLimitations: ["test fixture"],
  };
}

function embeddingCapability(id = "test-embed-1"): ModelCapability {
  return {
    id,
    kind: "embedding",
    contextWindow: 0,
    maxOutputTokens: 0,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "low",
    latencyClass: "fast",
    throughputHint: "test fixture",
    preferredUseCases: ["Embeddings"],
    knownLimitations: ["test fixture"],
  };
}

function ocrVisionCapability(id = "test-ocr-1"): ModelCapability {
  return {
    id,
    kind: "ocr-vision",
    contextWindow: 0,
    maxOutputTokens: 0,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    supportsImageInput: true,
    supportsDocumentInput: true,
    workflowEligible: false,
    costClass: "low",
    latencyClass: "standard",
    throughputHint: "test fixture",
    preferredUseCases: ["OCR"],
    knownLimitations: ["test fixture"],
  };
}

function primeFetches(models: readonly ModelCapability[]): void {
  fetchConfigMock.mockResolvedValue({ config: null, configPresent: true });
  fetchModelsMock.mockResolvedValue({ models });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("SettingsPanel conversation eligibility badge (Issue #144 AC #3)", () => {
  it("renders the 'Conversation-eligible' badge for a chat capability", async () => {
    primeFetches([chatCapability("test-chat-1")]);
    render(<SettingsPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("conv-elig-ok")).toHaveTextContent(/conversation-eligible/i);
    });
  });

  it("renders the embedding reason for an embedding capability", async () => {
    primeFetches([embeddingCapability("test-embed-1")]);
    render(<SettingsPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("conv-elig-no")).toHaveTextContent(/embedding model/i);
    });
    expect(screen.getByTestId("conv-elig-no")).toHaveTextContent(/not selectable/i);
  });

  it("renders the OCR/vision-only reason for an ocr-vision capability", async () => {
    primeFetches([ocrVisionCapability("test-ocr-1")]);
    render(<SettingsPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("conv-elig-no")).toHaveTextContent(/ocr\/vision-only/i);
    });
  });

  it("marks intentionally ineligible models with an ineligible status tone", async () => {
    primeFetches([embeddingCapability("test-embed-1")]);
    const { container } = render(<SettingsPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("conv-elig-no")).toBeInTheDocument();
    });
    const status = container.querySelector('.ml-status[title="not selectable for conversation"]');
    expect(status).not.toBeNull();
    expect(status?.className).toContain("ineligible");
  });
});

describe("SettingsPanel chat-count uses the eligibility helper (Issue #144 AC #1)", () => {
  it("counts only chat-eligible capabilities, not embedding/ocr-vision", async () => {
    primeFetches([
      chatCapability("test-chat-1"),
      chatCapability("test-chat-2"),
      embeddingCapability("test-embed-1"),
      ocrVisionCapability("test-ocr-1"),
    ]);
    const { container } = render(<SettingsPanel />);
    await waitFor(() => {
      expect(container.textContent ?? "").toContain("2 chat");
    });
    expect(container.textContent ?? "").toContain("4 models");
  });
});

describe("SettingsPanel does not leak provider URLs or credentials (Issue #144 AC #3)", () => {
  it("renders no http(s):// host-name pattern in the model list markup", async () => {
    // A synthetic credential-shape string the test will look for. It is not
    // present on the capability props (ModelCapability has no api-key field
    // by design) — the assertion exists to pin the no-leak invariant.
    const SYNTHETIC_TOKEN_LITERAL = "sk-test-keiko-no-leak-canary";
    primeFetches([
      chatCapability("test-chat-1"),
      embeddingCapability("test-embed-1"),
      ocrVisionCapability("test-ocr-1"),
    ]);
    const { container } = render(<SettingsPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("conv-elig-ok")).toBeInTheDocument();
    });
    expect(container.innerHTML).not.toMatch(/https?:\/\//u);
    expect(container.innerHTML).not.toContain(SYNTHETIC_TOKEN_LITERAL);
    // Common credential-shape patterns we want to guard against, even though
    // ModelCapability does not expose them today.
    expect(container.innerHTML).not.toMatch(/Bearer\s+/u);
    expect(container.innerHTML).not.toMatch(/api[-_]?key/iu);
  });
});

describe("SettingsPanel gateway summary semantics", () => {
  it("distinguishes a configured gateway with zero models from setup-required state", async () => {
    primeFetches([]);
    render(<SettingsPanel />);
    await waitFor(() => {
      expect(screen.getByText("Gateway configured")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/review the gateway configuration or discovered model set/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("Gateway setup required")).toBeNull();
  });
});
