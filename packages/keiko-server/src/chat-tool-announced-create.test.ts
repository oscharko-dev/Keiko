import { describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  announcedCreateCorrection,
  announcedCreateCount,
  toolCallAsTextCorrection,
  toolCallsWrittenAsText,
} from "./chat-tool-announced-create.js";

function exchange(name: string, mutationOutcome?: "succeeded" | "failed"): ChatToolExchange {
  return {
    call: { id: `call-${name}`, name, arguments: {} },
    ...(mutationOutcome === undefined ? {} : { mutationOutcome }),
  } as unknown as ChatToolExchange;
}
const READ = [exchange("jira_projects")];

describe("announcedCreateCount", () => {
  it.each([
    "I created the Epic for the login work.",
    "I've created 3 stories under it.",
    "The epic has been created successfully.",
    "Both tasks were created.",
    "Successfully created the bug.",
    "Ich habe den Epic angelegt.",
    "Der Epic wurde erfolgreich angelegt.",
    "Die Vorgänge wurden erstellt.",
    "Ich habe die drei Aufgaben jetzt erstellt.",
  ])("counts %s when the turn holds no create call", (answer) => {
    expect(announcedCreateCount(READ, answer)).toBe(1);
  });

  it("counts every announcing sentence", () => {
    expect(
      announcedCreateCount(READ, "I created the epic. Then I added a task.\nThe bug was created."),
    ).toBe(3);
  });

  it.each([
    "I could not create the epic.",
    "No issue was created.",
    "Should I create the epic?",
    "I will create the epic next.",
    "Ich konnte den Epic nicht anlegen.",
    "Soll ich den Epic anlegen?",
    "I created a summary of the project.",
    "The report was created from 33 issues.",
    "Nothing to do here.",
  ])("ignores %s", (answer) => {
    expect(announcedCreateCount(READ, answer)).toBe(0);
  });

  it("asks nothing of a turn that holds a create call, whatever its outcome", () => {
    const answer = "I created the epic.";
    expect(announcedCreateCount([...READ, exchange("jira_create")], answer)).toBe(0);
    expect(announcedCreateCount([exchange("jira_draft")], answer)).toBe(0);
    expect(announcedCreateCount([exchange("jira_comment", "failed")], answer)).toBe(0);
  });

  it("states the correction without naming anything the answer said", () => {
    expect(announcedCreateCorrection(2)).toContain("2 time(s)");
    expect(announcedCreateCorrection(2)).toContain("nothing was created");
  });
});

describe("toolCallsWrittenAsText", () => {
  it.each([
    ['jira_create({"projectId":"10000"})', 1],
    ['{"name": "jira_create", "arguments": {}}', 1],
    ["<tool_call>x</tool_call> and <function_call>y", 2],
    ["I will use knowledge_documents(view) then jira_search(q)", 2],
    ["Use the jira_create tool.", 0],
    ["A plain answer.", 0],
  ])("counts the calls written as text in %s", (answer, count) => {
    expect(toolCallsWrittenAsText(answer)).toBe(count);
    expect(toolCallAsTextCorrection(1)).toContain("not executed");
  });
});
