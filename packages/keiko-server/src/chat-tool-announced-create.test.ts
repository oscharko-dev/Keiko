import { describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  announcedCreateCorrection,
  announcedCreateCount,
  correctionRoundOffersTools,
  toolCallAsTextCorrection,
  toolCallsWrittenAsText,
  unsupportedApprovalClaimCount,
  unsupportedApprovalCorrection,
} from "./chat-tool-announced-create.js";
import { jiraMutationToolId } from "./atlassian/jiraMutationToolId.js";
import { jiraMutationToolResult } from "./atlassian/jiraMutationResult.js";
import { draftResult, type DraftItemResult } from "./atlassian/jiraChatDraft.js";
import { checkProperty } from "../../../tests/support/property-testing.js";

function exchange(name: string, extra: Record<string, unknown> = {}): ChatToolExchange {
  const stored: unknown = { call: { id: `call-${name}`, name, arguments: {} }, ...extra };
  return stored as ChatToolExchange;
}
const READ = [exchange("jira_projects")];
const BASE_URL = "https://jira.example.test";

/** An exchange whose result the production builders made, not a hand-written shape. */
function settled(
  operation: "jira.create" | "jira.create-issues" | "jira.edit" | "jira.comment",
  outcome: "succeeded" | "succeeded-unconfirmed" | "rejected",
  receipt: Record<string, unknown>,
): ChatToolExchange {
  const built = jiraMutationToolResult(outcome, undefined, receipt);
  return exchange(operation.replace(".", "_"), {
    mutationOutcome: outcome,
    result: {
      status: "completed",
      toolRef: { canonicalId: jiraMutationToolId(operation) },
      data: built.data,
    },
  });
}
function draftExchange(
  outcome: "succeeded" | "succeeded-unconfirmed",
  items: readonly DraftItemResult[],
): ChatToolExchange {
  return exchange("jira_draft", {
    mutationOutcome: outcome,
    result: {
      status: "completed",
      toolRef: { canonicalId: jiraMutationToolId("jira.draft") },
      data: draftResult(BASE_URL, items).data,
    },
  });
}
const CREATED = settled("jira.create", "succeeded", { issueId: "10001", issueKey: "PROJ-1" });
const DRAFT_CREATED = draftExchange("succeeded", [
  { ref: "a", state: "created", issueKey: "PROJ-2" },
]);

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

  // Truthful answers that remained false positives after the first audit round.
  it.each([
    "I opened the issue and read its description.",
    "I added up the issues: 12 are open.",
    "I added the label to the issue.",
    "Ich habe die Vorgänge gelesen und einen Text erstellt.",
    "Ich habe 12 Vorgänge gefunden und eine Auswertung erstellt.",
    "Die Auswertung der Vorgänge wurde erstellt.",
    "I created two comments on the issues.",
    "I created the analysis of the tasks.",
  ])("ignores the truthful %s", (answer) => {
    expect(announcedCreateCount(READ, answer)).toBe(0);
  });

  it("matches a known key as a whole key, not as the start of another", () => {
    const answer = "The epic KEIKO-1 was created.";
    expect(announcedCreateCount(READ, answer, ["History holds KEIKO-12."])).toBe(1);
    expect(announcedCreateCount(READ, answer, ["History holds KEIKO-1 and more."])).toBe(0);
    expect(announcedCreateCount(READ, answer, ["History holds XKEIKO-1."])).toBe(1);
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

  // Real creating results that are not "succeeded with one issueKey" (audit of #4355).
  it.each([
    [
      "a bulk create (issueKeys) acknowledged but not confirmed",
      settled("jira.create-issues", "succeeded-unconfirmed", { issueKeys: ["PROJ-1", "PROJ-2"] }),
    ],
    [
      "a create whose link attach failed or whose answer was lost",
      settled("jira.create", "succeeded-unconfirmed", {}),
    ],
    [
      "a bulk create that succeeded with its keys",
      settled("jira.create-issues", "succeeded", { issueKeys: ["PROJ-1"] }),
    ],
    [
      "a draft with an uncertain row",
      draftExchange("succeeded-unconfirmed", [{ ref: "a", state: "uncertain" }]),
    ],
  ])("exempts the turn after %s", (_name, creating) => {
    expect(announcedCreateCount([creating], "I created the 3 tasks.")).toBe(0);
  });

  it.each([
    ["an edit", settled("jira.edit", "succeeded", { issueKey: "PROJ-9" })],
    ["a comment", settled("jira.comment", "succeeded", { issueKey: "PROJ-9" })],
    ["a rejected create", settled("jira.create", "rejected", {})],
    ["a draft without a created row", draftExchange("succeeded", [{ ref: "a", state: "failed" }])],
  ])("does not read %s as a created receipt", (_name, other) => {
    expect(announcedCreateCount([other], "I created the epic.")).toBe(1);
  });

  it("corrects a claim after a refused, pending or declined create", () => {
    const answer = "I created the epic.";
    const refused = exchange("jira_draft", { mutationOutcome: "failed" });
    const pending = exchange("jira_create");
    expect(announcedCreateCount([refused], answer)).toBe(1);
    expect(announcedCreateCount([pending], answer)).toBe(1);
  });

  it("lets a claimed-action correction win over another one, with no tool in the round", () => {
    expect(correctionRoundOffersTools(["knowledge-coverage"])).toBe(true);
    expect(correctionRoundOffersTools(["unsupported-issue-key", "report-omission"])).toBe(true);
    expect(correctionRoundOffersTools(["announced-create"])).toBe(false);
    expect(correctionRoundOffersTools(["knowledge-coverage", "tool-call-as-text"])).toBe(false);
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

describe("unsupportedApprovalClaimCount (#4401)", () => {
  const read = exchange("jira_edit_fields", {
    result: { toolRef: { canonicalId: "keiko.jira.edit-fields", contractVersion: 1 } },
  });
  const claim = "Die Freigabekarte ist bereit.";
  const now = 1000;

  it.each([
    claim,
    "Die Freigabekarte ist bereit, bitte bestätige sie, wenn alles passt.",
    "The approval card is ready, approve it when you are happy with the three tasks.",
    "The approval card is ready and will create three tasks.",
    "No Jira issues were created and the approval card is ready.",
    "Es wurden keine Jira-Aufgaben erstellt und die Freigabekarte ist bereit.",
    "Die Freigabekarte steht bereit.",
    "Du kannst die drei Aufgaben jetzt in der Freigabekarte genehmigen.",
    "The approval card is ready. Please confirm the card.",
    "Die **Freigabekarte** wurde vorbereitet.",
    "I've prepared the approval card for you.",
    "I prepared approval card.",
    "I have prepared an approval request!",
    "I've prepared the approval card, please review it.",
    "I prepared an approval card and a summary.",
    "I prepared the approval request which contains your change.",
    "Ich habe die Freigabekarte vorbereitet.",
    "Bitte bestätige die Änderung in der Karte.",
    "Die Freigabe ist erneut vorbereitet.",
    "Bitte die Freigabe in der Karte erteilen; erst danach wird die Änderung geschrieben.",
  ])("detects %s after preparation alone", (answer) => {
    expect(unsupportedApprovalClaimCount([read], answer, now)).toBe(1);
  });

  it.each([
    "Die Freigabekarte ist nicht bereit.",
    "No approval card is ready.",
    "Once the approval card is ready, please confirm it.",
    "Once the request succeeds, the approval card is ready.",
    "If the requested metadata is complete, the approval card is ready.",
    "Wenn die Anfrage gelingt, ist die Freigabekarte bereit.",
    "The approval card is ready if the request succeeds.",
    "The approval card is ready only if the request succeeds.",
    "Die Freigabekarte ist bereit, aber nur wenn die Anfrage gelingt.",
    "The guide says: 'Don't claim the approval card is ready.'",
    "The guide says: ‘Don’t claim the approval card is ready.’",
    "If the approval card is ready, approve it when convenient.",
    "Wenn die Freigabekarte bereit ist, kannst du sie genehmigen.",
    "Die Freigabekarte ist bereit, falls die Anfrage gelingt.",
    "The approval card is ready and was declined.",
    'The guide says: "The approval card is ready and will create three tasks."',
    "Die Anleitung sagt: „Die Freigabekarte steht bereit.“",
    "Example: `The approval card is ready`.",
    "> The approval card is ready.",
    "Die Freigabe wurde zuvor vorbereitet und abgelehnt.",
    "The previous approval card was prepared yesterday.",
    "I will prepare an approval card.",
    "Ich habe die Felder für die Freigabe gelesen.",
    "Ich habe die Pflichtfelder für die Freigabe geprüft.",
    "I've prepared an approval checklist.",
    "I've prepared an approval card checklist.",
    "I prepared the approval card-reader.",
    "I have prepared an approval cardforreview.",
    "The approval card checklist is ready.",
    "Die Freigabe-Checkliste ist bereit.",
    "Ich habe die Freigabekarte gelesen.",
    "Bitte lies die Anleitung zur Freigabekarte.",
    "Bitte prüfe, ob eine Freigabekarte sichtbar ist.",
  ])("leaves truthful context alone: %s", (answer) => {
    expect(unsupportedApprovalClaimCount([read], answer, now)).toBe(0);
  });

  it("requires an actual Jira exchange, not a tool name or a prose result", () => {
    expect(unsupportedApprovalClaimCount(READ, claim, now)).toBe(0);
    expect(
      unsupportedApprovalClaimCount([exchange("jira_edit", { result: { data: {} } })], claim, now),
    ).toBe(0);
  });

  it("accepts only a server-bound Jira context for a turn without tools", () => {
    expect(unsupportedApprovalClaimCount([], claim, now, true)).toBe(1);
    expect(unsupportedApprovalClaimCount([], claim, now, false)).toBe(0);
  });

  it("keeps the assertion separate from attached conditions and quoted examples", async () => {
    await checkProperty({
      name: "approval assertion clause boundaries",
      runs: 64,
      generate: (random) => ({
        english: random.chance(0.5),
        suffix: random.pick([0, 1, 2] as const),
        quote: random.pick([
          ['"', '"'],
          ["„", "“"],
          ["`", "`"],
        ] as const),
      }),
      property: ({ english, suffix, quote }) => {
        const assertion = english ? "The approval card is ready" : "Die Freigabekarte ist bereit";
        const tails = english
          ? ([
              ", approve it when everything is correct.",
              " and will create the tasks.",
              ", please check that nothing is missing.",
            ] as const)
          : ([
              ", bitte bestätige sie, wenn alles passt.",
              ", danach werde ich die Aufgaben anlegen.",
              ", prüfe bitte, dass nichts fehlt.",
            ] as const);
        const statement = assertion + tails[suffix];
        expect(unsupportedApprovalClaimCount([read], statement, now)).toBe(1);
        expect(unsupportedApprovalClaimCount([read], quote[0] + statement + quote[1], now)).toBe(0);
        const conditional =
          assertion + (english ? ", if the request succeeds." : ", wenn die Anfrage gelingt.");
        expect(unsupportedApprovalClaimCount([read], conditional, now)).toBe(0);
      },
    });
  });

  it.each([
    ["pending", "call-jira_edit", now + 1, 0],
    ["pending", "another-call", now + 1, 1],
    ["pending", "call-jira_edit", now, 1],
    ["approved", "call-jira_edit", now + 1, 1],
    ["declined", "call-jira_edit", now + 1, 1],
  ])(
    "only exempts a live pending approval of its own invocation (%s, %s, %s)",
    (state, invocationId, expiresAt, count) => {
      const write = exchange("jira_edit", {
        result: { toolRef: { canonicalId: "keiko.jira.edit", contractVersion: 1 } },
        approval: { kind: "jira-chat-write", state, invocationId, expiresAt },
      });
      expect(unsupportedApprovalClaimCount([read, write], claim, now)).toBe(count);
    },
  );

  it("corrects truthfulness without permitting a write or manufacturing an approval", () => {
    expect(correctionRoundOffersTools(["report-download-missing", "approval-not-requested"])).toBe(
      false,
    );
    expect(unsupportedApprovalCorrection(1)).toContain("no pending Jira approval");
    expect(unsupportedApprovalCorrection(1)).toContain("do not create or change anything now");
  });
});
