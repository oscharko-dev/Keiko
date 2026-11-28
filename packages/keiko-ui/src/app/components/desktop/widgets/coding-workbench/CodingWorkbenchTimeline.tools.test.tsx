import { cleanup, render, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AvailableCodingSafeActivityFeed,
  CodingSafeActivityTool,
} from "@oscharko-dev/keiko-contracts";

import { I18nProvider, I18N_STORAGE_KEY, loadLocaleMessages } from "@/lib/i18n";
import type { UseCodingWorkbenchQuestionsResult } from "@/lib/useCodingWorkbenchQuestions";
import { Timeline } from "./CodingWorkbenchTimeline";
import { commandPreview, toolGroupSummary } from "./CodingWorkbenchToolDetail";

const AT = "2026-07-19T12:00:00.000Z";

const IDLE_QUESTIONS: UseCodingWorkbenchQuestionsResult = {
  status: "empty",
  questions: [],
  errorCode: null,
  mutationFailure: null,
  answer: vi.fn(() => Promise.resolve(true)),
  reject: vi.fn(() => Promise.resolve(true)),
  retry: vi.fn(),
};

function shell(
  callId: string,
  state: CodingSafeActivityTool["state"],
  presentation: CodingSafeActivityTool["presentation"],
): CodingSafeActivityTool {
  return {
    callId,
    tool: "shell",
    state,
    occurredAt: AT,
    ...(presentation ? { presentation } : {}),
  };
}

function feedOf(tools: readonly CodingSafeActivityTool[]): AvailableCodingSafeActivityFeed {
  return {
    schemaVersion: "1",
    availability: "available",
    runId: "run-1",
    updatedAt: AT,
    turns: [{ turnId: "turn-1", messages: [], tools, truncated: false }],
    truncated: false,
    droppedEventCount: 0,
  };
}

function renderTools(tools: readonly CodingSafeActivityTool[]): HTMLElement {
  return render(
    <I18nProvider>
      <Timeline
        active={false}
        events={[]}
        activity={{ status: "live", feed: feedOf(tools), errorCode: null, retry: vi.fn() }}
        questions={IDLE_QUESTIONS}
      />
    </I18nProvider>,
  ).container;
}

function row(container: HTMLElement, callIndex: number): HTMLDetailsElement {
  const rows = container.querySelectorAll<HTMLDetailsElement>(
    '[data-timeline-kind="tool"] details',
  );
  const found = rows[callIndex];
  if (found === undefined) throw new TypeError(`missing tool row ${String(callIndex)}`);
  return found;
}

const FAILED_TEST_RUN = shell("call-test", "failed", {
  exitCode: 1,
  failureOrigin: "command-failed",
  failureCount: 3,
  durationMs: 4_200,
  command: { text: "npm test -- --runInBand", truncated: false },
  output: {
    head: "> test\n> vitest run",
    tail: "FAIL src/a.test.ts\nError: expected 2 to be 3",
    lineCount: 140,
    hiddenLineCount: 115,
    truncated: false,
  },
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(I18N_STORAGE_KEY);
});

describe("a failed command's row", () => {
  it("shows a short command once, in the row's preview, and a long one whole when opened", () => {
    const container = renderTools([
      FAILED_TEST_RUN,
      shell("call-long", "failed", {
        exitCode: 2,
        failureOrigin: "command-failed",
        command: { text: "npm run build &&\n  npm test", truncated: false },
      }),
    ]);
    const short = row(container, 0);
    expect(within(short).queryByRole("figure", { name: "Command" })).toBeNull();
    const long = row(container, 1);
    expect(within(long).getByRole("figure", { name: "Command" })).toHaveTextContent(
      "$ npm run build && npm test",
    );
  });

  it("opens to the origin, the exit code, the command and the ends of its output", async () => {
    const container = renderTools([FAILED_TEST_RUN]);
    const failed = row(container, 0);
    expect(failed.open).toBe(true);
    expect(failed.dataset.failureOrigin).toBe("command-failed");
    expect(failed).toHaveTextContent("Command failed");
    expect(failed).toHaveTextContent("Failed 3 times in this run");
    expect(failed).toHaveTextContent("The command did not finish successfully (exit code 1).");
    expect(failed).toHaveTextContent("The agent sees this result and can continue from it.");
    expect(failed).toHaveTextContent("Took 4.2 s");
    expect(failed).toHaveTextContent("$ npm test -- --runInBand");
    expect(failed).toHaveTextContent("> vitest run");
    expect(failed).toHaveTextContent("115 lines hidden");
    expect(failed).toHaveTextContent("Error: expected 2 to be 3");
    // Never the old wording that blamed the model or named nothing.
    expect(failed).not.toHaveTextContent("reported an error");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("names the person's decision, not Keiko's policy, on a step the person declined (U-36)", () => {
    const container = renderTools([
      shell("call-push", "denied", {
        failureOrigin: "keiko-refused",
        refusalCause: "approval-declined",
        command: { text: "git push origin HEAD", truncated: false },
      }),
      shell("call-late", "denied", {
        failureOrigin: "keiko-refused",
        refusalCause: "approval-expired",
        command: { text: "git push origin HEAD", truncated: false },
      }),
    ]);
    const declined = row(container, 0);
    expect(declined.dataset.failureOrigin).toBe("keiko-refused");
    expect(declined).toHaveTextContent("Declined by you");
    expect(declined).toHaveTextContent("Keiko did not run this step. You declined it.");
    // Never the contradiction of blaming Keiko's policy for the person's own decision.
    expect(declined).not.toHaveTextContent("Blocked by Keiko");
    expect(declined).not.toHaveTextContent("Keiko did not allow this step");
    const expired = row(container, 1);
    expect(expired).toHaveTextContent("Not decided in time");
    expect(expired).toHaveTextContent("Keiko did not run this step. Nobody decided in time.");
    // A refusal is not something the agent retries around.
    expect(declined).not.toHaveTextContent("can continue from it");
    expect(expired).not.toHaveTextContent("can continue from it");
  });

  it("keeps naming Keiko when its policy refused a step without asking anyone", () => {
    const container = renderTools([
      shell("call-push", "denied", {
        failureOrigin: "keiko-refused",
        command: { text: "git push --force", truncated: false },
      }),
    ]);
    const refused = row(container, 0);
    expect(refused).toHaveTextContent("Blocked by Keiko");
    expect(refused).toHaveTextContent("Keiko did not allow this step.");
    expect(refused).not.toHaveTextContent("Declined by you");
  });

  it("shows the message a tool handed the agent and a timeout as its own origin", () => {
    const container = renderTools([
      {
        callId: "call-read",
        tool: "read",
        state: "failed",
        occurredAt: AT,
        presentation: {
          failureOrigin: "tool-error",
          errorText: { text: "File not found: src/missing.ts", truncated: false },
        },
      },
      shell("call-slow", "failed", {
        failureOrigin: "timed-out",
        command: { text: "npm run e2e", truncated: false },
      }),
    ]);
    expect(row(container, 0)).toHaveTextContent("Tool error");
    expect(row(container, 0)).toHaveTextContent("Message to the agent");
    expect(row(container, 0)).toHaveTextContent("File not found: src/missing.ts");
    expect(row(container, 1)).toHaveTextContent("Timed out");
    expect(row(container, 1)).toHaveTextContent("The command ran out of time.");
  });

  it("says plainly when the call's arguments could not be read, without blaming anyone", () => {
    const container = renderTools([
      {
        callId: "call-args",
        tool: "edit",
        state: "failed",
        occurredAt: AT,
        presentation: {
          failureOrigin: "invalid-arguments",
          errorText: { text: "Expected a JSON object", truncated: false },
        },
      },
    ]);
    const invalid = row(container, 0);
    expect(invalid.open).toBe(true);
    expect(invalid.dataset.failureOrigin).toBe("invalid-arguments");
    expect(invalid).toHaveTextContent("Invalid arguments");
    expect(invalid).toHaveTextContent(
      "The call's arguments could not be read, so the tool did not run.",
    );
    expect(invalid).toHaveTextContent("Expected a JSON object");
    expect(invalid).toHaveTextContent("The agent sees this result and can continue from it.");
  });

  it("keeps a stopped call closed and says it was stopped", () => {
    const container = renderTools([
      shell("call-stop", "cancelled", { failureOrigin: "cancelled" }),
    ]);
    const stopped = row(container, 0);
    expect(stopped.open).toBe(false);
    expect(stopped).toHaveTextContent("Stopped");
  });

  it("says its text left the live view when the feed shed it", () => {
    const container = renderTools([
      shell("call-old", "failed", {
        exitCode: 2,
        failureOrigin: "command-failed",
        detailOmitted: true,
      }),
    ]);
    expect(row(container, 0)).toHaveTextContent(
      "The command and its output are no longer shown live.",
    );
  });

  // PERF-2: a result the runtime shortened for the model says so on the row, and the opened row
  // says how much of it the model saw.
  it("marks a result the runtime shortened for the model, with the lines the model saw", () => {
    const container = renderTools([
      shell("call-long", "succeeded", {
        exitCode: 0,
        command: { text: "npm test", truncated: false },
        outputShortened: { keptBytes: 51_200, keptLines: 380, totalLines: 200_000 },
      }),
    ]);
    expect(row(container, 0)).toHaveTextContent("Output shortened for the model");
    expect(row(container, 0)).toHaveTextContent(
      "The model saw the first 380 of 200000 lines of this result",
    );
    const unshortened = renderTools([
      shell("call-short", "succeeded", {
        exitCode: 0,
        command: { text: "npm run build", truncated: false },
      }),
    ]);
    expect(row(unshortened, 0)).not.toHaveTextContent("shortened for the model");
  });

  it("marks a shortened result whose line counts are unknown", () => {
    const container = renderTools([
      shell("call-long", "succeeded", {
        exitCode: 0,
        command: { text: "npm test", truncated: false },
        outputShortened: { keptBytes: 51_200 },
      }),
    ]);
    expect(row(container, 0)).toHaveTextContent("The model saw only the start of this result");
  });

  it("speaks German", async () => {
    await loadLocaleMessages("de");
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    const container = renderTools([
      FAILED_TEST_RUN,
      shell("call-push", "denied", { failureOrigin: "keiko-refused" }),
      shell("call-args", "failed", { failureOrigin: "invalid-arguments" }),
    ]);
    expect(row(container, 0)).toHaveTextContent("Befehl fehlgeschlagen");
    expect(row(container, 0)).toHaveTextContent("(beendet mit Code 1)");
    expect(row(container, 0)).toHaveTextContent("115 Zeilen ausgeblendet");
    expect(row(container, 1)).toHaveTextContent("Keiko hat blockiert");
    expect(row(container, 2)).toHaveTextContent("Ungültige Argumente");
    expect(row(container, 0)).not.toHaveTextContent("dem Modell gemeldet");
  });
});

describe("a successful command's row", () => {
  it("stays one quiet line: the command, a duration and no exit code or state word", () => {
    const container = renderTools([
      shell("call-ok", "succeeded", {
        exitCode: 0,
        durationMs: 1_500,
        command: { text: "npm run build", truncated: false },
        output: { head: "built", tail: "", lineCount: 1, hiddenLineCount: 0, truncated: false },
      }),
    ]);
    const ok = row(container, 0);
    expect(ok.open).toBe(false);
    expect(ok).not.toHaveAttribute("data-failure-origin");
    const summary = ok.querySelector("summary");
    expect(summary).toHaveTextContent("$ npm run build");
    expect(summary).toHaveTextContent("Took 1.5 s");
    expect(summary).not.toHaveTextContent("Exit code");
    // The state word is there for a screen reader only.
    expect(summary?.querySelector(".sr-only")).toHaveTextContent("Succeeded");
  });

  it("names no duration under a second", () => {
    const container = renderTools([
      shell("call-fast", "succeeded", {
        durationMs: 400,
        command: { text: "ls", truncated: false },
      }),
    ]);
    expect(row(container, 0)).not.toHaveTextContent("Took");
  });
});

describe("a subagent's row (U-52)", () => {
  const SUBAGENT: CodingSafeActivityTool = {
    callId: "call-sub",
    tool: "subagent",
    state: "succeeded",
    occurredAt: AT,
    presentation: {
      agentName: { text: "explore", truncated: false },
      taskDescription: { text: "Count test files", truncated: false },
      taskPrompt: {
        text: "Count every *.test.ts file under src and report the total.",
        truncated: false,
      },
    },
  };

  it("names the agent and the task in the row and shows the prompt when opened", () => {
    const container = renderTools([SUBAGENT]);
    const found = row(container, 0);
    expect(found.querySelector("summary")).toHaveTextContent("Subagent");
    expect(found.querySelector("summary")).toHaveTextContent("explore — Count test files");
    expect(within(found).getByRole("figure", { name: "Prompt" })).toHaveTextContent(
      "Count every *.test.ts file under src",
    );
  });

  it("says the prompt left the live view when the feed shed it", () => {
    const { taskPrompt: _prompt, ...facts } = SUBAGENT.presentation ?? {};
    const container = renderTools([
      { ...SUBAGENT, presentation: { ...facts, detailOmitted: true } },
    ]);
    expect(row(container, 0)).toHaveTextContent("explore — Count test files");
    expect(within(row(container, 0)).queryByRole("figure", { name: "Prompt" })).toBeNull();
  });
});

describe("a command's preview", () => {
  it("shows the first line, shortened to one row", () => {
    expect(commandPreview({ text: "ls -la", truncated: false })).toBe("ls -la");
    expect(commandPreview({ text: "a".repeat(81), truncated: false })).toBe(`${"a".repeat(80)}…`);
    expect(commandPreview({ text: "set -e\nnpm test", truncated: false })).toBe("set -e…");
    expect(commandPreview({ text: "npm test", truncated: true })).toBe("npm test…");
  });
});

describe("a group of finished steps", () => {
  it("names task-list updates in their own verb instead of other steps", () => {
    const t = (key: string, values?: { readonly count?: number }): string =>
      values?.count === undefined ? key : `${key}:${String(values.count)}`;
    const summary = toolGroupSummary(
      [
        { tool: shell("call-1", "succeeded", { exitCode: 0 }), count: 1 },
        { tool: { ...shell("call-2", "succeeded", undefined), tool: "todowrite" }, count: 2 },
        { tool: { ...shell("call-3", "succeeded", undefined), tool: "todo" }, count: 1 },
        { tool: { ...shell("call-4", "succeeded", undefined), tool: "question" }, count: 1 },
      ],
      t,
    );
    expect(summary).toBe(
      [
        "codingWorkbench.activity.group.command.one",
        "codingWorkbench.activity.group.plan:3",
        "codingWorkbench.activity.group.other.one",
      ].join(" · "),
    );
  });
});
