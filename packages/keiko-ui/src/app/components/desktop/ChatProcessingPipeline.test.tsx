import userEvent from "@testing-library/user-event";
import { render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";
import type {
  ChatToolExchange,
  ChatToolTranscript,
  ChatTurnState,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import { ChatProcessingPipeline } from "./ChatProcessingPipeline";
import { chatProcessingSteps, type ChatProcessingStep } from "./chat-processing-pipeline";
import { JiraChatTools } from "./JiraChatTools";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";

function call(name = "knowledge_requirements", id = "read-1"): ChatToolExchange {
  return { call: { id, name, arguments: { view: "units" } } };
}

function completed(exchange = call()): ChatToolExchange {
  return {
    ...exchange,
    result: {
      schemaVersion: 1,
      invocationId: "invocation-1",
      toolRef: null,
      projectionDigest: null,
      effectStarted: false,
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
      status: "completed",
      reason: "none",
      page: { truncated: false, reason: "none", cursor: null },
      data: {},
    },
  };
}

const approval: ChatToolWriteApprovalView = {
  kind: "jira-chat-write",
  approvalId: "approval-1",
  chatId: "chat-1",
  podId: "11111111-1111-4111-8111-111111111111",
  bindingGeneration: 1,
  authenticationGeneration: 1,
  invocationId: "action-1",
  operation: "jira.create",
  actionDigest: "a".repeat(64),
  requestedAt: 1,
  expiresAt: 2,
  state: "pending",
};

function transcript(...exchanges: readonly ChatToolExchange[]): ChatToolTranscript {
  return { schemaVersion: 1, exchanges };
}

describe("observed Chat processing steps", () => {
  it.each(["constructor", "toString", "__proto__"])(
    "does not use inherited view labels for %s",
    (view) => {
      for (const [name, label] of [
        ["knowledge_requirements", "chat.processing.requirements"],
        ["knowledge_documents", "chat.processing.documents"],
      ] as const) {
        const exchange = { call: { ...call(name).call, arguments: { view } } };
        expect(chatProcessingSteps(transcript(exchange), "pending", false)[1]?.label).toBe(label);
      }
    },
  );
  it("starts before the first tool event only for an explicitly enabled pending human turn", () => {
    expect(chatProcessingSteps(undefined, "pending", false)).toEqual([]);
    expect(chatProcessingSteps(transcript(), undefined, true)).toEqual([]);
    expect(chatProcessingSteps(undefined, "completed", true)).toEqual([]);
    expect(chatProcessingSteps(undefined, "pending", true).map((step) => step.state)).toEqual([
      "done",
      "active",
      "upcoming",
    ]);
    render(<JiraChatTools transcript={undefined} turnState="pending" showPending />);
    expect(screen.getByRole("region", { name: "Progress" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Current step: Preparing next step");
  });

  it("does not claim processing is active while the acknowledged turn waits for the human", () => {
    const steps = chatProcessingSteps(transcript(call()), "pending", false, true);
    expect(steps.some((step) => step.state === "active")).toBe(false);
    expect(steps).toContainEqual({
      id: "decision",
      label: "chat.processing.approval",
      state: "approval",
    });
    expect(steps[0]).toEqual({ id: "request", label: "chat.processing.request", state: "done" });
  });

  it("shows actual tools and preparation between tool calls without predicting Jira creation", () => {
    const steps = chatProcessingSteps(
      transcript(completed(), completed(call("jira_projects", "projects"))),
      "pending",
      false,
    );
    expect(steps.map((step) => step.state)).toEqual(["done", "done", "done", "active", "upcoming"]);
    expect(steps.map((step) => step.label)).not.toContain("chat.jira.writeApproval.title");
    expect(steps).toHaveLength(5);
    render(<ChatProcessingPipeline steps={steps} />);
    expect(screen.getByRole("listitem", { current: "step" })).toHaveTextContent(
      "Preparing next step",
    );
    expect(screen.queryByText(/create|publish/iu)).toBeNull();
  });

  it.each([
    ["pending", "active", "upcoming"],
    ["failed", "attention", "failed"],
    ["cancelled", "cancelled", "cancelled"],
  ] as const)("retains unfinished reads when the turn is %s", (turnState, toolState, endState) => {
    const steps = chatProcessingSteps(transcript(call()), turnState, false);
    expect(steps[1]?.state).toBe(toolState);
    expect(steps.at(-1)?.state).toBe(endState);
    if (turnState !== "pending") expect(steps.some((step) => step.state === "active")).toBe(false);
  });

  it.each(["pending", "rejected", "expired", "revoked"] as const)(
    "reflects %s approval without pretending execution or remote success",
    (state) => {
      const exchange = { ...call("jira_create"), approval: { ...approval, state } };
      const steps = chatProcessingSteps(transcript(exchange), "pending", false);
      expect(steps[1]?.state).toBe(state === "pending" ? "approval" : "blocked");
    },
  );

  it.each(["completed", "failed", "cancelled"] as const)(
    "stops waiting for an undecided approval after the turn is %s",
    (turnState) => {
      const exchange = { ...call("jira_create"), approval };
      expect(chatProcessingSteps(transcript(exchange), turnState, false)[1]?.state).toBe("blocked");
    },
  );

  it("does not infer remote MCP success from an approved action's transport result", () => {
    const exchange: ChatToolExchange = {
      ...completed(call("mcp_fixture_create")),
      approval: {
        kind: "mcp-chat-write",
        approvalId: "mcp-approval",
        chatId: "chat-1",
        operation: "mcp.fixture.create",
        configurationDigest: "a".repeat(64),
        invocationId: "mcp-invocation",
        actionDigest: "b".repeat(64),
        requestedAt: 1,
        expiresAt: 2,
        state: "approved",
      },
    };
    expect(chatProcessingSteps(transcript(exchange), "completed", false)[1]?.state).toBe(
      "attention",
    );
  });

  it("keeps a failed tool visible when the final response completed", () => {
    const original = completed();
    if (original.result === undefined) throw new Error("Missing fixture result");
    const exchange: ChatToolExchange = {
      ...original,
      result: {
        ...original.result,
        status: "failed",
        reason: "provider-reported-error",
        page: null,
        data: {},
      },
    };
    render(
      <ChatProcessingPipeline
        steps={chatProcessingSteps(transcript(exchange), "completed", false)}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Completed with issues");
    expect(screen.getAllByRole("listitem")[1]).toHaveTextContent("Failed");
    expect(screen.getAllByRole("listitem")[1]).toHaveAttribute("data-state", "failed");
  });

  it("keeps a rejected action visible when the final response completed", () => {
    const exchange = {
      ...call("jira_create"),
      approval: { ...approval, state: "rejected" as const },
    };
    render(
      <ChatProcessingPipeline
        steps={chatProcessingSteps(transcript(exchange), "completed", false)}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Completed with issues");
    expect(screen.getAllByRole("listitem")[1]).toHaveTextContent("Not performed");
    expect(screen.getAllByRole("listitem")[1]).toHaveAttribute("data-state", "blocked");
  });

  it.each(["en", "de"] as const)(
    "summarizes canonical completion with an earlier refusal honestly in %s",
    async (locale) => {
      await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
      localStorage.setItem(I18N_STORAGE_KEY, locale);
      try {
        const exchanges = transcript(
          { ...completed(call("jira_create", "refused")), mutationOutcome: "not-dispatched" },
          completed(call("jira_projects", "metadata")),
          { ...completed(call("jira_create", "confirmed")), mutationOutcome: "succeeded" },
        );
        const steps = chatProcessingSteps(exchanges, "completed", false);
        expect(steps.map((step) => step.state)).toEqual([
          "done",
          "blocked",
          "done",
          "done",
          "done",
        ]);
        render(
          <I18nProvider>
            <ChatProcessingPipeline steps={steps} />
          </I18nProvider>,
        );
        expect(screen.getByRole("status")).toHaveTextContent(
          locale === "de" ? "Abgeschlossen mit Hinweisen" : "Completed with issues",
        );
        const observed = screen.getAllByRole("listitem");
        expect(observed[1]).toHaveTextContent(
          locale === "de" ? "Nicht ausgeführt" : "Not performed",
        );
        expect(observed[3]).toHaveTextContent(locale === "de" ? "Erledigt" : "Done");
        expect(screen.queryByRole("listitem", { current: "step" })).toBeNull();
      } finally {
        localStorage.removeItem(I18N_STORAGE_KEY);
      }
    },
  );

  it.each(["failed", "cancelled"] as const)(
    "retains canonical %s after a refusal and a separate confirmed write",
    (turnState) => {
      const steps = chatProcessingSteps(
        transcript(
          { ...completed(call("jira_create", "refused")), mutationOutcome: "not-dispatched" },
          { ...completed(call("jira_create", "confirmed")), mutationOutcome: "succeeded" },
        ),
        turnState,
        false,
      );
      render(<ChatProcessingPipeline steps={steps} />);
      expect(screen.getByRole("status")).toHaveTextContent(
        turnState === "failed" ? "Processing status: Failed" : "Processing status: Cancelled",
      );
      expect(screen.getAllByRole("listitem")[1]).toHaveTextContent("Not performed");
      expect(screen.getAllByRole("listitem")[1]).toHaveAttribute("data-state", "blocked");
    },
  );

  it("does not infer canonical completion from a successful separate tool", () => {
    const steps = chatProcessingSteps(
      transcript(
        { ...completed(call("jira_create", "refused")), mutationOutcome: "not-dispatched" },
        { ...completed(call("jira_create", "confirmed")), mutationOutcome: "succeeded" },
      ),
      undefined,
      false,
    );
    render(<ChatProcessingPipeline steps={steps} />);
    expect(screen.getByRole("status")).toHaveTextContent("Processing status: Not performed");
    expect(steps.some((step) => step.id === "response")).toBe(false);
  });

  it.each(["unknown", "succeeded-unconfirmed"] as const)(
    "retains %s remote outcome warnings despite a completed response and another confirmed write",
    (mutationOutcome) => {
      const steps = chatProcessingSteps(
        transcript(
          { ...completed(call("jira_create", "uncertain")), mutationOutcome },
          { ...completed(call("jira_create", "confirmed")), mutationOutcome: "succeeded" },
        ),
        "completed",
        false,
      );
      render(<ChatProcessingPipeline steps={steps} />);
      expect(screen.getByRole("status")).toHaveTextContent("Check the unconfirmed result");
      expect(screen.getAllByRole("listitem")[1]).toHaveTextContent("Outcome unconfirmed");
    },
  );

  it.each([
    ["succeeded", "done"],
    ["succeeded-unconfirmed", "attention"],
    ["unknown", "attention"],
    ["not-dispatched", "blocked"],
    ["rejected", "blocked"],
  ] as const)("preserves the recorded %s mutation outcome after cancellation", (outcome, state) => {
    const original = completed(call("jira_create"));
    if (original.result === undefined) throw new Error("Missing fixture result");
    const exchange: ChatToolExchange = {
      ...original,
      mutationOutcome: outcome,
      result: {
        ...original.result,
        status: "cancelled",
        reason: "parent-cancelled",
        page: null,
        data: null,
      },
    };
    expect(chatProcessingSteps(transcript(exchange), "cancelled", false)[1]?.state).toBe(state);
  });

  it("never infers a successful mutation from a completed transport envelope", () => {
    const steps = chatProcessingSteps(
      transcript(completed(call("jira_create"))),
      "completed",
      false,
    );
    expect(steps[1]?.state).toBe("attention");
    render(<ChatProcessingPipeline steps={steps} />);
    expect(screen.getByRole("status")).toHaveTextContent("Check the unconfirmed result");
  });

  it("respects MCP write approvals and uncertain remote outcomes", () => {
    const mcpApproval: ChatToolWriteApprovalView = {
      kind: "mcp-chat-write",
      approvalId: "mcp-approval",
      chatId: "chat-1",
      operation: "mcp.fixture.create",
      configurationDigest: "a".repeat(64),
      invocationId: "mcp-invocation",
      actionDigest: "b".repeat(64),
      requestedAt: 1,
      expiresAt: 2,
      state: "pending",
    };
    const exchange = { ...call("mcp_fixture_create"), approval: mcpApproval };
    expect(chatProcessingSteps(transcript(exchange), "pending", false)[1]?.state).toBe("approval");
    expect(
      chatProcessingSteps(
        transcript({ ...exchange, mutationOutcome: "unknown" }),
        "failed",
        false,
      )[1]?.state,
    ).toBe("attention");
  });

  it.each([
    ["knowledge_requirements", { view: "documents" }, "chat.processing.documents"],
    ["knowledge_requirements", { view: "change-queries" }, "chat.processing.changeQueries"],
    ["knowledge_requirements", { view: "changes" }, "chat.processing.changes"],
    ["knowledge_documents", { view: "read" }, "chat.processing.source"],
    ["knowledge_documents", { view: "search" }, "chat.processing.search"],
    ["knowledge_documents", { view: "inventory" }, "chat.processing.documents"],
    ["knowledge_review", {}, "chat.processing.review"],
  ] as const)("labels the genuine %s arguments %j", (name, args, label) => {
    const exchange: ChatToolExchange = { call: { ...call(name).call, arguments: args } };
    expect(chatProcessingSteps(transcript(exchange), "pending", false)[1]?.label).toBe(label);
  });

  it("keeps repeated requirements pages visible as separate observed steps", () => {
    const first = completed();
    if (first.result?.status !== "completed") throw new Error("Missing completed fixture");
    const page: ChatToolExchange = {
      ...first,
      result: {
        ...first.result,
        page: { truncated: true, reason: "result-cap", cursor: null },
        data: { nextCursor: "opaque-next-page" },
      },
    };
    const steps = chatProcessingSteps(
      transcript(page, call("knowledge_requirements", "read-2")),
      "pending",
      false,
    );
    expect(steps[1]?.state).toBe("done");
    expect(steps[2]?.state).toBe("active");
    expect(steps[1]?.id).not.toBe(steps[2]?.id);
  });
});

describe("accessible processing feedback", () => {
  it.each(["en", "de"] as const)(
    "localizes the timeline and current step in %s",
    async (locale) => {
      await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
      localStorage.setItem(I18N_STORAGE_KEY, locale);
      try {
        const { container, rerender } = render(
          <I18nProvider>
            <ChatProcessingPipeline
              steps={chatProcessingSteps(transcript(call()), "pending", false)}
            />
          </I18nProvider>,
        );
        const title = locale === "de" ? "Fortschritt" : "Progress";
        const label = locale === "de" ? "Anforderungen lesen" : "Read requirements";
        const region = screen.getByRole("region", { name: title });
        expect(within(region).getByRole("listitem", { current: "step" })).toHaveTextContent(label);
        expect(screen.getByRole("status")).toHaveTextContent(label);
        expect((await axe(container)).violations).toHaveLength(0);
        rerender(
          <I18nProvider>
            <ChatProcessingPipeline
              steps={chatProcessingSteps(transcript(completed()), "completed", false)}
            />
          </I18nProvider>,
        );
        expect(screen.queryByRole("listitem", { current: "step" })).toBeNull();
        expect(screen.getByRole("status")).toHaveTextContent(locale === "de" ? "Erledigt" : "Done");
      } finally {
        localStorage.removeItem(I18N_STORAGE_KEY);
      }
    },
  );

  it.each(["failed", "cancelled"] satisfies readonly ChatTurnState[])(
    "does not leave an active marker after %s",
    (turnState) => {
      render(
        <ChatProcessingPipeline
          steps={chatProcessingSteps(transcript(call()), turnState, false)}
        />,
      );
      expect(screen.queryByRole("listitem", { current: "step" })).toBeNull();
      expect(screen.getByRole("list", { name: "" })).toBeVisible();
    },
  );
});

it("groups consecutive completed calls while retaining the current call separately", () => {
  const earlier = Array.from({ length: 60 }, (_, index) =>
    completed(call("knowledge_requirements", `page-${String(index)}`)),
  );
  const steps = chatProcessingSteps(
    transcript(...earlier, call("knowledge_requirements", "current")),
    "pending",
    false,
  );
  render(<ChatProcessingPipeline steps={steps} />);
  expect(screen.getAllByRole("listitem")).toHaveLength(4);
  expect(screen.getByText("2. Read requirements · 60 calls")).toBeVisible();
  expect(screen.getByRole("listitem", { current: "step" })).toHaveTextContent("Read requirements");
  expect(screen.getByRole("listitem", { current: "step" })).not.toHaveTextContent("60 calls");
});

it("keeps a 250-call turn compact and lets the human expand the earlier calls", async () => {
  const steps: ChatProcessingStep[] = [
    { id: "request", label: "chat.processing.request", state: "done" },
    ...Array.from({ length: 250 }, (_, index): ChatProcessingStep => ({
      id: `tool:${String(index)}`,
      label: index % 2 === 0 ? "chat.processing.source" : "chat.processing.search",
      state: index === 249 ? "active" : "done",
    })),
    { id: "response", label: "chat.processing.response", state: "upcoming" },
  ];
  const user = userEvent.setup();
  render(<ChatProcessingPipeline steps={steps} />);
  expect(screen.getAllByRole("listitem").length).toBeLessThanOrEqual(6);
  expect(screen.getByRole("listitem", { current: "step" })).toHaveTextContent("Search source");
  const expand = screen.getByRole("button", { name: "Show 247 earlier calls" });
  expect(expand).toHaveAttribute("aria-expanded", "false");
  await user.click(expand);
  expect(screen.getAllByRole("listitem")).toHaveLength(252);
  const collapse = screen.getByRole("button", { name: "Show fewer steps" });
  expect(collapse).toHaveAttribute("aria-expanded", "true");
  await user.click(collapse);
  expect(screen.getAllByRole("listitem").length).toBeLessThanOrEqual(6);
  expect(await axe(document.body)).toHaveNoViolations();
});

it("keeps different tools separate even when they share the same presentation label", () => {
  const steps: ChatProcessingStep[] = [
    { id: "request", label: "chat.processing.request", state: "done" },
    { id: "tool:one", toolName: "mcp_first", label: "chat.mcp.tool", state: "done" },
    { id: "tool:two", toolName: "mcp_second", label: "chat.mcp.tool", state: "done" },
    { id: "response", label: "chat.processing.response", state: "done" },
  ];
  render(<ChatProcessingPipeline steps={steps} />);
  expect(screen.getAllByRole("listitem")).toHaveLength(4);
  expect(screen.queryByText(/2 calls/u)).toBeNull();
});
