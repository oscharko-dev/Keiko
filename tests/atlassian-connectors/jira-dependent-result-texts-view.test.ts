import { beforeAll, describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { JiraMutationAttempt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { checkJiraManagedMutation } from "../../packages/keiko-connectors/src/jira-managed-mutations.js";
import { jiraApprovalExpiredResult } from "../../packages/keiko-server/src/atlassian/jiraApprovalExpiry.js";
import { jiraAttemptToolResult } from "../../packages/keiko-server/src/atlassian/jiraMutationResult.js";

// #4355 AC5/AC6: the card's texts for the refusals the #4354 write path produces. The results here are
// built by the production builders (the expiry result, the attempt-to-result mapper, the executor's
// own release-scope check), and the card's own view reads them, so a change of a producer that the
// card does not follow turns this red. The rendering and the languages are proven in
// packages/keiko-ui/.../JiraChatTools.dependent-texts.test.tsx.
const UI_OUTCOME_MODULE = "../../packages/keiko-ui/src/app/components/desktop/jira-tool-outcome.ts";

interface OutcomeView {
  readonly failure?: string;
  readonly rules: readonly { readonly ruleId: string; readonly subject: string }[];
  readonly templateNotices: readonly { readonly ruleId: string; readonly subject: string }[];
  readonly problems: readonly { readonly message: string }[];
}
type OutcomeViewer = (exchange: ChatToolExchange) => OutcomeView;
let view: OutcomeViewer;
type Dispatch = (input: {
  readonly approval: { readonly state: string };
  readonly result: unknown;
  readonly turnState: string | undefined;
}) => "not-dispatched" | "unknown";
let dispatchOf: Dispatch;
const UI_DISPATCH_MODULE =
  "../../packages/keiko-ui/src/app/components/desktop/jira-approval-dispatch.ts";
beforeAll(async () => {
  const dispatchModule: unknown = await import(UI_DISPATCH_MODULE);
  if (
    typeof dispatchModule !== "object" ||
    dispatchModule === null ||
    !("jiraApprovalDispatch" in dispatchModule) ||
    typeof dispatchModule.jiraApprovalDispatch !== "function"
  )
    throw new TypeError("jira-approval-dispatch.ts does not export jiraApprovalDispatch");
  dispatchOf = dispatchModule.jiraApprovalDispatch as Dispatch;
  const loaded: unknown = await import(UI_OUTCOME_MODULE);
  if (
    typeof loaded !== "object" ||
    loaded === null ||
    !("jiraToolOutcomeView" in loaded) ||
    typeof loaded.jiraToolOutcomeView !== "function"
  )
    throw new TypeError("jira-tool-outcome.ts does not export jiraToolOutcomeView");
  view = loaded.jiraToolOutcomeView as OutcomeViewer;
});

function exchangeOf(
  name: string,
  data: unknown,
  approval?: { readonly state: string },
): ChatToolExchange {
  return {
    call: { id: "call-1", name, arguments: {} },
    result: { status: "completed", data },
    ...(approval === undefined ? {} : { approval }),
  } as unknown as ChatToolExchange;
}

describe("the refusals of the write path as the Chat card reads them", () => {
  it("reads a create refused for a missing template as a rule with its issue type", () => {
    const attempt: JiraMutationAttempt = {
      ok: false,
      reason: "field-validation",
      violations: [{ ruleId: "template-missing", subject: "Story", template: "SYN/Story" }],
    };
    const { data } = jiraAttemptToolResult("rejected", attempt);
    expect(view(exchangeOf("jira_create", data)).rules).toEqual([
      { ruleId: "template-missing", subject: "Story" },
    ]);
  });

  it("reads the rules a succeeded edit left broken as notices, not as refusals", () => {
    const attempt: JiraMutationAttempt = {
      ok: true,
      receipt: { issueKey: "SYN-1" },
      templateNotices: [
        { ruleId: "label-count", subject: "labels", template: "SYN/Story" },
        { ruleId: "field-missing", subject: "Fix version", template: "SYN/Story" },
      ],
    };
    const { data } = jiraAttemptToolResult("succeeded", attempt);
    const shown = view(exchangeOf("jira_edit", data));
    expect(shown.templateNotices).toEqual([
      { ruleId: "label-count", subject: "labels" },
      { ruleId: "field-missing", subject: "Fix version" },
    ]);
    expect(shown.rules).toEqual([]);
    // The model-facing guidance is not a card text.
    expect(JSON.stringify(shown)).not.toContain("Tell the person plainly");
  });

  it("keeps an edit without notices free of them", () => {
    const { data } = jiraAttemptToolResult("succeeded", {
      ok: true,
      receipt: { issueKey: "SYN-1" },
    });
    expect(view(exchangeOf("jira_edit", data)).templateNotices).toEqual([]);
  });

  it("reads the release switch's refusal of an attachment as its own sentence, once", async () => {
    const refusal = await checkJiraManagedMutation("jira.attach", {}, {} as never, {} as never);
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    const { data } = jiraAttemptToolResult("rejected", {
      ok: false,
      reason: refusal.reason,
      ...(refusal.detail === undefined ? {} : { detail: refusal.detail }),
    });
    const shown = view(exchangeOf("jira_attach", data));
    expect(shown.failure).toBe("chat.jira.outcome.failure.releaseScope");
    expect(shown.problems).toEqual([]);
  });

  // The card says "nothing was changed" only against evidence that no write was dispatched: the
  // producer's own not-dispatched result, never the clock (audit of 3847c53a2).
  it("decides the approval hint from the producer's result, not from the state", () => {
    const expired = { status: "completed", data: jiraApprovalExpiredResult(undefined) };
    const ran = {
      status: "completed",
      data: jiraAttemptToolResult("succeeded", { ok: true, receipt: { issueKey: "SYN-1" } }).data,
    };
    for (const state of ["approved", "claimed", "expired", "revoked"])
      expect(dispatchOf({ approval: { state }, result: expired, turnState: "completed" })).toBe(
        "not-dispatched",
      );
    for (const state of ["approved", "claimed", "expired", "revoked"])
      expect(dispatchOf({ approval: { state }, result: ran, turnState: "completed" })).toBe(
        "unknown",
      );
    expect(
      dispatchOf({ approval: { state: "approved" }, result: undefined, turnState: "completed" }),
    ).toBe("unknown");
    // A revoke can hit a claimed write in flight and an eviction can expire an approved or claimed
    // one, so neither proves that nothing ran; only a declined approval does (actionApprovals.ts).
    for (const turnState of ["pending", "completed"]) {
      expect(dispatchOf({ approval: { state: "revoked" }, result: undefined, turnState })).toBe(
        "unknown",
      );
      expect(dispatchOf({ approval: { state: "expired" }, result: undefined, turnState })).toBe(
        "unknown",
      );
      expect(dispatchOf({ approval: { state: "rejected" }, result: undefined, turnState })).toBe(
        "not-dispatched",
      );
    }
    expect(
      dispatchOf({ approval: { state: "pending" }, result: undefined, turnState: "completed" }),
    ).toBe("not-dispatched");
    expect(
      dispatchOf({ approval: { state: "pending" }, result: undefined, turnState: "pending" }),
    ).toBe("unknown");
  });

  it.each(["expired", "revoked"])(
    "adds no connection failure to an approval that ended %s",
    (state) => {
      const data = jiraApprovalExpiredResult(undefined);
      expect(view(exchangeOf("jira_edit", data, { state })).failure).toBeUndefined();
    },
  );
});
