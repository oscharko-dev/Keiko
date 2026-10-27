import { expect, it } from "vitest";
import { verifyBrowserFaultTurn } from "../testing/jira-chat-lab/browser-faults.mjs";
import { verifyBrowserToolTurn } from "../testing/jira-chat-lab/browser-recovery.mjs";

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
