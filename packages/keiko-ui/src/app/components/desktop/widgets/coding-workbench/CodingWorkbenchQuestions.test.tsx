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
