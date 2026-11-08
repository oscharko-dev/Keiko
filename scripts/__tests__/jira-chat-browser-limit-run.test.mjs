import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { URL } from "node:url";
import {
  createLimitRunIntent,
  limitRunArguments,
  loadLimitRunBlocks,
  readLimitFieldTruth,
  runBrowserLimitRun,
  validateLimitStepResult,
} from "../testing/jira-chat-lab/browser-limit-run.mjs";
import { privateJson } from "../testing/jira-chat-lab/private-json.mjs";

const directories = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), "keiko-limit-run-"));
  directories.push(path);
  return path;
}
const NAMES = [
  "runProjectSetup",
  "installTemplates",
  "runRuleProbes",
  "stageLastenheft",
  "runBulkEpics",
  "gradeBulkRefusals",
  "runHierarchyBulk",
  "runSprintBulk",
  "simulateProgress",
  "runProgressReport",
  "createFaultPlan",
  "assertCardsReadable",
  "setUiLanguage",
];
const result = (step) => ({
  step,
  status: "green",
  detail: "Independent fixture observation",
  counts: { observed: 1 },
});
function fixture() {
  const sessionDir = directory();
  const intent = createLimitRunIntent(sessionDir, { projectKey: "LIM7", modelId: "fixture-model" });
  const controller = new globalThis.AbortController();
  const ctx = {
    sessionDir,
    session: {},
    page: {},
    projectKey: "LIM7",
    locale: "en",
    modelId: "fixture-model",
    intent,
    signal: controller.signal,
    checkLicense: vi.fn(() => Promise.resolve(2700)),
    prepareTruth: vi.fn(() => Promise.resolve()),
    chat: { id: "document-chat" },
    reportChat: { id: "report-chat" },
    deniedChat: { id: "denied-chat" },
  };
  const calls = [];
  const blocks = Object.fromEntries(
    NAMES.map((name) => [
      name,
      vi.fn(async (context, options) => {
        calls.push({ name, context, options, locale: context.locale, faults: context.faults });
        return result(name.replaceAll(/[A-Z]/gu, (value) => `-${value.toLowerCase()}`));
      }),
    ]),
  );
  const plans = [];
  blocks.createFaultPlan.mockImplementation((options) => {
    const plan = { maybeInject: vi.fn(() => Promise.resolve()), options };
    plans.push(plan);
    return plan;
  });
  blocks.runBulkEpics.mockImplementation(async (context, options) => {
    calls.push({ name: "runBulkEpics", context, options });
    intent.update({
      bulkEpics: {
        seeded: Array.from({ length: 46 }, (_, index) => ({
          requirementId: `REQ-FA-${String(index + 1).padStart(3, "0")}`,
          ruleId: "summary-pattern",
        })),
      },
    });
    return result("ac2-bulk-epics");
  });
  blocks.simulateProgress.mockImplementation(async (context, options) => {
    calls.push({ name: "simulateProgress", context, options });
    const evidenceFile = join(sessionDir, "progress-truth.json");
    privateJson(evidenceFile, { total: 1007, statuses: { todo: 1007 } }, true);
    return { ...result("progress-simulation"), evidenceFile };
  });
  return { ctx, blocks, calls, plans, controller };
}

it("composes the exact owners once in plan order, with bilingual reload checks after epics, sprint and report", async () => {
  const f = fixture();
  const answer = await runBrowserLimitRun(f.ctx, {}, f.blocks);
  expect(answer).toEqual({
    step: "browser-limit-run",
    status: "green",
    detail: "All limit-run steps independently verified",
    counts: { steps: 25 },
    evidenceFile: f.ctx.intent.path,
  });
  expect(
    f.calls
      .filter(({ name }) => !["setUiLanguage", "assertCardsReadable"].includes(name))
      .map(({ name }) => name),
  ).toEqual([
    "runProjectSetup",
    "installTemplates",
    "runRuleProbes",
    "stageLastenheft",
    "runBulkEpics",
    "gradeBulkRefusals",
    "runHierarchyBulk",
    "runSprintBulk",
    "simulateProgress",
    "runProgressReport",
  ]);
  expect(f.calls.every(({ context }) => context === f.ctx)).toBe(true);
  expect(f.blocks.runProjectSetup).toHaveBeenCalledWith(f.ctx, { deniedActor: true });
  expect(f.blocks.runRuleProbes).toHaveBeenCalledWith(f.ctx, {
    modes: ["governed-assist", "supervised-coding", "autonomous-delivery"],
  });
  expect(f.blocks.runBulkEpics).toHaveBeenCalledWith(f.ctx, {
    violationRate: 0.125,
    faults: f.plans[0],
  });
  expect(f.blocks.runHierarchyBulk).toHaveBeenCalledWith(f.ctx, { faults: f.plans[1] });
  expect(f.blocks.runSprintBulk).toHaveBeenCalledWith(f.ctx, { size: 250, batch: 50 });
  expect(f.ctx.faults).toBe(f.plans[2]);
  expect(new Set(f.plans).size).toBe(3);
  for (const [index, scope] of ["bulk-epics", "hierarchy", "progress"].entries())
    expect(f.plans[index].options).toEqual({
      scope,
      at: [0.4, 0.8],
      kinds: ["response-drop", "server-kill"],
    });
  expect(f.calls.find(({ name }) => name === "runSprintBulk").faults).toBeUndefined();
  expect(f.blocks.simulateProgress).toHaveBeenCalledWith(f.ctx, { seedDeviations: true });
  expect(f.blocks.runProgressReport).toHaveBeenCalledWith(f.ctx, {
    truthFile: join(f.ctx.sessionDir, "progress-truth.json"),
  });
  expect(
    f.calls
      .filter(({ name }) => name === "assertCardsReadable")
      .map(({ locale, options }) => ({ locale, options })),
  ).toEqual(
    Array.from({ length: 3 }, () => [
      { locale: "en", options: { reload: true } },
      { locale: "de", options: { reload: true } },
    ]).flat(),
  );
  const observedNames = f.calls.map(({ name }) => name);
  for (const [before, after] of [
    ["gradeBulkRefusals", "runHierarchyBulk"],
    ["runSprintBulk", "simulateProgress"],
    ["runProgressReport", undefined],
  ]) {
    const start = observedNames.indexOf(before) + 1;
    const end = after === undefined ? observedNames.length : observedNames.indexOf(after);
    expect(observedNames.slice(start, end)).toEqual([
      "setUiLanguage",
      "assertCardsReadable",
      "setUiLanguage",
      "assertCardsReadable",
      "setUiLanguage",
    ]);
  }
  expect(f.ctx.checkLicense).toHaveBeenCalledTimes(25);
  expect(f.ctx.prepareTruth).toHaveBeenCalledTimes(1);
  expect(f.ctx.locale).toBe("en");
  const saved = JSON.parse(readFileSync(f.ctx.intent.path, "utf8"));
  expect(saved.phase).toBe("checkpoint");
  expect(saved.current).toBeUndefined();
  expect(saved.results).toHaveLength(25);
  expect(saved.data.orchestrator.phase).toBe("steps-verified");
  expect(statSync(f.ctx.intent.path).mode & 0o777).toBe(0o600);
});

it.each(["red", "unverified"])(
  "stops at a %s rule oracle and retains an incomplete private intent",
  async (status) => {
    const f = fixture();
    f.blocks.gradeBulkRefusals.mockResolvedValue({ ...result("bulk-refusals"), status });
    await expect(runBrowserLimitRun(f.ctx, {}, f.blocks)).rejects.toThrow("incomplete");
    expect(f.blocks.runHierarchyBulk).not.toHaveBeenCalled();
    expect(f.blocks.runSprintBulk).not.toHaveBeenCalled();
    expect(f.blocks.assertCardsReadable).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(f.ctx.intent.path, "utf8"))).toMatchObject({
      phase: "incomplete",
    });
  },
);

it("retains an uncertain write boundary and never retries or re-reserves it", async () => {
  const f = fixture();
  f.blocks.runBulkEpics.mockRejectedValue(new TypeError("Fixture transport lost after dispatch"));
  await expect(runBrowserLimitRun(f.ctx, {}, f.blocks)).rejects.toThrow("lost");
  expect(f.blocks.runBulkEpics).toHaveBeenCalledTimes(1);
  expect(f.blocks.gradeBulkRefusals).not.toHaveBeenCalled();
  const before = readFileSync(f.ctx.intent.path, "utf8");
  expect(JSON.parse(before)).toMatchObject({ phase: "incomplete", current: "ac2-epics" });
  expect(() => createLimitRunIntent(f.ctx.sessionDir, { projectKey: "LIM8" })).toThrow();
  expect(readFileSync(f.ctx.intent.path, "utf8")).toBe(before);
});

it("aborts before the first owner and refuses an expired license before the next write", async () => {
  const f = fixture();
  f.controller.abort(new TypeError("Fixture cancellation"));
  await expect(runBrowserLimitRun(f.ctx, {}, f.blocks)).rejects.toThrow("cancellation");
  expect(f.blocks.runProjectSetup).not.toHaveBeenCalled();
  const g = fixture();
  g.ctx.checkLicense.mockRejectedValueOnce(new TypeError("Fixture license unavailable"));
  await expect(runBrowserLimitRun(g.ctx, {}, g.blocks)).rejects.toThrow("license");
  expect(g.blocks.runProjectSetup).not.toHaveBeenCalled();
});

it.each([
  "runProjectSetup",
  "gradeBulkRefusals",
  "runHierarchyBulk",
  "assertCardsReadable",
  "createFaultPlan",
])("refuses missing %s before any live action", async (name) => {
  const f = fixture();
  f.blocks[name] = undefined;
  await expect(runBrowserLimitRun(f.ctx, {}, f.blocks)).rejects.toThrow();
  expect(f.calls).toEqual([]);
});

it.each([0, 0.09, 0.151, Number.NaN, Number.POSITIVE_INFINITY])(
  "refuses violation rate %s",
  async (violationRate) => {
    const f = fixture();
    await expect(runBrowserLimitRun(f.ctx, { violationRate }, f.blocks)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  },
);
it.each([0, 199, 301, 250.5])("refuses sprint size %s", async (sprintSize) => {
  const f = fixture();
  await expect(runBrowserLimitRun(f.ctx, { sprintSize }, f.blocks)).rejects.toThrow();
  expect(f.calls).toEqual([]);
});

it("requires seeded independent refusals and a private progress truth before the reporting step", async () => {
  const f = fixture();
  f.blocks.runBulkEpics.mockResolvedValue(result("ac2-bulk-epics"));
  await expect(runBrowserLimitRun(f.ctx, {}, f.blocks)).rejects.toThrow("rule-violation");
  expect(f.blocks.gradeBulkRefusals).not.toHaveBeenCalled();
  const g = fixture();
  g.blocks.simulateProgress.mockResolvedValue(result("progress-simulation"));
  await expect(runBrowserLimitRun(g.ctx, {}, g.blocks)).rejects.toThrow("private truth");
  expect(g.blocks.runProgressReport).not.toHaveBeenCalled();
});

it("loads exactly the fixed exports and does not silently replace an absent owner", async () => {
  const module = Object.fromEntries(NAMES.map((name) => [name, vi.fn()]));
  const importer = vi.fn(() => Promise.resolve(module));
  const loaded = await loadLimitRunBlocks(importer);
  expect(Object.keys(loaded)).toEqual(NAMES);
  expect(loaded.runHierarchyBulk).toBe(module.runHierarchyBulk);
  expect(importer.mock.calls.map(([path]) => path)).toContain("./browser-bulk-fault.mjs");
  expect(new Set(importer.mock.calls.map(([path]) => path)).size).toBe(importer.mock.calls.length);
  delete module.runProgressReport;
  await expect(loadLimitRunBlocks(importer)).rejects.toThrow("runProgressReport");
});

it("accepts only the explicit fresh-project runtime CLI inputs", () => {
  const args = [
    "/private/session",
    "fixture-chat",
    "fixture-embedding",
    "/private/permit",
    "/private/deny",
    "LIM7",
  ];
  expect(limitRunArguments(args)).toMatchObject({ projectKey: "LIM7", modelId: "fixture-chat" });
  for (const [index, value] of [
    [0, "relative"],
    [2, "fixture-chat"],
    [4, "/private/permit"],
    [5, "REQ"],
    [5, "LIM0"],
    [5, "LIM7 OR project=REQ"],
  ]) {
    const invalid = [...args];
    invalid[index] = value;
    expect(() => limitRunArguments(invalid)).toThrow();
  }
  expect(() => limitRunArguments([...args, "unexpected"])).toThrow();
});

it.each([
  { counts: { found: -1 } },
  { counts: { found: Number.NaN } },
  { counts: [] },
  { status: "skipped" },
  { detail: "two\nlines" },
  { step: "raw body here" },
])("rejects malformed step evidence %j", (change) => {
  const f = fixture();
  expect(() => validateLimitStepResult(f.ctx, { ...result("fixture-step"), ...change })).toThrow();
});

it("refuses public, non-JSON and escaped evidence rather than claiming an available result", () => {
  const f = fixture();
  const outside = join(directory(), "truth.json");
  privateJson(outside, { count: 1 }, true);
  expect(() =>
    validateLimitStepResult(f.ctx, { ...result("fixture-step"), evidenceFile: outside }),
  ).toThrow();
  const publicPath = join(f.ctx.sessionDir, "public.json");
  writeFileSync(publicPath, "{}", { mode: 0o644 });
  expect(() =>
    validateLimitStepResult(f.ctx, { ...result("fixture-step"), evidenceFile: publicPath }),
  ).toThrow();
  const invalid = join(f.ctx.sessionDir, "invalid.json");
  writeFileSync(invalid, "not-json", { mode: 0o600 });
  expect(() =>
    validateLimitStepResult(f.ctx, { ...result("fixture-step"), evidenceFile: invalid }),
  ).toThrow();
});

function metadataRead() {
  const types = ["Epic", "Task", "Bug", "Sub-task"].map((name, index) => ({
    id: String(index + 1),
    name,
  }));
  return vi.fn((path) => {
    if (path === "/rest/api/2/field")
      return Promise.resolve([
        { id: "customfield_10000", schema: { custom: "com.pyxis.greenhopper.jira:gh-epic-link" } },
      ]);
    if (path.includes("/issuetypes?"))
      return Promise.resolve({ startAt: 0, maxResults: 50, total: 4, values: types });
    const fields = [
      { fieldId: "summary", required: true },
      { fieldId: "description", required: true },
      { fieldId: "labels", required: false },
    ];
    return Promise.resolve({ startAt: 0, maxResults: 100, total: fields.length, values: fields });
  });
}
it("reads actual native required fields for all four issue types without inheriting a product projection", async () => {
  const read = metadataRead();
  expect(await readLimitFieldTruth(read, "LIM7")).toEqual({
    fieldIds: { epicLink: "customfield_10000" },
    requiredFieldsByType: {
      Epic: ["summary", "description"],
      Task: ["summary", "description"],
      Bug: ["summary", "description"],
      "Sub-task": ["summary", "description"],
    },
  });
  expect(read).toHaveBeenCalledTimes(6);
  expect(
    read.mock.calls.every(
      ([path]) => path === "/rest/api/2/field" || path.includes("/createmeta/LIM7/"),
    ),
  ).toBe(true);
});

it("includes required fields beyond the first hundred native metadata rows", async () => {
  const read = metadataRead();
  const original = read.getMockImplementation();
  read.mockImplementation((path) => {
    if (!/issuetypes\/[1-9]/u.test(path)) return original(path);
    const startAt = Number(new URL(path, "https://oracle.invalid").searchParams.get("startAt"));
    const fields = Array.from({ length: 101 }, (_, index) => ({
      fieldId: index === 0 ? "summary" : `customfield_${String(10000 + index)}`,
      required: index === 0 || index === 100,
    }));
    return Promise.resolve({
      startAt,
      maxResults: 100,
      total: 101,
      values: fields.slice(startAt, startAt + 100),
    });
  });
  const truth = await readLimitFieldTruth(read, "LIM7");
  expect(truth.requiredFieldsByType).toEqual({
    Epic: ["summary", "customfield_10100"],
    Task: ["summary", "customfield_10100"],
    Bug: ["summary", "customfield_10100"],
    "Sub-task": ["summary", "customfield_10100"],
  });
  expect(
    read.mock.calls.filter(([path]) => path.endsWith("startAt=100&maxResults=100")),
  ).toHaveLength(4);
});

it.each([
  "missing-total",
  "unknown-required",
  "duplicate-field",
  "partial-empty",
  "invalid-page-size",
])("refuses %s metadata instead of proving full required-field coverage", async (kind) => {
  const read = metadataRead();
  const original = read.getMockImplementation();
  read.mockImplementation((path) => {
    if (!/issuetypes\/[1-9]/u.test(path)) return original(path);
    const body = {
      startAt: 0,
      maxResults: 100,
      total: 1,
      values: [{ fieldId: "summary", required: true }],
    };
    if (kind === "missing-total") delete body.total;
    if (kind === "unknown-required") delete body.values[0].required;
    if (kind === "duplicate-field") {
      body.total = 2;
      body.values.push(body.values[0]);
    }
    if (kind === "partial-empty") body.values = [];
    if (kind === "invalid-page-size") body.maxResults = 0;
    return Promise.resolve(body);
  });
  await expect(readLimitFieldTruth(read, "LIM7")).rejects.toThrow();
});
