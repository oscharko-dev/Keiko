import { describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  announcedCreateCorrection,
  announcedCreateCount,
  toolCallAsTextCorrection,
  toolCallsWrittenAsText,
} from "./chat-tool-announced-create.js";
import { jiraMutationToolId } from "./atlassian/jiraMutationToolId.js";

function exchange(name: string, extra: Record<string, unknown> = {}): ChatToolExchange {
  const stored: unknown = { call: { id: `call-${name}`, name, arguments: {} }, ...extra };
  return stored as ChatToolExchange;
}
const READ = [exchange("jira_projects")];
/** A single create the mutation journal settled as succeeded, with the key Jira returned. */
const CREATED = exchange("jira_create-issues", {
  mutationOutcome: "succeeded",
  result: { status: "completed", data: { issueKey: "PROJ-1" } },
});
/** A draft that created two issues. */
const DRAFT_CREATED = exchange("jira_draft", {
  mutationOutcome: "succeeded",
  result: {
    status: "completed",
    toolRef: { canonicalId: jiraMutationToolId("jira.draft") },
    data: { items: [{ ref: "a", state: "created", issueKey: "PROJ-2" }] },
  },
});

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
  ])("counts %s when the turn holds no created receipt", (answer) => {
    expect(announcedCreateCount(READ, answer)).toBe(1);
  });

  it("counts every announcing sentence", () => {
    expect(
      announcedCreateCount(READ, "I created the epic. Then I added a task.\nThe bug was created."),
    ).toBe(3);
  });

  // The truthful answers a wrongly triggered correction would have damaged (audit of #4355).
  it.each([
    ["third-person history", "Issue PROJ-5 was created by Anna on Monday."],
    ["a dated creation", "The epic was created on 2026-11-01 and is still open."],
    ["a quoted Created field", "The epic shows created: 2026-11-01."],
    ["a back-reference to earlier work", "I created the 3 tasks above."],
    ["an earlier reply in German", "Ich habe die Aufgaben bereits zuvor angelegt."],
    ["something that is not an issue", "I created a summary of the open issues."],
    ["a German overview", "Ich habe eine Übersicht der Vorgänge erstellt."],
    ["a report made from issues", "The report was created from 33 issues."],
    ["a refusal", "I could not create the epic."],
    ["a negation", "No issue was created."],
    ["a question", "Should I create the epic?"],
    ["a plan", "I will create the epic next."],
    ["a German refusal", "Ich konnte den Epic nicht anlegen."],
    ["a German question", "Soll ich den Epic anlegen?"],
    ["no claim at all", "Nothing to do here."],
  ])("ignores %s", (_name, answer) => {
    expect(announcedCreateCount(READ, answer)).toBe(0);
  });

  it("ignores a sentence about an issue key a tool result or an earlier message already holds", () => {
    const answer = "The epic PROJ-7 was created.";
    expect(announcedCreateCount(READ, answer, ["Earlier: PROJ-7 exists."])).toBe(0);
    const reads = [exchange("jira_search", { result: { data: { items: [{ key: "PROJ-7" }] } } })];
    expect(announcedCreateCount(reads, answer)).toBe(0);
    expect(announcedCreateCount(READ, answer, ["No keys here."])).toBe(1);
  });

  it("is decided by effect: a created receipt exempts the turn, whatever the tool is called", () => {
    const answer = "I created the epic.";
    expect(announcedCreateCount([...READ, CREATED], answer)).toBe(0);
    expect(announcedCreateCount([DRAFT_CREATED], answer)).toBe(0);
  });

  it("corrects a claim after a refused, pending or declined create", () => {
    const answer = "I created the epic.";
    const refused = exchange("jira_draft", { mutationOutcome: "failed" });
    const pending = exchange("jira_create");
    const noKey = exchange("jira_draft", {
      mutationOutcome: "succeeded",
      result: { status: "completed", data: { items: [{ ref: "a", state: "failed" }] } },
    });
    expect(announcedCreateCount([refused], answer)).toBe(1);
    expect(announcedCreateCount([pending], answer)).toBe(1);
    expect(announcedCreateCount([noKey], answer)).toBe(1);
  });

  it("asks for an honest answer and never for a write", () => {
    for (const text of [announcedCreateCorrection(2), toolCallAsTextCorrection(1)]) {
      expect(text).toContain("Say plainly what happened");
      expect(text).toContain("do not create or change anything now");
      expect(text).not.toMatch(/call the create tool/iu);
    }
    expect(announcedCreateCorrection(2)).toContain("2 time(s)");
  });

  // Documented non-goals: remaining misses are variance the lab classifies, not defects of the guard.
  it.each([
    "Done, it is all set up now.",
    "J'ai créé l'epic.",
    "I created it. The epic is ready.",
    "I commented on the issue and moved it to Done.",
  ])("does not claim to detect %s", (answer) => {
    expect(announcedCreateCount(READ, answer)).toBe(0);
  });
});

describe("toolCallsWrittenAsText", () => {
  it.each([
    ['jira_create({"projectId":"10000"})', 1],
    ['{"name": "jira_create", "arguments": {}}', 1],
    ["<tool_call>x</tool_call> and <function_call>y", 2],
    ['knowledge_documents({"view":"inventory"}) then jira_search("q")', 2],
    ["Use the jira_create tool.", 0],
    ["The syntax is jira_search( followed by the query.", 0],
    ["Call jira_search(jql) to search.", 0],
    ["A plain answer.", 0],
  ])("counts the calls written as text in %s", (answer, count) => {
    expect(toolCallsWrittenAsText(answer)).toBe(count);
  });
});
