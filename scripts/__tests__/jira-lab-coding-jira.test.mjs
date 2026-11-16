import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codingJiraPrompt,
  epicTruth,
  gradeCodingAnswer,
  gradeCodingJiraCalls,
  jiraUnchanged,
  runCodingJira,
} from "../testing/jira-chat-lab/requirements/coding-jira.mjs";

const PROJECT = "LIM9";
const STARTED = Date.parse("2026-11-10T09:00:00.000Z");
const ENDED = Date.parse("2026-11-10T09:05:00.000Z");
const RUN = "run-1700000000123";
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function issue(number, type = "Epic", updated = "2026-11-09T10:00:00.000+0100") {
  return {
    id: String(1000 + number),
    key: `${PROJECT}-${number}`,
    fields: { issuetype: { name: type }, updated, summary: `Issue ${number}` },
  };
}

// Epics 1..12 plus Tasks; the Epic keys are deliberately out of order in the read.
const issues = [
  ...Array.from({ length: 12 }, (_, index) => issue(12 - index)),
  issue(13, "Task"),
  issue(14, "Story"),
];

const line = (extra, at = "2026-11-10T09:01:00.000Z", correlationId = RUN) => ({
  ts: at,
  op: "coding-runtime.jira-pod",
  correlationId,
  extra,
});
const bound = () => line({ action: "bind", outcome: "bound" });
const read = (at) =>
  line({ action: "call", outcome: "completed", toolClass: "jira-read", risk: "read" }, at);
const grade = (events) =>
  gradeCodingJiraCalls(events, { runId: RUN, startedAtMs: STARTED, endedAtMs: ENDED });

describe("the Epic truth and the Coding answer", () => {
  it("counts the Epics and takes the five lowest keys numerically", () => {
    expect(epicTruth(issues)).toEqual({
      count: 12,
      firstKeys: ["LIM9-1", "LIM9-2", "LIM9-3", "LIM9-4", "LIM9-5"],
    });
  });

  it("asks for a read only and names no answer in the prompt", () => {
    const prompt = codingJiraPrompt(PROJECT);
    expect(prompt).toContain(PROJECT);
    expect(prompt).toMatch(/Do not edit any file/u);
    expect(prompt).not.toMatch(/LIM9-\d/u);
    expect(() => codingJiraPrompt("bad key")).toThrow(TypeError);
  });

  it("accepts the exact count and all five keys", () => {
    const truth = epicTruth(issues);
    const answer = "There are 12 Epics. First: LIM9-1, LIM9-2, LIM9-3, LIM9-4 and LIM9-5.";
    expect(gradeCodingAnswer(answer, truth)).toEqual({ ok: true, countNamed: true, keysNamed: 5 });
  });

  it.each([
    ["a wrong count", "There are 13 Epics: LIM9-1, LIM9-2, LIM9-3, LIM9-4, LIM9-5."],
    ["a missing key", "There are 12 Epics: LIM9-1, LIM9-2, LIM9-3, LIM9-4."],
    ["a key only as the prefix of another", "12 Epics: LIM9-1, LIM9-2, LIM9-3, LIM9-4, LIM9-50."],
    ["the count only inside a key", "LIM9-12 LIM9-1 LIM9-2 LIM9-3 LIM9-4 LIM9-5"],
    ["no answer at all", ""],
  ])("refuses %s", (_name, answer) => {
    expect(gradeCodingAnswer(answer, epicTruth(issues)).ok).toBe(false);
  });

  it("never accepts an answer when Jira holds no Epic", () => {
    expect(gradeCodingAnswer("0 Epics", { count: 0, firstKeys: [] }).ok).toBe(false);
  });
});

describe("the Activity Log oracle of the Coding surface", () => {
  it("accepts a bound Pod and a completed read call inside the run", () => {
    expect(grade([bound(), read()])).toEqual({
      ok: true,
      counts: { bound: 1, reads: 1, writes: 0, failed: 0, correlated: 2 },
    });
  });

  it("refuses a run without a binding or without a completed read", () => {
    expect(grade([read()]).ok).toBe(false);
    expect(grade([bound()]).ok).toBe(false);
    expect(
      grade([
        bound(),
        line({ action: "call", outcome: "failed", toolClass: "jira-read", risk: "read" }),
      ]),
    ).toMatchObject({ ok: false, counts: { reads: 0, failed: 1 } });
  });

  it("refuses any Jira write attempt of the run", () => {
    const write = line({ action: "call", outcome: "refused", toolClass: "jira-write" });
    expect(grade([bound(), read(), write])).toMatchObject({ ok: false, counts: { writes: 1 } });
  });

  it("ignores lines outside the run window and lines of other operations", () => {
    const early = read("2026-11-10T08:59:59.000Z");
    const late = read("2026-11-10T09:05:01.000Z");
    const other = { ...read(), op: "chat.tool-turn.ended" };
    const unstamped = { ...read(), ts: undefined };
    expect(grade([bound(), early, late, other, unstamped]).counts.reads).toBe(0);
  });

  it("separates the run's own correlation from lines that only share its window", () => {
    const foreign = line(
      { action: "call", outcome: "completed", toolClass: "jira-read" },
      undefined,
      "another-correlation",
    );
    expect(grade([bound(), foreign]).counts).toMatchObject({ reads: 1, correlated: 1 });
  });
});

describe("the unchanged-Jira check", () => {
  it("accepts the same issues with the same update times", () => {
    expect(jiraUnchanged(issues, structuredClone(issues).reverse())).toBe(true);
  });

  it("refuses an added issue, a removed issue and a changed update time", () => {
    expect(jiraUnchanged(issues, [...issues, issue(99)])).toBe(false);
    expect(jiraUnchanged(issues, issues.slice(1))).toBe(false);
    const touched = structuredClone(issues);
    touched[0].fields.updated = "2026-11-10T09:02:00.000+0100";
    expect(jiraUnchanged(issues, touched)).toBe(false);
  });
});

function runFixture({ drive, events = [bound(), read()], searches } = {}) {
  const sessionDir = mkdtempSync(join(tmpdir(), "coding-jira-"));
  directories.push(sessionDir);
  const record = vi.fn(async () => undefined);
  const search = vi.fn();
  for (const result of searches ?? [issues, issues]) search.mockResolvedValueOnce(result);
  const ctx = {
    sessionDir,
    projectKey: PROJECT,
    origin: "http://127.0.0.1:1",
    secret: "secret",
    modelId: "model",
    projectPath: "/workspace",
    search,
    intent: { record },
  };
  const driven = {
    runId: RUN,
    state: "succeeded",
    text: "12 Epics: LIM9-1, LIM9-2, LIM9-3, LIM9-4, LIM9-5",
    startedAtMs: STARTED,
    endedAtMs: ENDED,
  };
  return {
    ctx,
    record,
    ports: {
      drive: drive ?? vi.fn(async () => driven),
      events: vi.fn(async () => events),
    },
    driven,
  };
}

describe("the Coding step", () => {
  it("is green when the answer, Jira and the Activity Log all agree", async () => {
    const f = runFixture();
    const outcome = await runCodingJira(f.ctx, f.ports);
    expect(outcome).toMatchObject({
      step: "ac10-coding-jira",
      status: "green",
      counts: { epics: 12, keysNamed: 5, countNamed: 1, jiraChanged: 0, bound: 1, reads: 1 },
    });
    expect(f.ports.drive).toHaveBeenCalledWith(f.ctx, codingJiraPrompt(PROJECT));
    expect(f.record).toHaveBeenCalledWith(
      "ac10-coding-jira",
      expect.objectContaining({ status: "green" }),
    );
  });

  it("is red when the answer is wrong although the log shows a read", async () => {
    const f = runFixture();
    f.ports.drive = vi.fn(async () => ({ ...f.driven, text: "I found 3 Epics." }));
    expect((await runCodingJira(f.ctx, f.ports)).status).toBe("red");
  });

  it("is red when the run did not succeed", async () => {
    const f = runFixture();
    f.ports.drive = vi.fn(async () => ({ ...f.driven, state: "failed" }));
    expect((await runCodingJira(f.ctx, f.ports)).status).toBe("red");
  });

  it("is red when the log shows no Jira read from the Coding surface", async () => {
    const f = runFixture({ events: [bound()] });
    const outcome = await runCodingJira(f.ctx, { ...f.ports, settleMs: 0 });
    expect(outcome.status).toBe("red");
    expect(outcome.counts).toMatchObject({ bound: 1, reads: 0 });
  });

  it("is red when Jira changed during the run", async () => {
    const changed = [...issues, issue(99, "Task")];
    const f = runFixture({ searches: [issues, changed] });
    expect(await runCodingJira(f.ctx, f.ports)).toMatchObject({
      status: "red",
      counts: { jiraChanged: 1 },
    });
  });

  it("is unverified when the runtime is unavailable, Epics are missing or the run throws", async () => {
    const unavailable = runFixture({ drive: vi.fn(async () => ({ unavailable: true })) });
    expect((await runCodingJira(unavailable.ctx, unavailable.ports)).detail).toContain(
      "coding-runtime-unavailable",
    );
    const few = runFixture({ searches: [issues.slice(0, 3)] });
    expect((await runCodingJira(few.ctx, few.ports)).detail).toContain("epics-unavailable");
    expect(few.ports.drive).not.toHaveBeenCalled();
    const broken = runFixture({
      drive: vi.fn(async () => {
        throw new TypeError("the Workbench refused the start\nwith detail");
      }),
    });
    const outcome = await runCodingJira(broken.ctx, broken.ports);
    expect(outcome.status).toBe("unverified");
    expect(outcome.detail).toContain("the Workbench refused the start with detail");
    expect(outcome.detail).not.toMatch(/\n/u);
    expect((await runCodingJira({}, {})).detail).toContain("context-unavailable");
  });
});
