// Minimal compile-and-smoke coverage for the model-aware composer (issue #65).
// The full AC1-AC9 suite (model filtering, default fallback, four-mode payloads, provider-leak
// guards, axe, production-wiring) is delivered in the dedicated test commit that follows.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatComposer } from "./ChatComposer";
import * as api from "@/lib/api";
import type { Chat, ProjectWithAvailability } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  createChatMessage: vi.fn(),
  fetchModels: vi.fn(),
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

const PROJECT: ProjectWithAvailability = {
  path: "/repo",
  name: "repo",
  favorite: false,
  createdAt: 0,
  lastOpenedAt: 0,
  available: true,
};

const CHAT: Chat = {
  id: "chat-1",
  projectPath: "/repo",
  title: "t",
  selectedModel: "Mistral-Small-3.1-24B-Instruct-2503",
  createdAt: 0,
  updatedAt: 0,
};

describe("ChatComposer smoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.fetchModels).mockResolvedValue({ models: [] });
  });

  it("renders the textarea with an accessible label", async () => {
    render(
      <ChatComposer chatId="chat-1" chat={CHAT} project={PROJECT} onMessageSent={vi.fn()} />,
    );
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: /message/i })).toBeInTheDocument();
    });
  });

  it("disables submit until a workflow mode is selected", async () => {
    const user = userEvent.setup();
    render(
      <ChatComposer chatId="chat-1" chat={CHAT} project={PROJECT} onMessageSent={vi.fn()} />,
    );
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: /message/i })).toBeInTheDocument();
    });
    await user.type(screen.getByRole("textbox", { name: /message/i }), "hello");
    expect(screen.getByRole("button", { name: /send message/i })).toBeDisabled();
  });
});
