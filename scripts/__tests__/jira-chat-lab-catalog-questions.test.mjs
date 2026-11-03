import { expect, it } from "vitest";
import { jiraReadQuestion } from "../testing/jira-chat-lab/catalog-questions.mjs";
import { chatToolRequest } from "../testing/jira-chat-lab/chat-write.mjs";

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
