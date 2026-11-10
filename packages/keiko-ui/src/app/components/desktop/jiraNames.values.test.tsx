import { render, screen, type RenderResult } from "@testing-library/react";
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
const APPROVAL: Extract<ChatToolWriteApprovalView, { kind: "jira-chat-write" }> = {
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
  binding: typeof BINDING = BINDING,
): RenderResult {
  const item = {
    ...target,
    ref: "epic",
    fields,
  };
  return render(
    <ChatJiraNames messages={reads.map((toolTranscript) => ({ toolTranscript }))}>
      <JiraWriteApproval
        approval={{ ...APPROVAL, ...binding, operation }}
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

function namedMetadata(label: string, binding: typeof BINDING = BINDING): ChatToolTranscript {
  const source = transcript(
    read("jira_projects", {}, [{ id: "10000", key: "SHARED", name: `${label} project` }]),
    read("jira_issue_types", { projectKey: "SHARED" }, [{ id: "10002", name: `${label} type` }]),
    read("jira_create_fields", { projectKey: "SHARED", issueTypeId: "10002" }, [
      {
        id: "priority",
        name: `${label} field`,
        kind: "option",
        allowedValues: [{ id: "1", name: `${label} value` }],
      },
    ]),
  );
  if (source.readGrant?.kind !== "jira-chat-read") throw new Error("Expected a Jira read grant");
  return { ...source, readGrant: { ...source.readGrant, ...binding } };
}

function expectNames(container: HTMLElement, label: string): void {
  for (const kind of ["project", "type", "field", "value"])
    expect(container).toHaveTextContent(`${label} ${kind}`);
}

function expectNoNames(container: HTMLElement, label: string): void {
  for (const kind of ["project", "type", "field", "value"])
    expect(container).not.toHaveTextContent(`${label} ${kind}`);
}

describe("Jira approval names stay with their metadata binding", () => {
  const otherBinding = { ...BINDING, podId: "22222222-2222-4222-8222-222222222222" };

  it.each(["jira.create", "jira.draft"] as const)(
    "keeps both Pods' names and values separate for %s with identical ids",
    (operation) => {
      const reads = [namedMetadata("A"), namedMetadata("B", otherBinding)];
      const first = review(reads, operation);
      expectNames(first.container, "A");
      expectNoNames(first.container, "B");
      first.unmount();
      const second = review(reads, operation, undefined, undefined, otherBinding);
      expectNames(second.container, "B");
      expectNoNames(second.container, "A");
    },
  );

  it.each(["bindingGeneration", "authenticationGeneration"] as const)(
    "does not reuse names from another %s",
    (key) => {
      const view = review([namedMetadata("A"), namedMetadata("Other", { ...BINDING, [key]: 2 })]);
      expectNames(view.container, "A");
      expectNoNames(view.container, "Other");
    },
  );

  it("uses the latest read in the same retained binding after another Pod was read", () => {
    const latest = namedMetadata("Latest");
    const view = review([
      namedMetadata("Old"),
      { schemaVersion: 1, exchanges: latest.exchanges },
      namedMetadata("B", otherBinding),
    ]);
    expectNames(view.container, "Latest");
    expectNoNames(view.container, "Old");
    expectNoNames(view.container, "B");
  });

  it.each(["another Pod", "no read grant"])(
    "keeps ids visible when the metadata has %s",
    (source) => {
      const metadata = namedMetadata("Other", otherBinding);
      const view = review([
        source === "another Pod" ? metadata : { schemaVersion: 1, exchanges: metadata.exchanges },
      ]);
      expect(view.container).toHaveTextContent("Project 10000 · Issue type 10002");
      expect(screen.getByText("Priority")).toBeVisible();
      expect(screen.queryByText("priority", { exact: true })).toBeNull();
      expect(screen.getByText("1", { exact: true })).toBeVisible();
      expectNoNames(view.container, "Other");
    },
  );
});

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
