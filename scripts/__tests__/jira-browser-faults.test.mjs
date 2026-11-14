import { expect, it } from "vitest";
import {
  selectedSubjects,
  verifyBrowserFaultTurn,
} from "../testing/jira-chat-lab/browser-faults.mjs";
import {
  browserWriteTool,
  verifyBrowserToolTurn,
} from "../testing/jira-chat-lab/browser-recovery.mjs";

const intent = { key: "SYN-1", marker: "Synthetic browser fault" };

function transcript(outcome = "unknown") {
  return {
    messages: [
      {
        id: "user",
        role: "user",
        turnState: "completed",
        toolTranscript: {
          exchanges: [
            {
              call: {
                id: "call",
                name: "jira_comment",
                arguments: { issueKey: intent.key, body: intent.marker },
              },
              mutationOutcome: outcome,
              result: { data: { outcome } },
            },
          ],
        },
      },
      { id: "assistant", role: "assistant" },
    ],
  };
}

it("pins the exact canonical identity for browser duplicate, reload and Regenerate witnesses", () => {
  expect(verifyBrowserFaultTurn(transcript(), intent)).toEqual({
    userId: "user",
    callId: "call",
    assistantId: "assistant",
  });
});

it.each(["succeeded", "succeeded-unconfirmed", "not-dispatched", "rejected"])(
  "never qualifies an injected unknown effect as %s",
  (outcome) => {
    expect(() => verifyBrowserFaultTurn(transcript(outcome), intent)).toThrow();
  },
);

it("rejects an extra mutation even when the expected comment result appears first", () => {
  const completed = transcript();
  completed.messages[0].toolTranscript.exchanges.push({
    call: { id: "second", name: "jira_edit", arguments: {} },
  });
  expect(() => verifyBrowserFaultTurn(completed, intent)).toThrow();
});

it("keeps a physically dropped browser completion distinct from unknown Jira acknowledgements", () => {
  expect(verifyBrowserToolTurn(transcript("succeeded"), intent, "succeeded")).toEqual({
    userId: "user",
    callId: "call",
    assistantId: "assistant",
  });
  expect(() => verifyBrowserToolTurn(transcript("unknown"), intent, "succeeded")).toThrow();
});

const creation = {
  marker: "Synthetic browser fault 1",
  operation: "jira.create",
  arguments: {
    projectId: "10000",
    issueTypeId: "10002",
    fields: { summary: "Synthetic browser fault 1" },
  },
};

function creationTranscript(name = "jira_create", args = creation.arguments) {
  const completed = transcript();
  completed.messages[0].toolTranscript.exchanges[0].call = { id: "call", name, arguments: args };
  return completed;
}

it("verifies a creation by its own tool and exact arguments, never as a comment", () => {
  expect(browserWriteTool(creation)).toBe("jira_create");
  expect(browserWriteTool(intent)).toBe("jira_comment");
  expect(verifyBrowserFaultTurn(creationTranscript(), creation)).toEqual({
    userId: "user",
    callId: "call",
    assistantId: "assistant",
  });
  expect(() => verifyBrowserFaultTurn(creationTranscript("jira_comment"), creation)).toThrow();
  expect(() =>
    verifyBrowserFaultTurn(
      creationTranscript("jira_create", { ...creation.arguments, extra: 1 }),
      creation,
    ),
  ).toThrow();
  expect(() => verifyBrowserFaultTurn(transcript(), creation)).toThrow();
});

it("selects the write kinds a run proves and refuses an unknown one", () => {
  expect(selectedSubjects(undefined)).toEqual(["comment", "create"]);
  expect(selectedSubjects("create")).toEqual(["create"]);
  expect(selectedSubjects("create,create")).toEqual(["create"]);
  expect(() => selectedSubjects("delete")).toThrow();
});
