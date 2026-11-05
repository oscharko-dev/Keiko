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
import { chatProcessingSteps } from "./chat-processing-pipeline";
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

  it("announces a failed tool even when the final response completed", () => {
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
    expect(screen.getByRole("status")).toHaveTextContent("Failed");
  });

  it("announces a rejected action even when the final response completed", () => {
    const exchange = {
      ...call("jira_create"),
      approval: { ...approval, state: "rejected" as const },
    };
    render(
      <ChatProcessingPipeline
        steps={chatProcessingSteps(transcript(exchange), "completed", false)}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Not performed");
  });

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
