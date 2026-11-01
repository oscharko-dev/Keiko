import { render, screen, waitFor, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import { ApiError } from "@/lib/api";
import type {
  decideJiraChatWriteApproval,
  getJiraStagedDraft,
} from "@/lib/atlassian-connectors-api";
import { JiraWriteApproval } from "./JiraWriteApproval";

// Epic #4173, child #4178: "A draft of any size is approved once; the approval never shows raw
// JSON." A large draft is staged in pages and its call carries only the draft's id and digest, so
// the card must read the staged items - all of them - before the human can approve.
const DIGEST = "d".repeat(64);
const DRAFT_ID = "11111111-2222-4333-8444-555555555555";
const JSON_SHAPE = /[{}[\]]|"[^"\s]+"\s*:/u;

function approval(): ChatToolWriteApprovalView {
  return {
    kind: "jira-chat-write",
    approvalId: "approval-draft",
    chatId: "chat-7",
    podId: "11111111-1111-4111-8111-111111111111",
    bindingGeneration: 1,
    authenticationGeneration: 1,
    invocationId: "action-1",
    operation: "jira.draft",
    actionDigest: "a".repeat(64),
    requestedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    state: "pending",
  };
}
const call = {
  id: "call-1",
  name: "jira_draft",
  arguments: { draftId: DRAFT_ID, draftDigest: DIGEST },
};

function stagedItems(count: number): readonly Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    ref: `item-${String(index)}`,
    projectId: "10000",
    issueTypeId: "10002",
    fields: { summary: `Staged story ${String(index)}` },
    ...(index === 0 ? {} : { parent: { fieldId: "parent", ref: "item-0" } }),
  }));
}

type Load = typeof getJiraStagedDraft;
type Decide = typeof decideJiraChatWriteApproval;

function renderStaged(
  load: Load,
  decide: Decide = vi.fn<Decide>(),
): RenderResult & { readonly view: ChatToolWriteApprovalView } {
  const view = approval();
  const rendered = render(
    <JiraWriteApproval
      approval={view}
      call={call}
      turnState="pending"
      observe={vi.fn().mockResolvedValue(view)}
      decide={decide}
      loadDraft={load}
    />,
  );
  return { ...rendered, view };
}

describe("a staged Jira backlog draft is reviewed and approved once (#4178)", () => {
  it("reads all 120 staged items for the digest the call carries and shows them as a list", async () => {
    const load = vi.fn<Load>().mockResolvedValue({ draftDigest: DIGEST, items: stagedItems(120) });
    const { container } = renderStaged(load);
    expect(load).toHaveBeenCalledWith(DRAFT_ID, "chat-7", DIGEST);
    await waitFor(() =>
      expect(screen.getByText("Issues to create (120 of 120 selected)")).toBeInTheDocument(),
    );
    expect(screen.getByText("Staged story 119")).toBeInTheDocument();
    const region = screen.getByRole("region", { name: "Review Jira action" });
    expect(region.textContent).not.toMatch(JSON_SHAPE);
    expect(region.textContent).not.toContain(DRAFT_ID);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("approves the whole draft with one decision, carrying only a deselection", async () => {
    const load = vi.fn<Load>().mockResolvedValue({ draftDigest: DIGEST, items: stagedItems(40) });
    const decide = vi
      .fn<Decide>()
      .mockImplementation((view) => Promise.resolve({ ...view, state: "approved" }));
    const { view } = renderStaged(load, decide);
    const approve = await screen.findByRole("button", { name: "Approve this action" });
    await waitFor(() => expect(approve).toBeEnabled());
    await userEvent.click(approve);
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    expect(decide).toHaveBeenCalledWith(view, "approve", []);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("cannot be approved while the items are loading, and says so", () => {
    renderStaged(vi.fn<Load>().mockReturnValue(new Promise(() => undefined)));
    expect(screen.getByText(/Loading the draft/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve this action" })).toBeDisabled();
  });

  it("cannot be approved when the draft is no longer available, but can be declined", async () => {
    const load = vi
      .fn<Load>()
      .mockRejectedValue(new ApiError("JIRA_DRAFT_UNAVAILABLE", "gone", 404));
    const { container } = renderStaged(load);
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer available");
    expect(screen.getByRole("button", { name: "Approve this action" })).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Decline this action" })).toBeEnabled(),
    );
    expect(screen.queryByText(DRAFT_ID)).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
});
