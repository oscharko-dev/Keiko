import { act, render, screen, waitFor } from "@testing-library/react";
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
    expect(screen.getByLabelText("Proposed action details")).toHaveValue(
      JSON.stringify(call.arguments, null, 2),
    );
    expect(observe).toHaveBeenCalledExactlyOnceWith(view.approvalId);
    expect(decide).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByLabelText("Proposed action details")).toHaveFocus();
    await user.tab();
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
