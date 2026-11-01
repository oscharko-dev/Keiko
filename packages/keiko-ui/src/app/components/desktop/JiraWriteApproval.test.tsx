import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import { JiraWriteApproval } from "./JiraWriteApproval";
import { I18N_STORAGE_KEY, I18nProvider } from "@/lib/i18n";
import { ApiError } from "@/lib/api";
import * as diagnostics from "@/lib/client-diagnostics";
import { expectDiagnosticWireAccepted } from "@/test-utils/diagnostic-wire";

const call = {
  id: "call-1",
  name: "jira_edit",
  arguments: { issueKey: "LAB-1", fields: { summary: "Reviewed change" } },
};
function approval(id = "approval-1"): ChatToolWriteApprovalView {
  return {
    kind: "jira-chat-write",
    approvalId: id,
    chatId: "chat-1",
    podId: "11111111-1111-4111-8111-111111111111",
    bindingGeneration: 1,
    authenticationGeneration: 1,
    invocationId: "action-1",
    operation: "jira.edit",
    actionDigest: "a".repeat(64),
    requestedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    state: "pending",
  };
}
afterEach(() => {
  vi.useRealTimers();
});
async function ready(): Promise<void> {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Approve this action" })).toBeEnabled(),
  );
}
describe("Jira Chat write approvals", () => {
  it("checks current actionability, shows the exact action and requires explicit keyboard approval", async () => {
    const view = approval();
    const observe = vi.fn().mockResolvedValue(view);
    const decide = vi.fn().mockResolvedValue({ ...view, state: "approved" });
    const { container } = render(
      <JiraWriteApproval
        approval={view}
        call={call}
        turnState="pending"
        observe={observe}
        decide={decide}
      />,
    );
    expect(screen.getByRole("button", { name: "Approve this action" })).toBeDisabled();
    await ready();
    const details = screen.getByRole("group", { name: "Proposed action details" });
    expect(details).toHaveTextContent("Issue");
    expect(details).toHaveTextContent("LAB-1");
    expect(details).toHaveTextContent("summary");
    expect(details).toHaveTextContent("Reviewed change");
    expect(observe).toHaveBeenCalledExactlyOnceWith(view.approvalId);
    expect(decide).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole("button", { name: "Approve this action" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Approved for this action")).toBeVisible();
    expect(decide).toHaveBeenCalledExactlyOnceWith(view, "approve");
    expect(screen.queryByText("Jira change confirmed")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
  it("keeps a failed decision unavailable until a state-only refresh and never retries the POST", async () => {
    const diagnostic = vi.spyOn(diagnostics, "reportClientDiagnostic");
    const view = approval();
    const observe = vi
      .fn()
      .mockResolvedValueOnce(view)
      .mockResolvedValue({ ...view, state: "claimed" });
    const failure = new ApiError("INTERNAL", "synthetic-private-decision-token", 503);
    failure.correlationId = "jira-decision-request-1";
    const decide = vi.fn().mockRejectedValue(failure);
    render(
      <JiraWriteApproval
        approval={view}
        call={call}
        turnState="pending"
        observe={observe}
        decide={decide}
      />,
    );
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Approve this action" }));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(diagnostic).toHaveBeenCalledWith(
      "Jira Chat decision failed.",
      expect.objectContaining({
        correlationId: failure.correlationId,
        kind: "other",
      }),
    );
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(failure.message);
    await expectDiagnosticWireAccepted(
      diagnostic.mock.calls.map(([message, meta]) => ({ message, meta })),
    );
    expect(screen.getByRole("button", { name: "Approve this action" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Approve this action" }));
    await userEvent.click(screen.getByRole("button", { name: "Refresh action state" }));
    expect(await screen.findByText("Approval used for this action")).toBeVisible();
    expect(decide).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledTimes(2);
  });
  it("does not offer a restored approval when the current server record is unavailable", async () => {
    const decide = vi.fn();
    render(
      <JiraWriteApproval
        approval={approval()}
        call={call}
        turnState="pending"
        observe={vi.fn().mockRejectedValue(new Error("synthetic missing registry"))}
        decide={decide}
      />,
    );
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.getByText("Action approval is currently unavailable")).toBeVisible();
    expect(screen.getByRole("button", { name: "Approve this action" })).toBeDisabled();
    expect(decide).not.toHaveBeenCalled();
  });
  it("supports rejection and preserves server revocation over a prior approval", async () => {
    const view = approval();
    const observe = vi.fn().mockResolvedValue(view);
    const decide = vi.fn().mockResolvedValue({ ...view, state: "rejected" });
    const { rerender } = render(
      <JiraWriteApproval
        approval={view}
        call={call}
        turnState="pending"
        observe={observe}
        decide={decide}
      />,
    );
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Decline this action" }));
    expect(await screen.findByText("Action declined")).toBeVisible();
    expect(decide).toHaveBeenCalledExactlyOnceWith(view, "reject");
    rerender(
      <JiraWriteApproval
        approval={{ ...view, state: "revoked" }}
        call={call}
        turnState="pending"
        observe={observe}
        decide={decide}
      />,
    );
    expect(screen.getByText("Action approval revoked")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve this action" })).toBeNull();
  });
  it("expires locally without granting or repeating an action", async () => {
    vi.useFakeTimers();
    const view = approval();
    const decide = vi.fn();
    render(
      <JiraWriteApproval
        approval={view}
        call={call}
        turnState="pending"
        observe={vi.fn().mockResolvedValue(view)}
        decide={decide}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60001);
    });
    expect(screen.getByText("Action approval expired")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve this action" })).toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });
  it("cannot act on a terminal turn even if a historical approval says pending", async () => {
    const view = approval();
    const observe = vi.fn().mockResolvedValue(view);
    const decide = vi.fn();
    render(
      <JiraWriteApproval
        approval={view}
        call={call}
        turnState="cancelled"
        observe={observe}
        decide={decide}
      />,
    );
    await waitFor(() => expect(observe).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "Approve this action" })).toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });
});

it("discards a late GET from a previously displayed approval", async () => {
  const first = approval();
  const second = { ...approval("approval-2"), actionDigest: "b".repeat(64) };
  const releases: Array<(view: ChatToolWriteApprovalView) => void> = [];
  const observe = vi.fn(
    () => new Promise<ChatToolWriteApprovalView>((resolve) => releases.push(resolve)),
  );
  const decide = vi.fn();
  const { rerender } = render(
    <JiraWriteApproval
      approval={first}
      call={call}
      turnState="pending"
      observe={observe}
      decide={decide}
    />,
  );
  rerender(
    <JiraWriteApproval
      approval={second}
      call={call}
      turnState="pending"
      observe={observe}
      decide={decide}
    />,
  );
  expect(observe).toHaveBeenCalledTimes(2);
  await act(async () => {
    releases[0]?.({ ...first, state: "approved" });
  });
  expect(screen.getByRole("button", { name: "Approve this action" })).toBeDisabled();
  await act(async () => {
    releases[1]?.(second);
  });
  await ready();
  expect(screen.queryByText("Approved for this action")).toBeNull();
  expect(decide).not.toHaveBeenCalled();
});

it("blocks duplicate submissions and ignores a late POST result from the previous action", async () => {
  const first = approval();
  const second = approval("approval-2");
  const observe = vi.fn((id: string) => Promise.resolve(approval(id)));
  const releases: Array<(view: ChatToolWriteApprovalView) => void> = [];
  const decide = vi.fn(
    () => new Promise<ChatToolWriteApprovalView>((resolve) => releases.push(resolve)),
  );
  const { rerender } = render(
    <JiraWriteApproval
      approval={first}
      call={call}
      turnState="pending"
      observe={observe}
      decide={decide}
    />,
  );
  await ready();
  await userEvent.click(screen.getByRole("button", { name: "Approve this action" }));
  await userEvent.click(screen.getByRole("button", { name: "Approve this action" }));
  expect(decide).toHaveBeenCalledOnce();
  rerender(
    <JiraWriteApproval
      approval={second}
      call={call}
      turnState="pending"
      observe={observe}
      decide={decide}
    />,
  );
  await ready();
  await act(async () => {
    releases[0]?.({ ...first, state: "approved" });
  });
  expect(screen.getByRole("button", { name: "Approve this action" })).toBeEnabled();
  expect(screen.queryByText("Approved for this action")).toBeNull();
});

it("offers the action preview and decision in German without accessibility violations", async () => {
  window.localStorage.setItem(I18N_STORAGE_KEY, "de");
  const view = approval();
  try {
    const { container } = render(
      <I18nProvider>
        <JiraWriteApproval
          approval={view}
          call={call}
          turnState="pending"
          observe={vi.fn().mockResolvedValue(view)}
          decide={vi.fn()}
        />
      </I18nProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Diese Aktion genehmigen" })).toBeEnabled(),
    );
    expect(screen.getByLabelText("Details der vorgeschlagenen Aktion")).toHaveTextContent(
      "Reviewed change",
    );
    expect(screen.getByRole("button", { name: "Diese Aktion ablehnen" })).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  } finally {
    window.localStorage.removeItem(I18N_STORAGE_KEY);
  }
});

it("reviews a configured MCP action and its arguments through the existing approval controls", async () => {
  const view: ChatToolWriteApprovalView = {
    kind: "mcp-chat-write",
    approvalId: "mcp-approval",
    chatId: "chat-1",
    configurationDigest: "a".repeat(64),
    invocationId: "mcp-call",
    operation: "mcp_fixture_create_note",
    actionDigest: "b".repeat(64),
    requestedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    state: "pending",
  };
  const observe = vi.fn().mockResolvedValue(view);
  const decide = vi.fn().mockResolvedValue({ ...view, state: "approved" });
  const { container } = render(
    <JiraWriteApproval
      approval={view}
      call={{
        id: "mcp-call",
        name: "mcp_fixture_create_note",
        arguments: { text: "Synthetic note" },
      }}
      turnState="pending"
      observe={observe}
      decide={decide}
    />,
  );
  await ready();
  expect(screen.getByRole("region", { name: "Approve MCP action" })).toBeVisible();
  expect(screen.getByText("mcp_fixture_create_note")).toBeVisible();
  const details = screen.getByRole("group", { name: "Proposed action details" });
  expect(details).toHaveTextContent("text");
  expect(details).toHaveTextContent("Synthetic note");
  expect(details.textContent).not.toMatch(/[{}"]/u);
  await userEvent.click(screen.getByRole("button", { name: "Approve this action" }));
  expect(decide).toHaveBeenCalledExactlyOnceWith(view, "approve");
  expect(await screen.findByText("Approved for this action")).toBeVisible();
  expect(await axe(container)).toHaveNoViolations();
});

describe("Jira backlog draft approval (#4178)", () => {
  const draftCall = {
    id: "draft-call",
    name: "jira_draft",
    arguments: {
      items: [
        { ref: "epic", projectId: "10000", issueTypeId: "10001", fields: { summary: "Epic A" } },
        {
          ref: "story",
          projectId: "10000",
          issueTypeId: "10002",
          fields: { summary: "Story B", description: "Synthetic" },
          parent: { fieldId: "customfield_10100", ref: "epic" },
        },
        {
          ref: "bug",
          projectId: "10000",
          issueTypeId: "10003",
          fields: { summary: "Bug C" },
          links: [{ type: "Blocks", direction: "outward", ref: "story" }],
        },
        { ref: "loose", projectId: "10000", issueTypeId: "10002", fields: { summary: "Task D" } },
      ],
    },
  };
  function draftApproval(): ChatToolWriteApprovalView {
    return { ...approval("draft-approval"), operation: "jira.draft" };
  }

  it("shows the draft as a tree, carries a deselection with its dependents, and sends only the choice", async () => {
    const view = draftApproval();
    const decide = vi.fn().mockResolvedValue({
      ...view,
      state: "approved",
      excludedItemRefs: ["story"],
    });
    const { container } = render(
      <JiraWriteApproval
        approval={view}
        call={draftCall}
        turnState="pending"
        observe={vi.fn().mockResolvedValue(view)}
        decide={decide}
      />,
    );
    await ready();
    expect(screen.getByRole("group", { name: "Issues to create (4 of 4 selected)" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /Story B/u })).toBeChecked();
    expect(screen.getByText("Blocks → story")).toBeVisible();
    expect(screen.getByText("description")).toBeVisible();
    expect(screen.getByText("Synthetic")).toBeVisible();
    await userEvent.click(screen.getByRole("checkbox", { name: /Story B/u }));
    expect(screen.getByRole("group", { name: "Issues to create (2 of 4 selected)" })).toBeVisible();
    const bug = screen.getByRole("checkbox", { name: /Bug C/u });
    expect(bug).not.toBeChecked();
    expect(bug).toBeDisabled();
    expect(screen.getByText("Left out because an issue it depends on is left out")).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
    await userEvent.click(screen.getByRole("button", { name: "Approve this action" }));
    expect(decide).toHaveBeenCalledExactlyOnceWith(view, "approve", ["story"]);
    expect(await screen.findByText("Approved for this action")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /Epic A/u })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Bug C/u })).not.toBeChecked();
  });

  it("cannot approve a draft with every item left out, but can still decline it", async () => {
    const view = draftApproval();
    render(
      <JiraWriteApproval
        approval={view}
        call={draftCall}
        turnState="pending"
        observe={vi.fn().mockResolvedValue(view)}
        decide={vi.fn()}
      />,
    );
    await ready();
    await userEvent.click(screen.getByRole("checkbox", { name: /Epic A/u }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Task D/u }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Bug C/u }));
    expect(screen.getByRole("button", { name: "Approve this action" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Decline this action" })).toBeEnabled();
  });

  describe("shows what the exact request would create", () => {
    const base = {
      ref: "task",
      projectId: "10000",
      issueTypeId: "10002",
      fields: { summary: "Same summary", description: "Same description" },
      parent: { fieldId: "parent", issueKey: "SYN-7" },
    };
    function review(item: Record<string, unknown>): string {
      const view = draftApproval();
      const { container, unmount } = render(
        <JiraWriteApproval
          approval={view}
          call={{ ...draftCall, arguments: { items: [item] } }}
          turnState="pending"
          observe={vi.fn().mockResolvedValue(view)}
          decide={vi.fn()}
        />,
      );
      const shown = container.querySelector("fieldset")?.textContent ?? "";
      unmount();
      return shown;
    }

    it.each([
      ["target project", { projectId: "10001" }, "Project 10001"],
      ["issue type", { issueTypeId: "10003" }, "Issue type 10003"],
      [
        "relation field",
        { parent: { fieldId: "customfield_10100", issueKey: "SYN-7" } },
        "customfield_10100",
      ],
      ["relation target", { parent: { fieldId: "parent", issueKey: "SYN-8" } }, "SYN-8"],
      [
        "field value",
        { fields: { summary: "Same summary", description: "Another description" } },
        "Another description",
      ],
      [
        "assignee",
        {
          fields: {
            summary: "Same summary",
            description: "Same description",
            assignee: { name: "jdoe" },
          },
        },
        "jdoe",
      ],
    ])("renders drafts that differ only in the %s differently", (_name, change, shown) => {
      const original = review(base);
      const changed = review({ ...base, ...change });
      expect(original).toContain("Project 10000 · Issue type 10002");
      expect(original).toContain("Parent (parent): SYN-7");
      expect(original).toContain("Same description");
      expect(changed).not.toBe(original);
      expect(changed).toContain(shown);
    });

    it("lists arrays, reads users and options by name and expands long text in place", async () => {
      const long = `${"Long description. ".repeat(20)}End of text`;
      const view = draftApproval();
      const { container } = render(
        <JiraWriteApproval
          approval={view}
          call={{
            ...draftCall,
            arguments: {
              items: [
                {
                  ...base,
                  fields: {
                    summary: "Same summary",
                    description: long,
                    labels: ["alpha", "beta"],
                    assignee: { name: "jdoe" },
                    priority: { value: "High" },
                    custom: { a: 1, b: 2 },
                  },
                },
              ],
            },
          }}
          turnState="pending"
          observe={vi.fn().mockResolvedValue(view)}
          decide={vi.fn()}
        />,
      );
      await ready();
      expect(screen.getByText("alpha")).toBeVisible();
      expect(screen.getByText("beta")).toBeVisible();
      expect(screen.getByText("jdoe")).toBeVisible();
      expect(screen.getByText("High")).toBeVisible();
      expect(screen.getByText("custom")).toBeVisible();
      expect(screen.getByText("a")).toBeVisible();
      expect(screen.getByText("2")).toBeVisible();
      expect(
        within(screen.getByRole("group", { name: /Issues to create/u })).queryByText(
          /End of text/u,
        ),
      ).toBeNull();
      const more = screen.getByRole("button", { name: "Show more" });
      expect(more).toHaveAttribute("aria-expanded", "false");
      await userEvent.click(more);
      expect(
        within(screen.getByRole("group", { name: /Issues to create/u })).getByText(/End of text/u),
      ).toBeVisible();
      expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});

it("shows an attachment approval's file by name, size and digest, never its content (#4176)", async () => {
  const view: ChatToolWriteApprovalView = {
    kind: "jira-chat-write",
    approvalId: "approval-attach",
    chatId: "chat-1",
    podId: "11111111-1111-4111-8111-111111111111",
    bindingGeneration: 1,
    authenticationGeneration: 1,
    invocationId: "action-attach",
    actionDigest: "a".repeat(64),
    requestedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    state: "pending",
    operation: "jira.attach",
    attachment: { name: "report.txt", sizeBytes: 12345, sha256: "b".repeat(64) },
  };
  const observe = vi.fn().mockResolvedValue(view);
  const { container } = render(
    <JiraWriteApproval
      approval={view}
      call={{
        id: "call-2",
        name: "jira_attach",
        arguments: {
          issueKey: "LAB-1",
          source: { kind: "connected-file", path: "docs/report.txt" },
        },
      }}
      turnState="pending"
      observe={observe}
      decide={vi.fn()}
    />,
  );
  await ready();
  const facts = screen.getByRole("list", { name: "Proposed action details" });
  expect(facts).toHaveTextContent("report.txt");
  expect(facts).toHaveTextContent(`${new Intl.NumberFormat().format(12345)} B`);
  expect(facts).toHaveTextContent(`sha256 ${"b".repeat(64)}`);
  expect(await axe(container)).toHaveNoViolations();
});
it("renders no file facts for an approval that carries no attachment", async () => {
  render(
    <JiraWriteApproval
      approval={approval()}
      call={call}
      turnState="pending"
      observe={vi.fn().mockResolvedValue(approval())}
      decide={vi.fn()}
    />,
  );
  await ready();
  expect(screen.queryByRole("list")).toBeNull();
});
