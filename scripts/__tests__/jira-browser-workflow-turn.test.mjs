import { describe, expect, it } from "vitest";
import {
  CHAT_SEND_PATHS,
  enterComposerText,
  isChatSendRequest,
  workflowUser,
  reviewWorkflowExchange,
} from "../testing/jira-chat-lab/browser-workflow-turn.mjs";

describe("Shared Jira live-browser turn boundary", () => {
  it("selects only the newly admitted user row, preserving earlier pending approvals as history", () => {
    const old = {
      id: "old",
      role: "user",
      toolTranscript: { exchanges: [{ approval: { state: "pending" } }] },
    };
    const current = { id: "current", role: "user", turnState: "pending" };
    expect(workflowUser([old, current], new Set([old.id]))).toBe(current);
    expect(workflowUser([old], new Set([old.id]))).toBeUndefined();
    expect(() => workflowUser([current, { id: "other", role: "user" }], new Set())).toThrow();
  });

  it("requires a visible pending approval for exactly the requested operation and its canonical alias", () => {
    const exchange = {
      call: { name: "jira_sprint_create" },
      approval: {
        operation: "jira.sprint-create",
        state: "pending",
        actionDigest: "synthetic-digest",
      },
    };
    expect(() => reviewWorkflowExchange(exchange, ["jira.sprint-create"])).not.toThrow();
    expect(() => reviewWorkflowExchange(exchange, ["jira.create-project"])).toThrow();
    expect(() =>
      reviewWorkflowExchange({ ...exchange, call: { name: "jira_delete_project" } }, [
        "jira.sprint-create",
      ]),
    ).toThrow();
    expect(() =>
      reviewWorkflowExchange(
        { ...exchange, approval: { ...exchange.approval, state: "approved" } },
        ["jira.sprint-create"],
      ),
    ).toThrow();
    expect(() =>
      reviewWorkflowExchange(
        { ...exchange, approval: { ...exchange.approval, actionDigest: undefined } },
        ["jira.sprint-create"],
      ),
    ).toThrow();
  });
});

describe("Chat send route recognition", () => {
  const request = (method, path) => ({
    method: () => method,
    url: () => `http://127.0.0.1:1983${path}`,
  });

  it("recognizes a Knowledge Pod grounded send as a composer send (LIM21)", () => {
    expect(isChatSendRequest(request("POST", "/api/chats/messages/grounded"))).toBe(true);
    expect(isChatSendRequest(request("POST", "/api/desktop/chat/stream"))).toBe(true);
    expect(isChatSendRequest(request("POST", "/api/desktop/chat"))).toBe(true);
    expect(isChatSendRequest(request("GET", "/api/chats/messages/grounded"))).toBe(false);
    expect(isChatSendRequest(request("POST", "/api/chats"))).toBe(false);
  });

  it("names exactly the product's composer send routes", async () => {
    const { API_ROUTES } = await import("../../packages/keiko-server/dist/routes.js");
    const sendHandlers = new Set([
      "handleGroundedAsk",
      "handleSendDesktopChat",
      "handleSendDesktopChatStream",
    ]);
    const productPaths = API_ROUTES.filter(
      (route) => route.method === "POST" && sendHandlers.has(route.handler.name),
    ).map((route) => route.pattern);
    expect(new Set(productPaths)).toEqual(CHAT_SEND_PATHS);
  });
});

describe("Composer prompt entry", () => {
  function recordingComposer() {
    const actions = [];
    const textbox = {
      fill: async (value) => void actions.push(["fill", value]),
      press: async (key) => void actions.push(["press", key]),
    };
    const page = {
      keyboard: { insertText: async (value) => void actions.push(["insert", value]) },
    };
    return { actions, page, textbox };
  }

  it("types each prompt line as its own paragraph and returns the text the composer sends (LIM23)", async () => {
    const { actions, page, textbox } = recordingComposer();
    const typed = await enterComposerText(
      page,
      textbox,
      "First line.\nSecond line.\n\nAfter a blank line.",
    );
    expect(actions).toEqual([
      ["fill", "First line."],
      ["press", "Shift+Enter"],
      ["insert", "Second line."],
      ["press", "Shift+Enter"],
      ["insert", "After a blank line."],
    ]);
    expect(actions.some(([, value]) => value.includes("\n"))).toBe(false);
    expect(typed).toBe("First line.\n\nSecond line.\n\nAfter a blank line.");
  });

  it("fills a single-line prompt unchanged", async () => {
    const { actions, page, textbox } = recordingComposer();
    expect(await enterComposerText(page, textbox, "One line only.")).toBe("One line only.");
    expect(actions).toEqual([["fill", "One line only."]]);
  });
});
