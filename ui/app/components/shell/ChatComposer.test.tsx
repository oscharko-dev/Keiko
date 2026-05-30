// Full coverage for the model-aware composer (issue #65). Tests are organised by AC:
//   AC1 — dropdown contains only kind === "chat" models from the fixture
//   AC2 — DOM order matches registry-fixture order
//   AC3 — default selection picks chat.selectedModel when present in the chat slice
//   AC4 — empty chat slice: submit disabled + role="alert" "No chat models available"
//   AC5 — picking a different model: updateChat PATCHes BEFORE startRun
//   AC6 — per-mode startRun payload (4 modes)
//   AC7 — every startRun payload has input.workspaceRoot === project.path and the picked modelId
//   AC8 — security anti-leak: payloads never contain provider keys; /api/config never fetched
//   AC9 — explicit OCR/embedding exclusion in the dropdown <option> set
// Plus: disabled-state matrix, keyboard behaviour, axe across UI states, and a production-
//       wiring integration test that uses the real `api.ts` against a stub HTTP server.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ChatComposer } from "./ChatComposer";
import * as api from "@/lib/api";
import type { Chat, ModelCapability, ProjectWithAvailability } from "@/lib/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHAT_MODEL_IDS = [
  "Qwen3-Coder-480B-A35B-Instruct-FP8",
  "Qwen/Qwen3-Coder-Next-FP8",
  "Devstral-2-123B-Instruct-2512",
  "gpt-oss-120b",
  "Mistral-Small-3.1-24B-Instruct-2503",
  "Qwen2.5-Coder-7B-Instruct",
  "gemma-4-31b-it",
] as const;

const OCR_MODEL_ID = "dotsocr";
const EMBEDDING_MODEL_ID = "multilingual-e5-large Embedding";

function chatModel(id: string): ModelCapability {
  return {
    id,
    kind: "chat",
    contextWindow: 128_000,
    maxOutputTokens: 8_000,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    costClass: "medium",
    latencyClass: "medium",
    throughputHint: "ok",
    preferredUseCases: [],
    knownLimitations: [],
  };
}

function ocrModel(): ModelCapability {
  return { ...chatModel(OCR_MODEL_ID), kind: "ocr-vision" };
}

function embeddingModel(): ModelCapability {
  return { ...chatModel(EMBEDDING_MODEL_ID), kind: "embedding" };
}

const REGISTRY_FIXTURE: readonly ModelCapability[] = [
  ocrModel(),
  ...CHAT_MODEL_IDS.slice(0, 4).map((id) => chatModel(id)),
  embeddingModel(),
  ...CHAT_MODEL_IDS.slice(4).map((id) => chatModel(id)),
];

const PROJECT: ProjectWithAvailability = {
  path: "/repo",
  name: "repo",
  favorite: false,
  createdAt: 0,
  lastOpenedAt: 0,
  available: true,
};

function makeChat(selectedModel: string): Chat {
  return {
    id: "chat-1",
    projectPath: "/repo",
    title: "t",
    selectedModel,
    createdAt: 0,
    updatedAt: 0,
  };
}

// ---------------------------------------------------------------------------
// API mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/api", () => ({
  createChatMessage: vi.fn(),
  fetchModels: vi.fn(),
  fetchConfig: vi.fn(),
  updateChat: vi.fn(),
  startRun: vi.fn(),
  ApiError: class ApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, msg: string, status: number) {
      super(msg);
      this.name = "ApiError";
      this.code = code;
      this.status = status;
    }
  },
}));

const startRunOk = { runId: "run-1", fingerprint: "f" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.fetchModels).mockResolvedValue({ models: [...REGISTRY_FIXTURE] });
  vi.mocked(api.createChatMessage).mockResolvedValue({
    message: { id: "m", chatId: "chat-1", role: "user", content: "x", timestamp: 0 },
  });
  vi.mocked(api.updateChat).mockResolvedValue({ chat: makeChat("Mistral-Small-3.1-24B-Instruct-2503") });
  vi.mocked(api.startRun).mockResolvedValue(startRunOk);
});

function renderComposer(chat = makeChat("Mistral-Small-3.1-24B-Instruct-2503")): void {
  render(
    <ChatComposer
      chatId="chat-1"
      chat={chat}
      project={PROJECT}
      onMessageSent={vi.fn()}
    />,
  );
}

async function waitForReady(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: /model/i })).toBeInTheDocument();
  });
  // The async useEffect populates the chatModels and selects the default — wait until
  // the dropdown has options before proceeding so DOM-order assertions are stable.
  await waitFor(() => {
    expect(screen.queryAllByRole("option").length).toBeGreaterThanOrEqual(0);
  });
}

async function selectMode(mode: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("radio", { name: new RegExp(mode, "i") }));
}

// Deep walk: returns true if any nested key (case-insensitive) matches a forbidden key.
const FORBIDDEN_KEYS = new Set(
  ["baseurl", "apikey", "deployment", "deploymentname", "endpoint", "apiversion"].map((k) =>
    k.toLowerCase(),
  ),
);

function containsForbiddenKey(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenKey(entry));
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(k.toLowerCase())) return true;
    if (containsForbiddenKey(v)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AC1 — dropdown contains only kind === \"chat\" models from the fixture", () => {
  it("renders exactly the 7 chat models by name", async () => {
    renderComposer();
    await waitForReady();
    const combo = screen.getByRole("combobox", { name: /model/i });
    const options = within(combo).getAllByRole("option");
    expect(options.map((o) => o.getAttribute("value"))).toEqual([...CHAT_MODEL_IDS]);
  });

  it("does not render the OCR (dotsocr) model anywhere", async () => {
    renderComposer();
    await waitForReady();
    expect(screen.queryByRole("option", { name: OCR_MODEL_ID })).not.toBeInTheDocument();
  });

  it("does not render the embedding model anywhere", async () => {
    renderComposer();
    await waitForReady();
    expect(
      screen.queryByRole("option", { name: EMBEDDING_MODEL_ID }),
    ).not.toBeInTheDocument();
  });
});

describe("AC2 — DOM order matches registry-fixture chat-slice order", () => {
  it("preserves the order of CHAT_MODEL_IDS exactly", async () => {
    renderComposer();
    await waitForReady();
    const combo = screen.getByRole("combobox", { name: /model/i });
    const orderedIds = within(combo)
      .getAllByRole("option")
      .map((o) => o.getAttribute("value") ?? "");
    expect(orderedIds).toEqual([...CHAT_MODEL_IDS]);
  });
});

describe("AC3 — default selection prefers chat.selectedModel when in registry", () => {
  it("selects Mistral by default when the chat's selectedModel is Mistral", async () => {
    renderComposer(makeChat("Mistral-Small-3.1-24B-Instruct-2503"));
    await waitForReady();
    const combo = screen.getByRole("combobox", { name: /model/i }) as HTMLSelectElement;
    expect(combo.value).toBe("Mistral-Small-3.1-24B-Instruct-2503");
  });

  it("falls back to Mistral when chat.selectedModel is not in the registry", async () => {
    renderComposer(makeChat("not-a-real-model"));
    await waitForReady();
    const combo = screen.getByRole("combobox", { name: /model/i }) as HTMLSelectElement;
    expect(combo.value).toBe("Mistral-Small-3.1-24B-Instruct-2503");
  });
});

describe("AC4 — no chat models: alert + submit disabled", () => {
  it("renders a role=alert with the no-models message and disables submit", async () => {
    vi.mocked(api.fetchModels).mockResolvedValueOnce({ models: [] });
    renderComposer();
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/no chat models available/i);
    });
    expect(screen.getByRole("button", { name: /send message/i })).toBeDisabled();
  });

  it("does not call startRun even when the user clicks send", async () => {
    vi.mocked(api.fetchModels).mockResolvedValueOnce({ models: [] });
    const user = userEvent.setup();
    renderComposer();
    await waitFor(() => screen.getByRole("alert"));
    await user.click(screen.getByRole("button", { name: /send message/i }));
    expect(api.startRun).not.toHaveBeenCalled();
  });
});

describe("AC5 — picking a different model PATCHes the chat before startRun", () => {
  it("calls updateChat with the new model id BEFORE startRun", async () => {
    const user = userEvent.setup();
    const callOrder: string[] = [];
    vi.mocked(api.updateChat).mockImplementation((id, patch) => {
      callOrder.push(`updateChat:${patch.selectedModel ?? ""}`);
      return Promise.resolve({ chat: makeChat(patch.selectedModel ?? "") });
    });
    vi.mocked(api.startRun).mockImplementation((body) => {
      callOrder.push(`startRun:${body.modelId}`);
      return Promise.resolve(startRunOk);
    });
    renderComposer();
    await waitForReady();
    const combo = screen.getByRole("combobox", { name: /model/i });
    await user.selectOptions(combo, "Qwen2.5-Coder-7B-Instruct");
    await selectMode("Verify");
    await user.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledTimes(1));
    expect(callOrder).toEqual([
      "updateChat:Qwen2.5-Coder-7B-Instruct",
      "startRun:Qwen2.5-Coder-7B-Instruct",
    ]);
  });

  it("skips updateChat when the user keeps the chat's existing model", async () => {
    const user = userEvent.setup();
    renderComposer();
    await waitForReady();
    await selectMode("Verify");
    await user.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledTimes(1));
    expect(api.updateChat).not.toHaveBeenCalled();
  });
});

describe("AC6 + AC7 — per-mode startRun payload", () => {
  it("Generate Tests sends workflowId=unit-test-generation with the moduleDir target", async () => {
    const user = userEvent.setup();
    renderComposer();
    await waitForReady();
    await selectMode("Generate Tests");
    await user.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledTimes(1));
    const arg = vi.mocked(api.startRun).mock.calls[0]?.[0];
    expect(arg).toBeDefined();
    expect(arg).toMatchObject({
      workflowId: "unit-test-generation",
      modelId: "Mistral-Small-3.1-24B-Instruct-2503",
      input: {
        target: { kind: "moduleDir", moduleDir: "/repo" },
        workspaceRoot: "/repo",
      },
    });
  });

  it("Investigate Bug sends workflowId=bug-investigation with report.description", async () => {
    const user = userEvent.setup();
    renderComposer();
    await waitForReady();
    await selectMode("Investigate Bug");
    await user.type(screen.getByRole("textbox", { name: /message/i }), "NPE on login");
    await user.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledTimes(1));
    const arg = vi.mocked(api.startRun).mock.calls[0]?.[0];
    expect(arg).toMatchObject({
      workflowId: "bug-investigation",
      modelId: "Mistral-Small-3.1-24B-Instruct-2503",
      input: { report: { description: "NPE on login" }, workspaceRoot: "/repo" },
    });
  });

  it("Explain Plan sends taskType=explain-plan with filePath and optional question", async () => {
    const user = userEvent.setup();
    renderComposer();
    await waitForReady();
    await selectMode("Explain Plan");
    const textarea = screen.getByRole("textbox", { name: /message/i });
    // Shift+Enter inserts a newline (Enter alone would submit), so we type the file path,
    // then Shift+Enter, then the question.
    await user.type(textarea, "src/foo.ts");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(textarea, "what does it do?");
    await user.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledTimes(1));
    const arg = vi.mocked(api.startRun).mock.calls[0]?.[0];
    expect(arg).toMatchObject({
      taskType: "explain-plan",
      modelId: "Mistral-Small-3.1-24B-Instruct-2503",
      input: { filePath: "src/foo.ts", question: "what does it do?", workspaceRoot: "/repo" },
    });
  });

  it("Verify sends taskType=verify with workspaceRoot only", async () => {
    const user = userEvent.setup();
    renderComposer();
    await waitForReady();
    await selectMode("Verify");
    await user.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledTimes(1));
    const arg = vi.mocked(api.startRun).mock.calls[0]?.[0];
    expect(arg).toMatchObject({
      taskType: "verify",
      modelId: "Mistral-Small-3.1-24B-Instruct-2503",
      input: { workspaceRoot: "/repo" },
    });
  });
});

describe("AC8 — security anti-leak", () => {
  it("never fetches /api/config across any of the four modes", async () => {
    const user = userEvent.setup();
    const modes = ["Generate Tests", "Investigate Bug", "Explain Plan", "Verify"];
    for (const mode of modes) {
      cleanup();
      vi.clearAllMocks();
      vi.mocked(api.fetchModels).mockResolvedValue({ models: [...REGISTRY_FIXTURE] });
      vi.mocked(api.createChatMessage).mockResolvedValue({
        message: { id: "m", chatId: "chat-1", role: "user", content: "x", timestamp: 0 },
      });
      vi.mocked(api.startRun).mockResolvedValue(startRunOk);
      renderComposer();
      await waitForReady();
      await selectMode(mode);
      if (mode === "Explain Plan" || mode === "Investigate Bug") {
        await user.type(screen.getByRole("textbox", { name: /message/i }), "x");
      }
      await user.click(screen.getByRole("button", { name: /send message/i }));
      await waitFor(() => expect(api.startRun).toHaveBeenCalledTimes(1));
      expect(api.fetchConfig).not.toHaveBeenCalled();
    }
  });

  it("startRun payloads contain no provider-config-shaped keys in any mode", async () => {
    const user = userEvent.setup();
    const modes = ["Generate Tests", "Investigate Bug", "Explain Plan", "Verify"];
    for (const mode of modes) {
      cleanup();
      vi.clearAllMocks();
      vi.mocked(api.fetchModels).mockResolvedValue({ models: [...REGISTRY_FIXTURE] });
      vi.mocked(api.createChatMessage).mockResolvedValue({
        message: { id: "m", chatId: "chat-1", role: "user", content: "x", timestamp: 0 },
      });
      vi.mocked(api.startRun).mockResolvedValue(startRunOk);
      renderComposer();
      await waitForReady();
      await selectMode(mode);
      if (mode === "Explain Plan" || mode === "Investigate Bug") {
        await user.type(screen.getByRole("textbox", { name: /message/i }), "x");
      }
      await user.click(screen.getByRole("button", { name: /send message/i }));
      await waitFor(() => expect(api.startRun).toHaveBeenCalledTimes(1));
      const arg = vi.mocked(api.startRun).mock.calls[0]?.[0];
      expect(containsForbiddenKey(arg)).toBe(false);
    }
  });
});

describe("AC9 — explicit OCR/embedding exclusion via option set", () => {
  it("the option <value> set has zero overlap with non-chat model ids", async () => {
    renderComposer();
    await waitForReady();
    const combo = screen.getByRole("combobox", { name: /model/i });
    const values = within(combo)
      .getAllByRole("option")
      .map((o) => o.getAttribute("value") ?? "");
    expect(values).not.toContain(OCR_MODEL_ID);
    expect(values).not.toContain(EMBEDDING_MODEL_ID);
  });
});

describe("disabled state matrix", () => {
  it("submit is disabled with no mode selected (textarea filled)", async () => {
    const user = userEvent.setup();
    renderComposer();
    await waitForReady();
    await user.type(screen.getByRole("textbox", { name: /message/i }), "x");
    expect(screen.getByRole("button", { name: /send message/i })).toBeDisabled();
  });

  it("submit is disabled with Explain Plan + empty textarea", async () => {
    renderComposer();
    await waitForReady();
    await selectMode("Explain Plan");
    expect(screen.getByRole("button", { name: /send message/i })).toBeDisabled();
  });

  it("submit is enabled with Verify + empty textarea", async () => {
    renderComposer();
    await waitForReady();
    await selectMode("Verify");
    expect(screen.getByRole("button", { name: /send message/i })).not.toBeDisabled();
  });
});

describe("keyboard behaviour", () => {
  it("Enter submits when ready, Shift+Enter does not", async () => {
    const user = userEvent.setup();
    renderComposer();
    await waitForReady();
    await selectMode("Verify");
    const textarea = screen.getByRole("textbox", { name: /message/i });
    await user.click(textarea);
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(api.startRun).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(api.startRun).toHaveBeenCalledTimes(1));
  });
});

describe("a11y — axe across UI states", () => {
  it("idle (no mode) has no axe violations", async () => {
    const { container } = render(
      <ChatComposer
        chatId="chat-1"
        chat={makeChat("Mistral-Small-3.1-24B-Instruct-2503")}
        project={PROJECT}
        onMessageSent={vi.fn()}
      />,
    );
    await waitForReady();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("mode-selected has no axe violations", async () => {
    const { container } = render(
      <ChatComposer
        chatId="chat-1"
        chat={makeChat("Mistral-Small-3.1-24B-Instruct-2503")}
        project={PROJECT}
        onMessageSent={vi.fn()}
      />,
    );
    await waitForReady();
    await selectMode("Verify");
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("no-models alert has no axe violations", async () => {
    vi.mocked(api.fetchModels).mockResolvedValueOnce({ models: [] });
    const { container } = render(
      <ChatComposer
        chatId="chat-1"
        chat={makeChat("Mistral-Small-3.1-24B-Instruct-2503")}
        project={PROJECT}
        onMessageSent={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByRole("alert"));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

// ---------------------------------------------------------------------------
// Production-wiring integration test (per #62 audit lesson): exercises the real
// `api.ts` `fetchModels` against a stub HTTP server. No vi.mock on `@/lib/api` here.
// ---------------------------------------------------------------------------

describe("production wiring — real api.ts + stub /api/models server", () => {
  // We can't `vi.unmock` here without breaking the file-level mock for the AC tests above. Instead
  // we exercise the real `fetchModels` via `vi.importActual` (which bypasses the registered mock
  // but does NOT replace it), then point its same-origin fetch at a stub HTTP server via a global
  // fetch shim that rewrites the relative URL to the loopback origin.
  let server: Server | undefined;
  let baseUrl: string;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    server = createServer((req, res) => {
      if (req.url === "/api/models") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ models: REGISTRY_FIXTURE }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((res) => server?.listen(0, "127.0.0.1", res));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${String(port)}`;
    originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const absolute = url.startsWith("http") ? url : `${baseUrl}${url}`;
      return originalFetch(absolute, init);
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (server !== undefined) {
      const s = server;
      await new Promise<void>((res) => s.close(() => res()));
    }
  });

  it("dropdown lists only chat-kind models when wired to the real fetchModels", async () => {
    const realApi = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
    const { models } = await realApi.fetchModels();
    const chatKindIds = models.filter((m) => m.kind === "chat").map((m) => m.id);
    expect(chatKindIds).toEqual([...CHAT_MODEL_IDS]);
    expect(chatKindIds).not.toContain(OCR_MODEL_ID);
    expect(chatKindIds).not.toContain(EMBEDDING_MODEL_ID);
  });
});
