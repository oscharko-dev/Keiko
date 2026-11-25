import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AvailableCodingSafeActivityFeed,
  CodingSafeActivityAnswerPage,
  CodingSafeActivityMessage,
  CodingSafeActivityTextPart,
} from "@oscharko-dev/keiko-contracts";

import { getCodingAppSessionAnswerPage } from "./coding-app-session-channel-api";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "./client-diagnostics";
import {
  CodingWorkbenchModelTextReader,
  type CodingWorkbenchModelTexts,
} from "./codingWorkbenchModelTextReader";

vi.mock("./coding-app-session-channel-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./coding-app-session-channel-api")>();
  return { ...actual, getCodingAppSessionAnswerPage: vi.fn() };
});

const pageRequest = vi.mocked(getCodingAppSessionAnswerPage);
const AT = "2026-07-19T12:00:00.000Z";
const RUN = "run-1";
const ANSWER = "a".repeat(30_000) + "answer-end";
const REASONING = "r".repeat(20_000) + "reasoning-end";

function message(carried: number, total: number, reasoning?: number): CodingSafeActivityMessage {
  return {
    messageId: "m-1",
    role: "assistant",
    occurredAt: AT,
    segments:
      carried === 0 ? [] : [{ kind: "text", text: ANSWER.slice(0, carried), truncated: false }],
    truncated: false,
    ...(total > carried ? { fullAnswer: { length: total, truncated: false } } : {}),
    ...(reasoning === undefined
      ? {}
      : {
          reasoning: { text: REASONING.slice(0, 100), truncated: false },
          fullReasoning: { length: reasoning, truncated: false },
        }),
  };
}

function feed(...messages: CodingSafeActivityMessage[]): AvailableCodingSafeActivityFeed {
  return {
    schemaVersion: "1",
    availability: "available",
    runId: RUN,
    updatedAt: AT,
    turns: [{ turnId: "t-1", messages, tools: [], truncated: false }],
    truncated: false,
    droppedEventCount: 0,
  };
}

function serve(texts: Record<CodingSafeActivityTextPart, string>): void {
  pageRequest.mockImplementation(({ runId, messageId, part = "answer", offset }) => {
    const text = texts[part];
    const page: CodingSafeActivityAnswerPage = {
      schemaVersion: "1",
      runId,
      messageId,
      part,
      offset,
      text: text.slice(offset, offset + 32 * 1024),
      length: text.length,
      truncated: false,
    };
    return Promise.resolve({ schemaVersion: "1", page });
  });
}

let latest: CodingWorkbenchModelTexts | undefined;
let reports: string[] = [];
let reader: CodingWorkbenchModelTextReader;

beforeEach(() => {
  latest = undefined;
  reports = [];
  setClientDiagnosticWriter((text) => reports.push(text));
  reader = new CodingWorkbenchModelTextReader(RUN, (texts) => {
    latest = texts;
  });
});

afterEach(() => {
  reader.dispose();
  pageRequest.mockReset();
  resetClientDiagnosticWriter();
});

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("CodingWorkbenchModelTextReader", () => {
  it("keeps up from live deltas alone, with no page read", () => {
    reader.sync(feed(message(16_000, 16_000)));
    reader.ingestDeltas([
      { messageId: "m-1", part: "answer", offset: 16_000, text: ANSWER.slice(16_000) },
    ]);
    reader.sync(feed(message(16_000, ANSWER.length)));

    expect(pageRequest).not.toHaveBeenCalled();
    expect(latest?.answers.get("m-1")).toEqual({
      text: ANSWER,
      complete: true,
      truncated: false,
      failed: false,
    });
  });

  it("reads a gap the deltas leave as pages from where the held text ends", async () => {
    serve({ answer: ANSWER, reasoning: REASONING });
    reader.sync(feed(message(16_000, 16_000)));
    // A delta past the held text leaves a gap: it is not appended.
    reader.ingestDeltas([{ messageId: "m-1", part: "answer", offset: 20_000, text: "zz" }]);
    reader.sync(feed(message(16_000, ANSWER.length)));
    await vi.waitFor(() => {
      expect(latest?.answers.get("m-1")?.complete).toBe(true);
    });

    expect(latest?.answers.get("m-1")?.text).toBe(ANSWER);
    expect(pageRequest.mock.calls[0]?.[0]).toMatchObject({ offset: 16_000, part: "answer" });
  });

  it("appends only the new part of a delta that overlaps the held text", () => {
    reader.sync(feed(message(100, 100)));
    reader.ingestDeltas([
      { messageId: "m-1", part: "answer", offset: 50, text: ANSWER.slice(50, 200) },
    ]);
    reader.sync(feed(message(100, 200)));
    expect(latest?.answers.get("m-1")?.text).toBe(ANSWER.slice(0, 200));
  });

  it("marks a failed read once and never retries it on its own, until asked", async () => {
    pageRequest.mockRejectedValue(new TypeError("Failed to fetch"));
    reader.sync(feed(message(16_000, ANSWER.length)));
    await settled();
    for (let update = 0; update < 5; update += 1) reader.sync(feed(message(16_000, ANSWER.length)));
    await settled();

    expect(pageRequest).toHaveBeenCalledTimes(1);
    expect(reports).toHaveLength(1);
    expect(latest?.answers.get("m-1")).toMatchObject({ failed: true, complete: false });

    serve({ answer: ANSWER, reasoning: REASONING });
    reader.retry("answer", "m-1");
    await vi.waitFor(() => {
      expect(latest?.answers.get("m-1")?.complete).toBe(true);
    });
    expect(latest?.answers.get("m-1")?.failed).toBe(false);
  });

  it("reads the reasoning only once someone opens it", async () => {
    serve({ answer: ANSWER, reasoning: REASONING });
    reader.sync(feed(message(100, 100, REASONING.length)));
    await settled();
    expect(pageRequest).not.toHaveBeenCalled();
    expect(latest?.reasoning.get("m-1")?.complete).toBe(false);

    reader.wantReasoning("m-1");
    await vi.waitFor(() => {
      expect(latest?.reasoning.get("m-1")?.text).toBe(REASONING);
    });
    expect(pageRequest.mock.calls.every(([request]) => request.part === "reasoning")).toBe(true);
  });

  it("stops reading and publishes nothing once disposed", async () => {
    let resolvePage: (() => void) | undefined;
    pageRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePage = () => {
            resolve({ schemaVersion: "1", page: null });
          };
        }),
    );
    reader.sync(feed(message(16_000, ANSWER.length)));
    const before = latest;
    reader.dispose();
    resolvePage?.();
    await settled();

    expect(latest).toBe(before);
    expect(pageRequest.mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(reports).toHaveLength(0);
  });

  it("ignores another run's feed", () => {
    reader.sync({ ...feed(message(16_000, ANSWER.length)), runId: "run-2" });
    expect(pageRequest).not.toHaveBeenCalled();
    expect(latest).toBeUndefined();
  });
});
