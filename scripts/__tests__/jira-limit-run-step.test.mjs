import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLimitStep } from "../testing/jira-chat-lab/limit-run-step.mjs";
import { privateJson } from "../testing/jira-chat-lab/private-json.mjs";

let directory;
let controller;
let ctx;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "keiko-limit-step-"));
  controller = new globalThis.AbortController();
  ctx = {
    sessionDir: directory,
    projectKey: "LIM7",
    intent: { owner: "retained", phase: "exclusive" },
    signal: controller.signal,
  };
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const skill = {
  id: "msk_01234567-89ab-4cde-8fab-0123456789ab",
  revision: 1,
  digest: "a".repeat(64),
  issueType: "Epic",
};

describe("private limit-run step journal", () => {
  it("syncs the initial private journal before optional parent persistence and preserves the exclusive intent", async () => {
    const existingIntent = join(directory, "parent-intent.json");
    privateJson(existingIntent, { phase: "exclusive", owner: "retained" }, true);
    const parent = readFileSync(existingIntent, "utf8");
    ctx.intent.persist = vi.fn(() => {
      const path = join(directory, "limit-run-LIM7-w12-templates.json");
      expect(read(path).phase).toBe("prepared");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });
    const journal = await openLimitStep(ctx, "w12-templates");
    expect(ctx.intent.steps["w12-templates"]).toBe(journal.state);
    expect(ctx.intent.persist).toHaveBeenCalledTimes(1);
    expect(ctx.intent.owner).toBe("retained");
    expect(ctx.intent.phase).toBe("exclusive");
    expect(readFileSync(existingIntent, "utf8")).toBe(parent);
  });
  it("restores pending evidence after process restart without changing its uncertain phase", async () => {
    const journal = await openLimitStep(ctx, "w12-templates");
    await journal.checkpoint({
      phase: "pending",
      resources: { projectId: "10037", epicLinkFieldId: "customfield_10013", templates: [skill] },
      counts: { templates: 4, installed: 1 },
    });
    const restarted = await openLimitStep({ ...ctx, intent: {} }, "w12-templates");
    expect(restarted.state).toEqual(journal.state);
    expect(restarted.state.phase).toBe("pending");
    await expect(restarted.checkpoint({ phase: "prepared" })).rejects.toThrow("Invalid limit step");
    expect(
      await restarted.result("unverified", "templates-pending-unverified", {
        templates: 4,
        installed: 1,
        verified: 0,
      }),
    ).toEqual({
      step: "w12-templates",
      status: "unverified",
      detail: "templates-pending-unverified",
      counts: { templates: 4, installed: 1, verified: 0 },
      evidenceFile: journal.evidenceFile,
    });
    expect(read(journal.evidenceFile).phase).toBe("pending");
  });
  it("retains completed native identities for read-only reverification without rearming the step", async () => {
    const journal = await openLimitStep(ctx, "w12-rule-probes");
    await journal.checkpoint({
      phase: "pending",
      resources: { chatId: "01234567-89ab-4cde-8fab-0123456789ab", baselineDigest: "b".repeat(64) },
    });
    await journal.checkpoint({
      phase: "completed",
      resources: {
        completedModes: ["governed-assist", "supervised-coding", "autonomous-delivery"],
      },
    });
    await journal.result("green", "rule-probes-confirmed", {
      requestedModes: 3,
      probedModes: 3,
      refusals: 3,
      nativeWrites: 0,
      approvals: 3,
    });
    const resumed = await openLimitStep({ ...ctx, intent: {} }, "w12-rule-probes");
    expect(resumed.state.phase).toBe("completed");
    expect(resumed.state.resources.baselineDigest).toBe("b".repeat(64));
    expect(resumed.state.resources.completedModes).toHaveLength(3);
    await expect(resumed.checkpoint({ phase: "pending" })).rejects.toThrow("Invalid limit step");
  });
  it("recovers a journal persisted before parent persistence failed", async () => {
    const journal = await openLimitStep(ctx, "w12-templates");
    const staleParent = structuredClone(ctx.intent);
    ctx.intent.persist = vi.fn(() => {
      throw new Error("Synthetic parent persistence failure");
    });
    await expect(
      journal.checkpoint({ phase: "pending", counts: { templates: 4 } }),
    ).rejects.toThrow("parent persistence");
    const resumed = await openLimitStep({ ...ctx, intent: staleParent }, "w12-templates");
    expect(resumed.state.phase).toBe("pending");
    expect(resumed.state.revision).toBe(1);
  });
  it("snapshots caller metadata so later mutation cannot introduce body content into retained state", async () => {
    const journal = await openLimitStep(ctx, "w12-templates");
    const templates = [{ ...skill }];
    await journal.checkpoint({ phase: "pending", resources: { templates } });
    templates[0].digest = "private body";
    expect(journal.state.resources.templates[0].digest).toBe(skill.digest);
    const observed = { installed: 1 };
    await journal.result("unverified", "templates-pending-unverified", observed);
    observed.installed = 999;
    expect(journal.state.result.counts.installed).toBe(1);
    expect(readFileSync(journal.evidenceFile, "utf8")).not.toContain("private body");
  });
  it("retains each step independently in the existing intent", async () => {
    const templates = await openLimitStep(ctx, "w12-templates");
    await templates.checkpoint({ phase: "pending" });
    const probes = await openLimitStep(ctx, "w12-rule-probes");
    expect(probes.state.phase).toBe("prepared");
    expect(ctx.intent.steps["w12-templates"]).toBe(templates.state);
    expect(probes.evidenceFile).not.toBe(templates.evidenceFile);
  });
  it.each(["../escape", "LIM7/secret", "LIM7\\secret", "LIM7\n", "https://secret.invalid", "lim7"])(
    "refuses unsafe project identity %j",
    async (projectKey) => {
      await expect(openLimitStep({ ...ctx, projectKey }, "w12-templates")).rejects.toThrow(
        "Invalid limit step",
      );
      expect(ctx.intent.steps).toBeUndefined();
    },
  );
  it("refuses a step outside the closed W12 inventory", async () => {
    await expect(openLimitStep(ctx, "../../parent")).rejects.toThrow("Invalid limit step");
  });
  it.each([
    { phase: "retry" },
    { prompt: "private body" },
    { resources: null },
    { resources: { projectId: "Bearer private-credential" } },
    { resources: { projectId: 10037 } },
    { resources: { templates: [{ ...skill, body: "private body" }] } },
    { resources: { templates: [{ ...skill, id: "private text" }] } },
    { resources: { templates: [{ ...skill, digest: "Authorization: private" }] } },
    { resources: { templates: [{ ...skill, issueType: "foreign" }] } },
    { counts: { privateBody: 1 } },
    { counts: { installed: -1 } },
    { counts: { installed: Infinity } },
  ])(
    "refuses invalid or body-carrying checkpoint %j without mutating persisted state",
    async (patch) => {
      const journal = await openLimitStep(ctx, "w12-templates");
      const before = readFileSync(journal.evidenceFile, "utf8");
      await expect(journal.checkpoint(patch)).rejects.toThrow("Invalid limit step");
      expect(readFileSync(journal.evidenceFile, "utf8")).toBe(before);
      expect(journal.state.phase).toBe("prepared");
    },
  );
  it.each([
    { resources: { chatId: "private text" } },
    { resources: { baselineDigest: "private body" } },
    { resources: { completedModes: ["ungoverned"] } },
    { resources: { completedModes: ["governed-assist", "governed-assist"] } },
    { resources: { answer: "private body" } },
  ])("refuses unsafe probe state %j", async (patch) => {
    const journal = await openLimitStep(ctx, "w12-rule-probes");
    await expect(journal.checkpoint(patch)).rejects.toThrow("Invalid limit step");
  });
  it("persists only closed result codes and numeric counts", async () => {
    const journal = await openLimitStep(ctx, "w12-templates");
    await expect(
      journal.result("green", "raw answer with private text", { installed: 4 }),
    ).rejects.toThrow("Invalid limit step");
    await expect(
      journal.result("green", "templates-installed", { installed: "private body" }),
    ).rejects.toThrow("Invalid limit step");
    await expect(
      journal.result("approved", "templates-installed", { installed: 4 }),
    ).rejects.toThrow("Invalid limit step");
    const result = await journal.result("green", "templates-installed", {
      templates: 4,
      installed: 4,
      verified: 4,
    });
    expect(Object.keys(result).sort()).toEqual([
      "counts",
      "detail",
      "evidenceFile",
      "status",
      "step",
    ]);
    expect(read(journal.evidenceFile).result).not.toHaveProperty("evidenceFile");
    expect(read(journal.evidenceFile).phase).toBe("prepared");
  });
  it("guards aborted opens and checkpoints, but records an unverified abort without leaking the reason", async () => {
    const journal = await openLimitStep(ctx, "w12-templates");
    controller.abort("private abort reason");
    await expect(openLimitStep(ctx, "w12-rule-probes")).rejects.toMatchObject({
      name: "AbortError",
      message: "limit-step-aborted",
    });
    await expect(journal.checkpoint({ phase: "pending" })).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(
      journal.result("green", "templates-installed", { installed: 4 }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await journal.result("unverified", "templates-aborted", { installed: 0 });
    expect(readFileSync(journal.evidenceFile, "utf8")).not.toContain("private abort reason");
  });
  it.each(["schemaVersion", "projectKey", "step", "phase"])(
    "refuses mismatched persisted %s without replacing it",
    async (field) => {
      const journal = await openLimitStep(ctx, "w12-templates");
      const corrupt = { ...read(journal.evidenceFile), [field]: "foreign" };
      privateJson(journal.evidenceFile, corrupt);
      await expect(openLimitStep({ ...ctx, intent: {} }, "w12-templates")).rejects.toThrow(
        "Invalid limit step",
      );
      expect(read(journal.evidenceFile)).toEqual(corrupt);
    },
  );
  it("refuses public, symlinked and malformed existing journals with closed errors", async () => {
    const journal = await openLimitStep(ctx, "w12-templates");
    chmodSync(journal.evidenceFile, 0o644);
    await expect(openLimitStep({ ...ctx, intent: {} }, "w12-templates")).rejects.toThrow(
      "Invalid limit step",
    );
    rmSync(journal.evidenceFile);
    const target = join(directory, "other-private.json");
    privateJson(target, journal.state, true);
    symlinkSync(target, journal.evidenceFile);
    await expect(openLimitStep({ ...ctx, intent: {} }, "w12-templates")).rejects.toThrow(
      "Invalid limit step",
    );
    rmSync(journal.evidenceFile);
    writeFileSync(journal.evidenceFile, '{"secret":"private malformed body', { mode: 0o600 });
    await expect(openLimitStep({ ...ctx, intent: {} }, "w12-templates")).rejects.toThrow(
      /^Invalid limit step journal$/u,
    );
  });
  it("refuses an on-disk rollback or same-revision disagreement with retained intent", async () => {
    const journal = await openLimitStep(ctx, "w12-templates");
    const initial = read(journal.evidenceFile);
    await journal.checkpoint({ phase: "pending" });
    privateJson(journal.evidenceFile, initial);
    await expect(openLimitStep(ctx, "w12-templates")).rejects.toThrow("Invalid limit step");
    privateJson(journal.evidenceFile, { ...journal.state, phase: "completed" });
    await expect(openLimitStep(ctx, "w12-templates")).rejects.toThrow("Invalid limit step");
  });
});
