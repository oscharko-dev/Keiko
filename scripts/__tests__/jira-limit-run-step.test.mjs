import { beforeEach, describe, expect, it, vi } from "vitest";
import { openLimitStep } from "../testing/jira-chat-lab/limit-run-step.mjs";
import { memoryLimitIntent } from "./helpers/limit-run-intent.mjs";

let ctx;
let controller;
const STEP = "w12-templates";
const skill = {
  id: "msk_01234567-89ab-4cde-8fab-0123456789ab",
  revision: 1,
  digest: "a".repeat(64),
  issueType: "Epic",
};
beforeEach(() => {
  controller = new globalThis.AbortController();
  ctx = {
    sessionDir: "/private/hermetic-limit-session",
    projectKey: "LIM7",
    intent: memoryLimitIntent({ otherOwner: { retained: true } }),
    signal: controller.signal,
  };
});

describe("step records in the sole orchestrator-owned intent", () => {
  it("records without a directory or second file and never exposes writable owner state", async () => {
    const journal = await openLimitStep(ctx, STEP);
    expect(ctx.intent.state[STEP]).toEqual(journal.state);
    expect(ctx.intent).not.toHaveProperty("steps");
    const snapshot = ctx.intent.state;
    snapshot[STEP].phase = "completed";
    expect(ctx.intent.state[STEP].phase).toBe("prepared");
    expect(ctx.intent.state.otherOwner).toEqual({ retained: true });
    expect(
      await journal.result("green", "templates-installed", { installed: 0 }),
    ).not.toHaveProperty("evidenceFile");
  });
  it("uses only the canonical path if the owner supplies one", async () => {
    ctx.intent = memoryLimitIntent({}, `${ctx.sessionDir}/intent.json`);
    const journal = await openLimitStep(ctx, STEP);
    expect(
      (await journal.result("unverified", "templates-pending-unverified", {})).evidenceFile,
    ).toBe(ctx.intent.path);
    expect(ctx.intent.state[STEP].result).not.toHaveProperty("evidenceFile");
  });
  it("records pending before yielding and resumes without rearming a native write", async () => {
    const journal = await openLimitStep(ctx, STEP);
    const pending = journal.checkpoint({ phase: "pending", resources: { templates: [skill] } });
    expect(ctx.intent.state[STEP].phase).toBe("pending");
    await pending;
    ctx.intent = memoryLimitIntent(ctx.intent.state);
    const resumed = await openLimitStep(ctx, STEP);
    expect(resumed.state).toEqual(journal.state);
    await expect(resumed.checkpoint({ phase: "prepared" })).rejects.toThrow("Invalid limit step");
  });
  it("snapshots caller resources and isolates local state from the canonical record", async () => {
    const journal = await openLimitStep(ctx, STEP);
    const templates = [structuredClone(skill)];
    await journal.checkpoint({ resources: { templates } });
    templates[0].digest = "private body";
    journal.state.resources.templates[0].digest = "private body";
    expect(ctx.intent.state[STEP].resources.templates[0].digest).toBe(skill.digest);
    await expect(journal.checkpoint({ counts: { installed: 1 } })).rejects.toThrow(
      "Invalid limit step",
    );
  });
  it("refuses a stale caller rather than overwriting newer completed work", async () => {
    const earlier = await openLimitStep(ctx, STEP);
    const newer = await openLimitStep(ctx, STEP);
    await newer.checkpoint({ phase: "pending", counts: { installed: 1 } });
    await expect(earlier.checkpoint({ counts: { installed: 0 } })).rejects.toThrow(
      "Invalid limit step",
    );
    expect(ctx.intent.state[STEP].counts.installed).toBe(1);
  });
  it("surfaces owner persistence failure before dispatch", async () => {
    const journal = await openLimitStep(ctx, STEP);
    vi.spyOn(ctx.intent, "record").mockImplementation(() => {
      throw new Error("owner unavailable");
    });
    await expect(journal.checkpoint({ phase: "pending" })).rejects.toThrow("owner unavailable");
    expect(ctx.intent.state[STEP].phase).toBe("prepared");
  });
  it.each([
    { projectKey: "../escape" },
    { sessionDir: "relative" },
    { intent: {} },
    { intent: { state: [], record: () => undefined } },
    { intent: memoryLimitIntent({}, "/outside/intent.json") },
  ])("refuses invalid context %#", async (patch) => {
    await expect(openLimitStep({ ...ctx, ...patch }, STEP)).rejects.toThrow("Invalid limit step");
  });
  it.each([
    { prompt: "private" },
    { resources: { templates: [{ ...skill, body: "private" }] } },
    { resources: { templates: [{ ...skill, digest: "private" }] } },
    { counts: { installed: -1 } },
    { counts: { installed: Infinity } },
    { counts: { installed: "private" } },
    { counts: { rawText: 1 } },
    { phase: "foreign" },
    { resources: { projectId: "https://private.invalid" } },
    { resources: { templates: Array.from({ length: 5 }, () => skill) } },
  ])("refuses invalid checkpoint %# before record", async (patch) => {
    const journal = await openLimitStep(ctx, STEP);
    const before = ctx.intent.state;
    await expect(journal.checkpoint(patch)).rejects.toThrow("Invalid limit step");
    expect(ctx.intent.state).toEqual(before);
  });
  it.each(["schemaVersion", "projectKey", "step", "phase"])(
    "refuses corrupt persisted %s",
    async (key) => {
      const journal = await openLimitStep(ctx, STEP);
      ctx.intent.record(STEP, { ...journal.state, [key]: "foreign" });
      const before = ctx.intent.state;
      await expect(openLimitStep(ctx, STEP)).rejects.toThrow("Invalid limit step");
      expect(ctx.intent.state).toEqual(before);
    },
  );
  it("retains only closed result fields and records cancellation without its private reason", async () => {
    const journal = await openLimitStep(ctx, STEP);
    await expect(journal.result("green", "private diagnostic", {})).rejects.toThrow(
      "Invalid limit step",
    );
    await expect(journal.result("foreign", "templates-installed", {})).rejects.toThrow(
      "Invalid limit step",
    );
    await expect(
      journal.result("green", "templates-installed", { installed: "private" }),
    ).rejects.toThrow("Invalid limit step");
    controller.abort("private abort reason");
    await expect(journal.checkpoint({ phase: "pending" })).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(openLimitStep(ctx, STEP)).rejects.toMatchObject({ name: "AbortError" });
    await expect(journal.result("green", "templates-installed", {})).rejects.toMatchObject({
      name: "AbortError",
    });
    await journal.result("unverified", "templates-aborted", {});
    expect(JSON.stringify(ctx.intent.state)).not.toContain("private abort reason");
  });
});

describe("extended record scopes", () => {
  const chatId = "01234567-89ab-4cde-8fab-0123456789ab";
  it.each([
    [
      "ac5-project",
      { deniedChatId: chatId, deniedActorClass: "restricted" },
      { deniedIssues: 0 },
      "denied-chat-unavailable",
    ],
    [
      "ac6-sprint-bulk",
      { boardId: "1", taskRefs: [{ id: "3", key: "LIM7-1" }] },
      { size: 300, unconfirmedReceipts: 1, wireWrites: 20 },
      "sprint-bulk-receipt-unconfirmed",
    ],
    ["ac9-ui-language-en", { locale: "en" }, { changes: 1 }, "ui-language-confirmed"],
    ["ac9-ui-language-de", { locale: "de" }, { changes: 0 }, "ui-language-confirmed"],
    [
      "ac9-cards-readable",
      { chatId, cardDigest: "a".repeat(64) },
      { cards: 3 },
      "cards-readable-confirmed",
    ],
  ])("retains closed %s facts in the same handle", async (step, resources, counts, detail) => {
    const journal = await openLimitStep(ctx, step);
    await journal.checkpoint({ phase: "completed", resources, counts });
    await journal.result("unverified", detail, counts);
    expect((await openLimitStep(ctx, step)).state.resources).toEqual(resources);
    await expect(journal.checkpoint({ resources: { body: "private" } })).rejects.toThrow(
      "Invalid limit step",
    );
  });
  it("retains 300 bounded task references at maximum project-key length", async () => {
    ctx.projectKey = "L".repeat(32);
    const journal = await openLimitStep(ctx, "ac6-sprint-bulk");
    const taskRefs = Array.from({ length: 300 }, (_, index) => ({
      id: String(index + 1),
      key: `${ctx.projectKey}-${index + 1}`,
    }));
    await journal.checkpoint({ phase: "pending", resources: { taskRefs } });
    expect((await openLimitStep(ctx, "ac6-sprint-bulk")).state.resources.taskRefs).toEqual(
      taskRefs,
    );
  });
  it.each([
    { taskRefs: [{ id: "1", key: "OTHER-1" }] },
    {
      taskRefs: [
        { id: "1", key: "LIM7-1" },
        { id: "1", key: "LIM7-2" },
      ],
    },
    {
      taskRefs: [
        { id: "1", key: "LIM7-1" },
        { id: "2", key: "LIM7-1" },
      ],
    },
    {
      taskRefs: Array.from({ length: 301 }, (_, index) => ({
        id: String(index + 1),
        key: `LIM7-${index + 1}`,
      })),
    },
    { doneKeys: Array.from({ length: 11 }, (_, index) => `LIM7-${index + 1}`) },
  ])("refuses unbound or oversized Sprint resources %#", async (resources) => {
    const journal = await openLimitStep(ctx, "ac6-sprint-bulk");
    await expect(journal.checkpoint({ resources })).rejects.toThrow("Invalid limit step");
  });
  it("rechecks a completed read-only observation without rearming a write", async () => {
    const journal = await openLimitStep(ctx, "ac9-ui-language-en");
    await journal.checkpoint({
      phase: "completed",
      resources: { locale: "en" },
      counts: { changes: 1 },
    });
    await journal.checkpoint({ counts: { changes: 0 } });
    await expect(journal.checkpoint({ phase: "pending" })).rejects.toThrow("Invalid limit step");
    expect(ctx.intent.state["ac9-ui-language-en"].counts.changes).toBe(0);
  });
});
