import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import { JiraWriteApproval } from "./JiraWriteApproval";
import { ChatJiraNames } from "./jiraNames";

const BINDING = {
  chatId: "chat-1",
  podId: "11111111-1111-4111-8111-111111111111",
  bindingGeneration: 1,
  authenticationGeneration: 1,
};
const APPROVAL: ChatToolWriteApprovalView = {
  ...BINDING,
  kind: "jira-chat-write",
  approvalId: "approval-1",
  invocationId: "invocation-1",
  operation: "jira.draft",
  actionDigest: "a".repeat(64),
  requestedAt: 1,
  expiresAt: 2,
  state: "approved",
};
function read(
  name: string,
  args: Record<string, unknown>,
  items: readonly unknown[],
): ChatToolExchange {
  return {
    call: { id: name, name, arguments: args },
    result: {
      status: "completed",
      page: { truncated: false, reason: "none", cursor: null },
      data: { items },
    },
  } as unknown as ChatToolExchange;
}
function transcript(...exchanges: readonly ChatToolExchange[]): ChatToolTranscript {
  return {
    schemaVersion: 1,
    exchanges,
    readGrant: {
      ...BINDING,
      kind: "jira-chat-read",
      grantId: "grant-1",
      state: "granted",
      disclosureVersion: "jira-chat-read-v1",
      requestedAt: 1,
      expiresAt: 2,
    },
  };
}
function metadata(
  allowedValues: readonly unknown[],
  kind = "option",
  fieldId = "priority",
): ChatToolTranscript {
  return transcript(
    read("jira_projects", {}, [{ id: "10000", key: "TERMIN", name: "Terminbuchung" }]),
    read("jira_create_fields", { projectKey: "TERMIN", issueTypeId: "10002" }, [
      { id: fieldId, name: "Priority", kind, allowedValues },
    ]),
  );
}
function review(
  reads: readonly ChatToolTranscript[],
  operation: "jira.create" | "jira.draft" | "jira.edit" | "jira.transition" = "jira.draft",
  fields: Record<string, unknown> = { summary: "Synthetic epic", priority: { id: "1" } },
  target: Record<string, unknown> = { projectId: "10000", issueTypeId: "10002" },
): void {
  const item = {
    ...target,
    ref: "epic",
    fields,
  };
  render(
    <ChatJiraNames messages={reads.map((toolTranscript) => ({ toolTranscript }))}>
      <JiraWriteApproval
        approval={{ ...APPROVAL, operation }}
        call={{
          id: "write",
          name: operation.replace(".", "_"),
          arguments: operation === "jira.draft" ? { items: [item] } : item,
        }}
        turnState="completed"
      />
    </ChatJiraNames>,
  );
}

function expectRawId(): void {
  expect(screen.getByText("1", { exact: true })).toBeVisible();
  expect(screen.queryByText("Highest")).toBeNull();
}

describe("Jira approval selection values from instance metadata", () => {
  it.each(["jira.create", "jira.draft"] as const)(
    "shows priority id 1 as the instance's Highest label in %s",
    (operation) => {
      review([metadata([{ id: "1", name: "Highest" }])], operation);
      expect(screen.getByText("Highest")).toBeVisible();
      expect(screen.queryByText("1", { exact: true })).toBeNull();
    },
  );

  it("resolves a custom multiselect's display labels without a priority-specific map", () => {
    review(
      [
        metadata(
          [
            { id: "1", label: "Blue" },
            { id: "2", label: "Green" },
          ],
          "options",
          "customfield_9",
        ),
      ],
      "jira.draft",
      { summary: "Synthetic", customfield_9: [{ id: "1" }, { id: "2" }] },
    );
    expect(screen.getByText("Blue")).toBeVisible();
    expect(screen.getByText("Green")).toBeVisible();
  });

  it.each([
    { name: "missing choices", values: [] },
    { name: "unknown identity", values: [{ id: "2", name: "Highest" }] },
    { name: "missing name", values: [{ id: "1" }] },
    { name: "blank name", values: [{ id: "1", name: " " }] },
    {
      name: "conflicting ids",
      values: [
        { id: "1", name: "Highest" },
        { id: "1", name: "Low" },
      ],
    },
    {
      name: "duplicate display names",
      values: [
        { id: "1", name: "Highest" },
        { id: "2", name: "Highest" },
      ],
    },
    {
      name: "identity-name collision",
      values: [
        { id: "1", name: "Highest" },
        { id: "2", name: "1" },
      ],
    },
  ])("keeps the requested id visible for $name", ({ values }) => {
    review([metadata(values)]);
    expectRawId();
  });

  it.each(["projectId", "issueTypeId"])("does not reuse a choice from another %s", (key) => {
    review([metadata([{ id: "1", name: "Highest" }])], "jira.draft", undefined, {
      projectId: "10000",
      issueTypeId: "10002",
      [key]: "other",
    });
    expectRawId();
  });

  it.each(["podId", "bindingGeneration", "authenticationGeneration"] as const)(
    "does not reuse a choice from another %s",
    (key) => {
      const source = metadata([{ id: "1", name: "Highest" }]);
      const readGrant = { ...source.readGrant, [key]: key === "podId" ? "other-pod" : 2 };
      review([{ ...source, readGrant } as ChatToolTranscript]);
      expectRawId();
    },
  );

  it("keeps the old approval's options separate when another Jira Pod is used later", () => {
    const source = metadata([{ id: "1", name: "Highest" }]);
    const other = metadata([{ id: "1", name: "Other instance" }]);
    review([
      source,
      {
        ...other,
        readGrant: { ...other.readGrant, ...BINDING, podId: "other-pod" },
      } as ChatToolTranscript,
    ]);
    expect(screen.getByText("Highest")).toBeVisible();
    expect(screen.queryByText("Other instance")).toBeNull();
  });

  it("does not infer an installation for legacy metadata without a read grant", () => {
    const source = metadata([{ id: "1", name: "Highest" }]);
    review([{ schemaVersion: 1, exchanges: source.exchanges }]);
    expectRawId();
  });

  it("uses the plural mixed-source read-grant projection", () => {
    const source = metadata([{ id: "1", name: "Highest" }]);
    review([{ schemaVersion: 1, exchanges: source.exchanges, readGrants: [source.readGrant!] }]);
    expect(screen.getByText("Highest")).toBeVisible();
  });

  it("does not reuse an old name after a later metadata read removed the choice", () => {
    review([metadata([{ id: "1", name: "Highest" }]), metadata([])]);
    expectRawId();
  });

  it("does not treat a plain text field as a selection", () => {
    review([metadata([{ id: "1", name: "Highest" }], "text")]);
    expectRawId();
  });

  it("does not reuse another field's identically numbered choice", () => {
    review([metadata([{ id: "1", name: "Highest" }], "option", "customfield_9")]);
    expectRawId();
  });

  it("ignores an incomplete metadata read", () => {
    const source = metadata([{ id: "1", name: "Highest" }]);
    review([
      {
        ...source,
        exchanges: source.exchanges.map((exchange) =>
          exchange.call.name === "jira_create_fields"
            ? { ...exchange, result: { ...exchange.result, status: "denied" } }
            : exchange,
        ),
      } as ChatToolTranscript,
    ]);
    expectRawId();
  });

  it("uses an earlier retained Jira grant when a later read does not repeat the disclosure", () => {
    const source = metadata([{ id: "1", name: "Highest" }]);
    review([transcript(), { schemaVersion: 1, exchanges: source.exchanges }]);
    expect(screen.getByText("Highest")).toBeVisible();
  });

  it("leaves the original approved fields, digest and metadata unchanged", () => {
    const source = metadata([{ id: "1", name: "Highest" }]);
    const fields = { summary: "Synthetic", priority: { id: "1" } };
    const before = JSON.stringify([source, fields, APPROVAL]);
    review([source], "jira.draft", fields);
    expect(screen.getByText("Highest")).toBeVisible();
    expect(JSON.stringify([source, fields, APPROVAL])).toBe(before);
  });

  it("shows every member of an explicit contradictory request value", () => {
    review([metadata([{ id: "1", name: "Highest" }])], "jira.draft", {
      summary: "Synthetic",
      priority: { id: "1", name: "Different" },
    });
    expectRawId();
    expect(screen.getByText("Different")).toBeVisible();
  });

  it.each(["jira.edit", "jira.transition"] as const)(
    "uses exactly the matching %s metadata",
    (operation) => {
      const field = {
        id: "priority",
        kind: "option",
        allowedValues: [{ id: "1", name: "Highest" }],
      };
      const source =
        operation === "jira.edit"
          ? read("jira_edit_fields", { issueKey: "TERMIN-1" }, [field])
          : read("jira_transitions", { issueKey: "TERMIN-1" }, [{ id: "31", fields: [field] }]);
      review(
        [transcript(source)],
        operation,
        { priority: { id: "1" } },
        {
          issueKey: "TERMIN-1",
          ...(operation === "jira.transition" ? { transitionId: "31" } : {}),
        },
      );
      expect(screen.getByText("Highest")).toBeVisible();
    },
  );
});
