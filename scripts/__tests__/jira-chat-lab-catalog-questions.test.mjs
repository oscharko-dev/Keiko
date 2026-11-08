import { afterEach, expect, it, vi } from "vitest";
import { jiraReadQuestion } from "../testing/jira-chat-lab/catalog-questions.mjs";
import { chatToolRequest } from "../testing/jira-chat-lab/chat-write.mjs";
import { completeCatalogCase } from "../testing/jira-chat-lab/catalog-chat.mjs";
import { privateJson } from "../testing/jira-chat-lab/private-json.mjs";

vi.mock("../testing/jira-chat-lab/private-json.mjs", () => ({ privateJson: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const OBSERVED = {
  decisions: { grants: 1, approvals: 0 },
  exchange: { result: { data: { outcome: "succeeded" } } },
};

it("records a catalog case only after its independent native oracle has completed", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const group = { results: [], pendingPath: "/synthetic/catalog.pending.json" };
  let release;
  const oracle = new Promise((resolve) => {
    release = resolve;
  });
  const pending = completeCatalogCase(group, "jira.issue", OBSERVED, async (exchange) => {
    expect(exchange).toBe(OBSERVED.exchange);
    await oracle;
  });
  expect(group.results).toEqual([]);
  expect(privateJson).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  release();
  expect(await pending).toBe(OBSERVED.exchange);
  expect(group.results).toEqual([
    { operation: "jira.issue", decisions: OBSERVED.decisions, transcriptOutcome: "succeeded" },
  ]);
  expect(privateJson).toHaveBeenCalledWith(group.pendingPath, group);
  expect(log).toHaveBeenCalledWith(
    JSON.stringify({
      qualification: "jira-chat-catalog",
      operation: "jira.issue",
      completed: true,
      ...OBSERVED.decisions,
    }),
  );
});

it("does not persist or emit a completed catalog case when native readback fails", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const group = { results: [], pendingPath: "/synthetic/catalog.pending.json" };
  const failure = new TypeError("Synthetic independent readback failure");
  await expect(
    completeCatalogCase(group, "jira.create", OBSERVED, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(group.results).toEqual([]);
  expect(privateJson).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});

it.each([
  "projects",
  "issue-types",
  "create-fields",
  "edit-fields",
  "search",
  "issue",
  "comments",
  "transitions",
  "assignable-users",
])("adds a human %s question without changing the exact request or action constraints", (name) => {
  const intent = {
    operation: `jira.${name}`,
    arguments: { issueKey: "KEIKO-1" },
    clientTurnId: "turn",
  };
  const context = { modelId: "model", projectPath: "/synthetic" };
  const chat = { id: "chat", groundingScopeIdentity: "scope" };
  const question = jiraReadQuestion(intent.operation);
  expect(typeof question).toBe("string");
  expect(question).toContain("?");
  const original = chatToolRequest(context, chat, intent);
  const actual = chatToolRequest(context, chat, { ...intent, question });
  expect(actual).toEqual({ ...original, content: `${question}\n\n${original.content}` });
});

it.each(["create", "edit", "assign", "comment", "transition"])(
  "preserves the existing %s mutation request",
  (name) => {
    const intent = {
      operation: `jira.${name}`,
      arguments: { issueKey: "KEIKO-1" },
      clientTurnId: "turn",
    };
    const context = { modelId: "model", projectPath: "/synthetic" };
    const chat = { id: "chat", groundingScopeIdentity: "scope" };
    expect(jiraReadQuestion(intent.operation)).toBeUndefined();
    expect(
      chatToolRequest(context, chat, { ...intent, question: jiraReadQuestion(intent.operation) }),
    ).toEqual(chatToolRequest(context, chat, intent));
  },
);
