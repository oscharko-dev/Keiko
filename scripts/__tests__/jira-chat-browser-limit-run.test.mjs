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

it.each([
  ["bulk-epics", "runBulkEpics", "runHierarchyBulk"],
  ["hierarchy", "runHierarchyBulk", "runSprintBulk"],
  ["progress", "simulateProgress", "runProgressReport"],
])(
  "settles the final %s fault pulse before the next product phase",
  async (scope, before, after) => {
    const f = fixture();
    await runBrowserLimitRun(f.ctx, {}, f.blocks);
    const plan = f.plans.find((entry) => entry.options.scope === scope);
    expect(plan.observedPulse).toHaveBeenCalledExactlyOnceWith(f.ctx, 1);
    const pulseOrder = plan.observedPulse.mock.invocationCallOrder[0];
    expect(pulseOrder).toBeGreaterThan(f.blocks[before].mock.invocationCallOrder[0]);
    expect(pulseOrder).toBeLessThan(f.blocks[after].mock.invocationCallOrder[0]);
    const saved = JSON.parse(readFileSync(f.ctx.intent.path, "utf8"));
    expect(saved.results.filter((entry) => entry.step === `ac8-${scope}`)).toEqual([
      { step: `ac8-${scope}`, result: faultResult(scope) },
    ]);
  },
);

it.each(["bulk-epics", "hierarchy", "progress"])(
  "keeps a final unverified %s fault from turning all-green product blocks into an overall green run",
  async (scope) => {
    const f = fixture();
    f.faultResults.set(scope, faultResult(scope, "unverified", { injected: 1, recovered: 1 }));
    await expect(runBrowserLimitRun(f.ctx, {}, f.blocks)).resolves.toMatchObject({
      step: "browser-limit-run",
      status: "unverified",
      counts: { steps: 28 },
      evidenceFile: f.ctx.intent.path,
    });
    expect(f.blocks.runProgressReport).toHaveBeenCalledOnce();
    const saved = JSON.parse(readFileSync(f.ctx.intent.path, "utf8"));
    expect(saved.phase).toBe("incomplete");
    expect(saved.data.orchestrator.phase).toBe("steps-unverified");
    expect(saved.results.find((entry) => entry.step === `ac8-${scope}`).result.status).toBe(
      "unverified",
    );
  },
);

it.each([
  ["bulk-epics", "runHierarchyBulk"],
  ["hierarchy", "runSprintBulk"],
  ["progress", "runProgressReport"],
])("stops later product work after a red %s fault oracle", async (scope, nextOwner) => {
  const f = fixture();
  f.faultResults.set(scope, faultResult(scope, "red", { recovered: 1, duplicates: 1 }));
  await expect(runBrowserLimitRun(f.ctx, {}, f.blocks)).rejects.toThrow(/incomplete/u);
  expect(f.blocks[nextOwner]).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(f.ctx.intent.path, "utf8")).phase).toBe("incomplete");
});

it.each(["pending", "skipped", "unverified"])(
  "rejects green fault evidence with a positive %s counter before later native writes",
  async (counter) => {
    const f = fixture();
    f.faultResults.set("bulk-epics", faultResult("bulk-epics", "green", { [counter]: 1 }));
    await expect(runBrowserLimitRun(f.ctx, {}, f.blocks)).rejects.toThrow();
    expect(f.blocks.runHierarchyBulk).not.toHaveBeenCalled();
  },
);

it.each([undefined, null, faultResult("progress")])(
  "refuses missing or wrong-scope final fault evidence instead of assuming success: %j",
  async (evidence) => {
    const f = fixture();
    f.faultResults.set("bulk-epics", evidence);
    await expect(runBrowserLimitRun(f.ctx, {}, f.blocks)).rejects.toThrow();
    expect(f.blocks.runHierarchyBulk).not.toHaveBeenCalled();
  },
);

it.each([
  { injected: 0, recovered: 0 },
  { injected: 1, recovered: 1 },
  { injected: 2, recovered: 1 },
  { injected: 3, recovered: 3 },
  { injected: 1, recovered: 2 },
  { injected: 1.5, recovered: 1 },
  { injected: undefined },
  { recovered: undefined },
  { duplicates: undefined },
  { lost: undefined },
  { duplicates: 1 },
  { lost: 1 },
  { injected: Number.NaN },
  { recovered: Number.POSITIVE_INFINITY },
  { duplicates: -1 },
  { lost: 0.5 },
  { pending: 1 },
  { skipped: 1 },
  { unverified: 1 },
])(
  "refuses incoherent green ac8 counts without changing ordinary count admission: %j",
  (counts) => {
    const f = fixture();
    expect(() =>
      validateLimitStepResult(f.ctx, faultResult("bulk-epics", "green", counts)),
    ).toThrow();
    const ordinary = { ...result("ordinary-observation"), counts: { elapsedMs: 0.5 } };
    expect(validateLimitStepResult(f.ctx, ordinary)).toBe(ordinary);
  },
);

it.each([
  faultResult("bulk-epics"),
  faultResult("hierarchy", "unverified", { injected: 0, recovered: 0, skipped: 2 }),
  faultResult("progress", "red", { injected: 1, recovered: 0, lost: 1 }),
])("preserves coherent actual fault verdicts without promoting them: %j", (evidence) => {
  const f = fixture();
  expect(validateLimitStepResult(f.ctx, evidence)).toBe(evidence);
});

it.each(["green", "unverified"])(
  "finalizes only the actual %s aggregate verdict",
  async (status) => {
    const { finalizeLimitRun } = await import("../testing/jira-chat-lab/browser-limit-run.mjs");
    const f = fixture();
    if (status === "unverified")
      f.faultResults.set(
        "progress",
        faultResult("progress", "unverified", { injected: 0, recovered: 0 }),
      );
    const outcome = await runBrowserLimitRun(f.ctx, {}, f.blocks);
    const completed = vi.spyOn(f.ctx.intent, "complete");
    expect(finalizeLimitRun(f.ctx.intent, outcome)).toBe(status);
    expect(completed).toHaveBeenCalledTimes(status === "green" ? 1 : 0);
    expect(JSON.parse(readFileSync(f.ctx.intent.path, "utf8")).phase).toBe(
      status === "green" ? "completed" : "incomplete",
    );
  },
);

it("refuses to complete an incomplete intent even if a caller falsely labels its result green", async () => {
  const { finalizeLimitRun } = await import("../testing/jira-chat-lab/browser-limit-run.mjs");
  const f = fixture();
  f.faultResults.set(
    "progress",
    faultResult("progress", "unverified", { injected: 0, recovered: 0 }),
  );
  const outcome = await runBrowserLimitRun(f.ctx, {}, f.blocks);
  const completed = vi.spyOn(f.ctx.intent, "complete");
  expect(() => finalizeLimitRun(f.ctx.intent, { ...outcome, status: "green" })).toThrow();
  expect(completed).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(f.ctx.intent.path, "utf8")).phase).toBe("incomplete");
});

it("consumes actual F threshold-missed results as unverified without any fault injection or native read", async () => {
  const { createFaultPlan } = await import("../testing/jira-chat-lab/browser-bulk-fault.mjs");
  const f = fixture();
  f.blocks.createFaultPlan.mockImplementation(createFaultPlan);
  f.ctx.read = vi.fn(() => {
    throw new TypeError("No native read is expected at a missed final threshold");
  });
  f.ctx.search = vi.fn(() => {
    throw new TypeError("No native search is expected at a missed final threshold");
  });
  f.ctx.page = { route: vi.fn(), unroute: vi.fn() };
  f.ctx.recovery = { restartServer: vi.fn() };
  await expect(runBrowserLimitRun(f.ctx, {}, f.blocks)).resolves.toMatchObject({
    status: "unverified",
    counts: { steps: 28 },
  });
  expect(Object.keys(f.ctx.intent.state.faults).sort()).toEqual([
    "bulk-epics:response-drop",
    "bulk-epics:server-kill",
    "hierarchy:response-drop",
    "hierarchy:server-kill",
    "progress:response-drop",
    "progress:server-kill",
  ]);
  for (const evidence of Object.values(f.ctx.intent.state.faults))
    expect(evidence).toEqual({ phase: "skipped", progress01: 1, reason: "threshold-missed" });
  expect(f.ctx.read).not.toHaveBeenCalled();
  expect(f.ctx.search).not.toHaveBeenCalled();
  expect(f.ctx.page.route).not.toHaveBeenCalled();
  expect(f.ctx.page.unroute).not.toHaveBeenCalled();
  expect(f.ctx.recovery.restartServer).not.toHaveBeenCalled();
  const saved = JSON.parse(readFileSync(f.ctx.intent.path, "utf8"));
  expect(saved.phase).toBe("incomplete");
  expect(
    saved.results
      .filter((entry) => entry.step.startsWith("ac8-"))
      .map(({ result }) => ({
        status: result.status,
        counts: result.counts,
      })),
  ).toEqual(
    Array.from({ length: 3 }, () => ({
      status: "unverified",
      counts: { injected: 0, recovered: 0, duplicates: 0, lost: 0 },
    })),
  );
});

it("stops the current product block immediately when an intermediate F verdict is red", async () => {
  const f = fixture();
  const nextNativeWrite = vi.fn();
  f.faultResults.set("bulk-epics", faultResult("bulk-epics", "red", { recovered: 1, lost: 1 }));
  f.blocks.runBulkEpics.mockImplementation(async (ctx, { faults }) => {
    await faults.maybeInject(ctx, 0.4);
    nextNativeWrite();
    return result("bulk-epics");
  });
  await expect(runBrowserLimitRun(f.ctx, {}, f.blocks)).rejects.toThrow();
  expect(nextNativeWrite).not.toHaveBeenCalled();
  expect(f.blocks.runHierarchyBulk).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(f.ctx.intent.path, "utf8")).phase).toBe("incomplete");
});

function faultResult(scope, status = "green", counts = {}) {
  return {
    step: `ac8-${scope}`,
    status,
    detail: "Independent fault evidence",
    counts: { injected: 2, recovered: 2, duplicates: 0, lost: 0, ...counts },
  };
}
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
  const faultResults = new Map();
  const seeded = Array.from({ length: 46 }, (_, index) => ({
    requirementId: `REQ-FA-${String(index + 1).padStart(3, "0")}`,
    ruleId: "summary-pattern",
  }));
  const refusals = seeded.map((seed, index) => ({
    ...seed,
    clientTurnId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  }));
  blocks.createFaultPlan.mockImplementation((options) => {
    const plan = {
      maybeInject: vi.fn(async () =>
        faultResults.has(options.scope)
          ? faultResults.get(options.scope)
          : faultResult(options.scope),
      ),
      options,
    };
    plan.observedPulse = plan.maybeInject;
    plans.push(plan);
    return plan;
  });
  blocks.runBulkEpics.mockImplementation(async (context, options) => {
    calls.push({ name: "runBulkEpics", context, options });
    intent.update({
      bulkEpics: {
        seeded,
        refusals,
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
  return { ctx, blocks, calls, plans, faultResults, controller, seeded, refusals };
}

it("hands actual observed bulk turn anchors to the verifier's own slot before its call", async () => {
  const f = fixture();
  const expected = { projectKey: "LIM7", chatId: "document-chat", refusals: f.refusals };
  f.blocks.gradeBulkRefusals.mockImplementation((ctx, options) => {
    expect(options).toEqual({ seeded: f.seeded });
    expect(ctx.intent.state["ac1-bulk-refusals"]).toEqual(expected);
    expect(JSON.parse(readFileSync(ctx.intent.path, "utf8")).data["ac1-bulk-refusals"]).toEqual(
      expected,
    );
    return Promise.resolve(result("ac1-bulk-refusals"));
  });
  await expect(runBrowserLimitRun(f.ctx, {}, f.blocks)).resolves.toMatchObject({ status: "green" });
  expect(f.blocks.gradeBulkRefusals).toHaveBeenCalledExactlyOnceWith(f.ctx, { seeded: f.seeded });
  expect(f.ctx.intent.state.bulkEpics).toEqual({ seeded: f.seeded, refusals: f.refusals });
});

it("does not manufacture refusal proof from seeded expectations without actual turn anchors", async () => {
  const f = fixture();
  f.blocks.runBulkEpics.mockImplementation((ctx) => {
    ctx.intent.record("bulkEpics", { seeded: f.seeded });
    return Promise.resolve(result("ac2-bulk-epics"));
  });
  f.blocks.gradeBulkRefusals.mockImplementation((ctx, options) => {
    expect(options).toEqual({ seeded: f.seeded });
    expect(ctx.intent.state["ac1-bulk-refusals"]?.refusals).toBeUndefined();
    return Promise.resolve({ ...result("ac1-bulk-refusals"), status: "unverified" });
  });
  await expect(runBrowserLimitRun(f.ctx, {}, f.blocks)).rejects.toThrow("incomplete");
  expect(f.blocks.gradeBulkRefusals).toHaveBeenCalledOnce();
  expect(f.blocks.runHierarchyBulk).not.toHaveBeenCalled();
});

it("preserves the resumed verifier-owned slot even when the bulk source has newer anchors", async () => {
  const f = fixture();
  const saved = {
    projectKey: "LIM7",
    chatId: "document-chat",
    refusals: [
      { requirementId: "REQ-FA-001", ruleId: "summary-pattern", clientTurnId: "previous-turn" },
    ],
    binding: "previous-binding",
    proofs: [{ invocationId: "previous-invocation" }],
    result: { ...result("ac1-bulk-refusals"), status: "unverified" },
  };
  f.ctx.intent.record("ac1-bulk-refusals", saved);
  const record = vi.spyOn(f.ctx.intent, "record");
  f.blocks.gradeBulkRefusals.mockImplementation((ctx, options) => {
    expect(options).toEqual({ seeded: f.seeded });
    expect(ctx.intent.state["ac1-bulk-refusals"]).toEqual(saved);
    return Promise.resolve(saved.result);
  });
  await expect(runBrowserLimitRun(f.ctx, {}, f.blocks)).rejects.toThrow("incomplete");
  expect(record.mock.calls.filter(([name]) => name === "ac1-bulk-refusals")).toEqual([]);
  expect(f.ctx.intent.state["ac1-bulk-refusals"]).toEqual(saved);
  expect(JSON.parse(readFileSync(f.ctx.intent.path, "utf8")).data["ac1-bulk-refusals"]).toEqual(
    saved,
  );
  expect(f.blocks.runHierarchyBulk).not.toHaveBeenCalled();
});

it("composes the exact owners once in plan order, with bilingual reload checks after epics, sprint and report", async () => {
  const f = fixture();
  const answer = await runBrowserLimitRun(f.ctx, {}, f.blocks);
  expect(answer).toEqual({
    step: "browser-limit-run",
    status: "green",
    detail: "All limit-run steps independently verified",
    counts: { steps: 28 },
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
  expect(f.ctx.checkLicense).toHaveBeenCalledTimes(28);
  expect(f.ctx.prepareTruth).toHaveBeenCalledTimes(1);
  expect(f.ctx.locale).toBe("en");
  const saved = JSON.parse(readFileSync(f.ctx.intent.path, "utf8"));
  expect(saved.phase).toBe("checkpoint");
  expect(saved.current).toBeUndefined();
  expect(saved.results).toHaveLength(28);
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
