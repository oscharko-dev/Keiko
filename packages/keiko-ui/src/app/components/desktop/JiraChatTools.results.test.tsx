import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { JiraChatTools } from "./JiraChatTools";

function exchange(outcome: string | undefined): ChatToolExchange {
  return {
    call: { id: "call-1", name: "jira_edit", arguments: { issueKey: "LAB-1" } },
    result: {
      schemaVersion: 1,
      invocationId: "invocation-1",
      toolRef: null,
      projectionDigest: null,
      effectStarted: true,
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
      status: "completed",
      reason: "none",
      page: { truncated: false, reason: "none", cursor: null },
      data: outcome === undefined ? {} : { outcome },
    },
  };
}

describe("Jira Chat mutation outcomes", () => {
  it.each([
    ["not-dispatched", "Not sent to Jira"],
    ["rejected", "Jira action rejected"],
    ["succeeded", "Jira change confirmed"],
    ["succeeded-unconfirmed", "Jira accepted the change; confirmation incomplete"],
    ["unknown", "Jira outcome unknown"],
    ["pending", "Awaiting a confirmed Jira outcome"],
  ])("renders the %s remote outcome rather than the enclosing tool status", (outcome, label) => {
    render(
      <JiraChatTools
        transcript={{ schemaVersion: 1, exchanges: [exchange(outcome)] }}
        turnState="completed"
      />,
    );
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.queryByText("Completed", { exact: true })).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });
  it.each([undefined, "unsupported-outcome"])("does not infer success from %s", (outcome) => {
    render(<JiraChatTools transcript={{ schemaVersion: 1, exchanges: [exchange(outcome)] }} />);
    expect(screen.getByText("Jira outcome unknown")).toBeVisible();
    expect(screen.getByText(/may have been applied/)).toBeVisible();
  });
  it("does not show an interrupted read as still running", () => {
    render(
      <JiraChatTools
        transcript={{
          schemaVersion: 1,
          exchanges: [{ call: { id: "read-1", name: "jira_projects", arguments: {} } }],
        }}
        turnState="cancelled"
      />,
    );
    expect(screen.getByText("Result unavailable")).toBeVisible();
    expect(screen.queryByText("Running")).toBeNull();
  });
  it("preserves uncertainty when a mutation has no result after interruption", () => {
    render(
      <JiraChatTools
        transcript={{ schemaVersion: 1, exchanges: [{ call: exchange("unknown").call }] }}
        turnState="failed"
      />,
    );
    expect(screen.getByText("Jira outcome unknown")).toBeVisible();
    expect(screen.queryByText("Running")).toBeNull();
  });
});

it.each([
  ["succeeded", "Jira change confirmed"],
  ["succeeded-unconfirmed", "Jira accepted the change; confirmation incomplete"],
  ["unknown", "Jira outcome unknown"],
] as const)("preserves journal outcome %s despite a cancelled tool envelope", (outcome, label) => {
  const original = exchange("unknown");
  if (original.result === undefined) throw new Error("Missing test result");
  render(
    <JiraChatTools
      transcript={{
        schemaVersion: 1,
        exchanges: [
          {
            ...original,
            mutationOutcome: outcome,
            result: {
              ...original.result,
              status: "cancelled",
              reason: "parent-cancelled",
              data: null,
              page: null,
            },
          },
        ],
      }}
      turnState="cancelled"
    />,
  );
  expect(screen.getByText(label)).toBeVisible();
  expect(screen.queryByText("Could not complete")).toBeNull();
});
