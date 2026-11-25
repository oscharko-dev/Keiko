import { cleanup, render } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AvailableCodingSafeActivityFeed,
  CodingSafeActivityTool,
} from "@oscharko-dev/keiko-contracts";

import { I18nProvider, I18N_STORAGE_KEY, loadLocaleMessages } from "@/lib/i18n";
import type { UseCodingWorkbenchQuestionsResult } from "@/lib/useCodingWorkbenchQuestions";
import { Timeline } from "./CodingWorkbenchTimeline";
import { commandPreview } from "./CodingWorkbenchToolDetail";

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
  it("opens to the origin, the exit code, the command and the ends of its output", async () => {
    const container = renderTools([FAILED_TEST_RUN]);
    const failed = row(container, 0);
    expect(failed.open).toBe(true);
    expect(failed.dataset.failureOrigin).toBe("command-failed");
    expect(failed).toHaveTextContent("Command failed");
    expect(failed).toHaveTextContent("Failed 3 times in this run");
    expect(failed).toHaveTextContent("The command did not finish successfully (exit code 1).");
    expect(failed).toHaveTextContent("The agent sees this and will try another way.");
    expect(failed).toHaveTextContent("Took 4.2 s");
    expect(failed).toHaveTextContent("$ npm test -- --runInBand");
    expect(failed).toHaveTextContent("> vitest run");
    expect(failed).toHaveTextContent("115 lines hidden");
    expect(failed).toHaveTextContent("Error: expected 2 to be 3");
    // Never the old wording that blamed the model or named nothing.
    expect(failed).not.toHaveTextContent("reported an error");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("names Keiko as the origin of a refusal and says who declined it", () => {
    const container = renderTools([
      shell("call-push", "denied", {
        failureOrigin: "keiko-refused",
        refusalCause: "approval-declined",
        command: { text: "git push origin HEAD", truncated: false },
      }),
    ]);
    const refused = row(container, 0);
    expect(refused.dataset.failureOrigin).toBe("keiko-refused");
    expect(refused).toHaveTextContent("Blocked by Keiko");
    expect(refused).toHaveTextContent("Keiko did not allow this step. You declined it.");
    // A refusal is not something the agent retries around.
    expect(refused).not.toHaveTextContent("will try another way");
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
    expect(invalid).toHaveTextContent("The agent sees this and will try another way.");
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

describe("a command's preview", () => {
  it("shows the first line, shortened to one row", () => {
    expect(commandPreview({ text: "ls -la", truncated: false })).toBe("ls -la");
    expect(commandPreview({ text: "a".repeat(81), truncated: false })).toBe(`${"a".repeat(80)}…`);
    expect(commandPreview({ text: "set -e\nnpm test", truncated: false })).toBe("set -e…");
    expect(commandPreview({ text: "npm test", truncated: true })).toBe("npm test…");
  });
});
