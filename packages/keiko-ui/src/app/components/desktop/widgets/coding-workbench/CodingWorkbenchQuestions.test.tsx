import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UseCodingWorkbenchQuestionsResult } from "@/lib/useCodingWorkbenchQuestions";
import { CodingWorkbenchQuestions } from "./CodingWorkbenchQuestions";

const questionsHookMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/useCodingWorkbenchQuestions", () => ({
  useCodingWorkbenchQuestions: questionsHookMock,
}));

const requests = [
  {
    id: "que_1",
    questions: [
      {
        header: "Choose one",
        question: "Continue with <img src=x onerror=alert(1)>?",
        options: [
          { label: "Proceed", description: "Continue once" },
          { label: "Stop", description: "Do not continue" },
        ],
      },
      {
        header: "Choose several",
        question: "Which checks should run?",
        multiple: true,
        options: [
          { label: "Unit", description: "Run unit tests" },
          { label: "Lint", description: "Run lint" },
        ],
      },
      {
        header: "Custom response",
        question: "Provide a bounded answer.",
        custom: true,
        options: [],
      },
    ],
  },
] as const;

function hookResult(
  overrides: Partial<UseCodingWorkbenchQuestionsResult> = {},
): UseCodingWorkbenchQuestionsResult {
  return {
    status: "ready",
    questions: requests,
    errorCode: null,
    mutationFailure: null,
    answer: vi.fn(() => Promise.resolve(true)),
    reject: vi.fn(() => Promise.resolve(true)),
    retry: vi.fn(),
    ...overrides,
  };
}

function renderQuestions(result = hookResult()): UseCodingWorkbenchQuestionsResult {
  questionsHookMock.mockReturnValue(result);
  render(
    <CodingWorkbenchQuestions
      runId="run-1"
      revision={3}
      runState="paused"
      runtimeEventSignal={0}
      refreshSnapshot={() => Promise.resolve()}
    />,
  );
  return result;
}

describe("CodingWorkbenchQuestions", () => {
  afterEach(() => vi.clearAllMocks());

  it("renders a labelled section and submits single, multiple, and custom answers", async () => {
    const user = userEvent.setup();
    const result = renderQuestions();

    expect(screen.getByRole("region", { name: "Runtime questions" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Runtime needs your input" })).toHaveFocus(),
    );
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/u)).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    await user.click(screen.getByRole("radio", { name: /Proceed/u }));
    await user.click(screen.getByRole("checkbox", { name: /Unit/u }));
    await user.click(screen.getByRole("checkbox", { name: /Lint/u }));
    await user.type(screen.getByLabelText("Custom answer for Custom response"), "Use staging");
    await user.click(screen.getByRole("button", { name: "Send answer" }));

    expect(result.answer).toHaveBeenCalledWith("que_1", [
      ["Proceed"],
      ["Unit", "Lint"],
      ["Use staging"],
    ]);
  });

  it("exposes loading, empty, offline, error, stale, submitting, terminal, and unpaired states", async () => {
    const user = userEvent.setup();
    const cases = [
      ["loading", "Checking for runtime questions…"],
      ["empty", "No pending runtime questions."],
      ["offline", "Question service is offline."],
      ["error", "Questions could not be refreshed."],
      ["stale", "Question state changed. Check again to continue."],
      ["terminal", "The coding run has ended."],
      // #2478: the honest re-pair state — distinct from "empty", and not retryable in place
      // because only a fresh launcher pairing can restore the session.
      [
        "unpaired",
        "This window is not paired for question content. Restart Keiko from its launcher to pair a new app session.",
      ],
    ] as const;

    for (const [status, label] of cases) {
      const retry = vi.fn();
      renderQuestions(hookResult({ status, questions: [], retry }));
      expect(screen.getByText(label)).toBeInTheDocument();
      if (status === "offline" || status === "error" || status === "stale") {
        await user.click(screen.getByRole("button", { name: "Check again" }));
        expect(retry).toHaveBeenCalledOnce();
      } else {
        expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
      }
      cleanup();
    }

    renderQuestions(hookResult({ status: "submitting" }));
    expect(screen.getByRole("button", { name: "Send answer" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject question" })).toBeDisabled();
  });

  // F-09a regression: a refused answer/reject rendered the LISTING sentence ("Questions could not
  // be refreshed."), never the machine error code or the correlation id the transport carried, and
  // the question form was disabled because `busy` was derived from `status !== "ready"` — so the
  // operator was told the wrong thing had failed and could not retry the right one.
  it("names the refused answer with its code and support id and keeps the question submittable", async () => {
    const user = userEvent.setup();
    const result = renderQuestions(
      hookResult({
        status: "error",
        mutationFailure: {
          action: "answer",
          code: "CODING_RUNTIME_QUESTION_REJECTED",
          correlationId: "ui-correlation-11",
        },
      }),
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "Your answer was not accepted (CODING_RUNTIME_QUESTION_REJECTED). The question is still open — send it again. Support id: ui-correlation-11.",
    );
    expect(alert).not.toHaveTextContent("Questions could not be refreshed.");
    expect(screen.getByRole("button", { name: "Send answer" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reject question" })).toBeEnabled();

    await user.click(screen.getByRole("radio", { name: /Proceed/u }));
    await user.click(screen.getByRole("checkbox", { name: /Unit/u }));
    await user.type(screen.getByLabelText("Custom answer for Custom response"), "Use staging");
    await user.click(screen.getByRole("button", { name: "Send answer" }));
    expect(result.answer).toHaveBeenCalledWith("que_1", [["Proceed"], ["Unit"], ["Use staging"]]);
  });

  it("attributes a refused rejection to the reject action and omits an absent support id", () => {
    renderQuestions(
      hookResult({
        status: "stale",
        mutationFailure: { action: "reject", code: "CODING_RUNTIME_QUESTION_REVISION" },
      }),
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "Rejecting the question was not accepted (CODING_RUNTIME_QUESTION_REVISION). The question is still open — try again.",
    );
    expect(alert).not.toHaveTextContent("Support id");
    expect(alert).not.toHaveTextContent("Question state changed.");
    // The question itself is still on screen — the only surface that can retry the rejection.
    expect(screen.getByRole("heading", { name: "Runtime needs your input" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject question" })).toBeEnabled();
  });

  it("supports explicit rejection and has no serious or critical axe violations", async () => {
    const user = userEvent.setup();
    const result = renderQuestions();
    await user.click(screen.getByRole("button", { name: "Reject question" }));
    expect(result.reject).toHaveBeenCalledWith("que_1");

    const report = await axe(document.body);
    expect(
      report.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});
