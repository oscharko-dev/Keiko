import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privateJson } from "../testing/jira-chat-lab/private-json.mjs";
import {
  createLimitRunIntent,
  readLimitFieldTruth,
} from "../testing/jira-chat-lab/browser-limit-run.mjs";
import {
  followupArguments,
  loadFollowupBlocks,
  openLimitFollowupIntent,
  prepareFollowupTruth,
  readCompletedLimitRun,
  runLimitFollowup,
} from "../testing/jira-chat-lab/limit-run-followup.mjs";

const directories = [];
const SESSION_ARGUMENTS = (directory) => [
  directory,
  "model-a",
  "embedding-a",
  join(directory, "permitted-token"),
  join(directory, "denied-token"),
  "LIM9",
];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function sessionDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "limit-followup-"));
  chmodSync(directory, 0o700);
  directories.push(directory);
  return directory;
}

/** A finished limit run: the pending file as the orchestrator leaves it. */
function finishedRun(directory, patch = {}) {
  const identity = followupArguments([...SESSION_ARGUMENTS(directory), "story"]);
  const { steps, ...options } = identity;
  const intent = createLimitRunIntent(directory, options);
  for (const slot of ["document", "report", "denied"])
    intent.record("chats", {
      ...intent.state.chats,
      [slot]: { chatId: `chat-${slot}`, podId: `pod-${slot}`, phase: "ready" },
    });
  intent.record("stateDirectory", join(directory, "keiko-jira-live-chat-x"));
  intent.record("fieldTruth", {
    fieldIds: { epicLink: "customfield_10014" },
    requiredFieldsByType: { Task: ["summary"] },
  });
  for (const step of ["ac2-epics", "ac4-hierarchy"]) {
    intent.begin(step);
    intent.settled(step, { step, status: "green" });
  }
  intent.record("orchestrator", { phase: "steps-verified", results: [] });
  intent.complete();
  if (patch.phase === "incomplete") intent.failed();
  return { options, intent };
}

describe("the follow-up arguments", () => {
  it("takes the six limit-run arguments and a step selection in fixed order", () => {
    const base = SESSION_ARGUMENTS("/tmp/session");
    expect(followupArguments([...base, "coding-jira,story"]).steps).toEqual([
      "story",
      "coding-jira",
    ]);
    expect(followupArguments([...base, "coding-jira"]).steps).toEqual(["coding-jira"]);
    expect(followupArguments([...base, "story"])).toMatchObject({
      projectKey: "LIM9",
      modelId: "model-a",
    });
  });

  it.each([
    ["no selection", (base) => base],
    ["an unknown step", (base) => [...base, "hierarchy"]],
    ["a repeated step", (base) => [...base, "story,story"]],
    ["an empty step", (base) => [...base, "story,"]],
    ["an extra argument", (base) => [...base, "story", "more"]],
  ])("refuses %s", (_name, build) => {
    expect(() => followupArguments(build(SESSION_ARGUMENTS("/tmp/session")))).toThrow();
  });

  it("keeps the limit-run argument validation for the project key", () => {
    const base = SESSION_ARGUMENTS("/tmp/session");
    base[5] = "WORK";
    expect(() => followupArguments([...base, "story"])).toThrow();
  });
});

describe("continuing a completed limit run", () => {
  it("copies the finished run's state into its own file and leaves the original untouched", () => {
    const directory = sessionDirectory();
    const { options, intent } = finishedRun(directory);
    const before = readFileSync(intent.path, "utf8");
    const followup = openLimitFollowupIntent(directory, options);
    expect(followup.path).toBe(join(directory, "browser-limit-followup.pending.json"));
    expect(followup.state.stateDirectory).toBe(intent.state.stateDirectory);
    expect(followup.state.chats.document).toMatchObject({ chatId: "chat-document" });
    followup.record("storyBulk", { phase: "ready" });
    expect(readFileSync(intent.path, "utf8")).toBe(before);
  });

  it("resumes the same follow-up file and keeps its own checkpoints", () => {
    const directory = sessionDirectory();
    const { options } = finishedRun(directory);
    openLimitFollowupIntent(directory, options).record("storyBulk", { phase: "writing" });
    expect(openLimitFollowupIntent(directory, options).state.storyBulk).toEqual({
      phase: "writing",
    });
  });

  it("refuses a limit run that did not complete or whose inputs differ", () => {
    const incomplete = sessionDirectory();
    const first = finishedRun(incomplete, { phase: "incomplete" });
    expect(() => openLimitFollowupIntent(incomplete, first.options)).toThrow("completed");
    const other = sessionDirectory();
    const second = finishedRun(other);
    expect(() => openLimitFollowupIntent(other, { ...second.options, modelId: "model-b" })).toThrow(
      "other inputs",
    );
    expect(() => readCompletedLimitRun(sessionDirectory(), second.options)).toThrow();
  });

  it("refuses a run that never verified its Epics and hierarchy", () => {
    const directory = sessionDirectory();
    const { steps, ...options } = followupArguments([...SESSION_ARGUMENTS(directory), "story"]);
    const intent = createLimitRunIntent(directory, options);
    intent.record("orchestrator", { phase: "steps-verified", results: [] });
    intent.complete();
    expect(steps).toEqual(["story"]);
    expect(() => readCompletedLimitRun(directory, options)).toThrow("Epics and hierarchy");
  });

  it("refuses a follow-up file that belongs to another limit run", () => {
    const directory = sessionDirectory();
    const { options } = finishedRun(directory);
    openLimitFollowupIntent(directory, options);
    const file = join(directory, "browser-limit-followup.pending.json");
    const state = JSON.parse(readFileSync(file, "utf8"));
    privateJson(file, { ...state, parentId: "00000000-0000-4000-8000-000000000000" });
    expect(() => openLimitFollowupIntent(directory, options)).toThrow("another limit run");
  });
});

describe("the follow-up field truth", () => {
  it("keeps the finished run's truth and adds the Story metadata", async () => {
    const readTruth = vi.fn(async () => ({
      fieldIds: { epicLink: "customfield_10014" },
      requiredFieldsByType: { Story: ["summary"] },
    }));
    const record = vi.fn();
    const ctx = {
      projectKey: "LIM9",
      read: vi.fn(),
      truth: { requirementCount: 370 },
      intent: {
        state: {
          fieldTruth: {
            fieldIds: { epicLink: "customfield_10014" },
            requiredFieldsByType: { Task: ["summary"] },
          },
        },
        record,
      },
    };
    await prepareFollowupTruth(ctx, readTruth);
    expect(readTruth).toHaveBeenCalledWith(ctx.read, "LIM9", ["Story"]);
    expect(ctx.truth).toMatchObject({
      requirementCount: 370,
      requiredFieldsByType: { Task: ["summary"], Story: ["summary"] },
    });
    await expect(
      prepareFollowupTruth({ ...ctx, intent: { state: {}, record } }, readTruth),
    ).rejects.toThrow("Field truth");
  });

  it("reads only the issue types it is asked for", async () => {
    const read = vi.fn(async (path) => {
      if (path === "/rest/api/2/field")
        return [
          {
            id: "customfield_10014",
            schema: { custom: "com.pyxis.greenhopper.jira:gh-epic-link" },
          },
        ];
      if (path.includes("/issuetypes?"))
        return {
          startAt: 0,
          total: 1,
          maxResults: 50,
          values: [{ id: "7", name: "Story" }],
        };
      return {
        startAt: 0,
        total: 2,
        maxResults: 100,
        values: [
          { fieldId: "summary", required: true },
          { fieldId: "labels", required: false },
        ],
      };
    });
    const truth = await readLimitFieldTruth(read, "LIM9", ["Story"]);
    expect(truth).toEqual({
      fieldIds: { epicLink: "customfield_10014" },
      requiredFieldsByType: { Story: ["summary"] },
    });
  });
});

describe("running the selected steps", () => {
  function fixture() {
    const directory = sessionDirectory();
    const { options } = finishedRun(directory);
    const intent = openLimitFollowupIntent(directory, options);
    const result = (step, status = "green") => ({
      step,
      status,
      detail: "Independently observed",
      counts: { items: 1 },
    });
    const blocks = {
      runStoryBulk: vi.fn(async () => result("ac4-story-bulk")),
      runCodingJira: vi.fn(async () => result("ac10-coding-jira")),
    };
    const ctx = {
      sessionDir: directory,
      signal: new globalThis.AbortController().signal,
      intent,
    };
    return { ctx, blocks, intent, result };
  }

  it("runs only the selected steps in order and completes its own intent", async () => {
    const f = fixture();
    const outcome = await runLimitFollowup(f.ctx, ["story", "coding-jira"], f.blocks);
    expect(outcome.status).toBe("green");
    expect(f.blocks.runStoryBulk.mock.invocationCallOrder[0]).toBeLessThan(
      f.blocks.runCodingJira.mock.invocationCallOrder[0],
    );
    const saved = JSON.parse(readFileSync(f.intent.path, "utf8"));
    expect(saved.phase).toBe("completed");
    // The finished run keeps its own results in its own file; the follow-up records only its steps.
    expect(saved.results.map((entry) => entry.step)).toEqual(["ac4-story", "ac10-coding-jira"]);
  });

  it("runs the Coding step alone without the Story step", async () => {
    const f = fixture();
    await runLimitFollowup(f.ctx, ["coding-jira"], f.blocks);
    expect(f.blocks.runStoryBulk).not.toHaveBeenCalled();
    expect(f.blocks.runCodingJira).toHaveBeenCalledOnce();
  });

  it("stops at the first step that is not green and keeps the intent incomplete", async () => {
    const f = fixture();
    f.blocks.runStoryBulk.mockResolvedValue(f.result("ac4-story-bulk", "red"));
    await expect(runLimitFollowup(f.ctx, ["story", "coding-jira"], f.blocks)).rejects.toThrow();
    expect(f.blocks.runCodingJira).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(f.intent.path, "utf8")).phase).toBe("incomplete");
  });

  it("loads the follow-up owners and refuses a missing export", async () => {
    const owners = {
      "./requirements/story-bulk.mjs": { runStoryBulk: () => undefined },
      "./requirements/coding-jira.mjs": { runCodingJira: () => undefined },
    };
    const blocks = await loadFollowupBlocks(async (path) => owners[path]);
    expect(Object.keys(blocks)).toEqual(["runStoryBulk", "runCodingJira"]);
    await expect(
      loadFollowupBlocks(async (path) => (path.includes("coding") ? {} : owners[path])),
    ).rejects.toThrow("Missing limit-run owner export");
  });
});
