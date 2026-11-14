// One continuous ordinary-UI limit run. Importing this module never starts a live lab.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { loadSession, readPrivateFile } from "./lab-client.mjs";
import { createLimitLicenseGuard } from "./limit-run-license.mjs";
import { privateJson } from "./private-json.mjs";
import { nativePages, projectAgileRead } from "./project-agile-oracles.mjs";
import { registerLane } from "./requirements/lab-lanes.mjs";
import { withExclusiveProcessLock } from "./requirements/work-project-lock.mjs";
import { runLabCliWhenMain } from "./lab-cli.mjs";

const MODES = ["governed-assist", "supervised-coding", "autonomous-delivery"];
const CHAT_SLOTS = ["document", "report", "denied"];
/** The label of the permitted Jira Pod; the Coding Workbench lists it as `Jira: <label>`. */
export const LIMIT_RUN_JIRA_POD_LABEL = "Limit Run Jira";
const FAULT_STEPS = new Set(["bulk-epics", "hierarchy", "progress"].map((scope) => `ac8-${scope}`));
const RECOVERED_FAULT_COUNTS = { injected: 2, recovered: 2, duplicates: 0, lost: 0 };
const OWNERS = {
  runProjectSetup: "./browser-project-agile-journey.mjs",
  installTemplates: "./templates.mjs",
  runRuleProbes: "./browser-rules-knowledge-journey.mjs",
  stageLastenheft: "./browser-rules-knowledge-setup.mjs",
  runBulkEpics: "./browser-epics-bulk.mjs",
  gradeBulkRefusals: "./rules-knowledge-oracles.mjs",
  runHierarchyBulk: "./requirements/hierarchy-bulk.mjs",
  runSprintBulk: "./browser-project-agile-journey.mjs",
  simulateProgress: "./requirements/progress-simulation.mjs",
  runProgressReport: "./requirements/progress-report.mjs",
  createFaultPlan: "./browser-bulk-fault.mjs",
  assertCardsReadable: "./browser-a11y.mjs",
  setUiLanguage: "./browser-a11y.mjs",
};

/**
 * `all` runs every work package. `without-sprint` runs everything except the sprint-at-scale package,
 * which the Agile child owns, and the card check that follows it; the remaining steps and their order
 * are unchanged. It still runs the document steps (templates, the bulk write from a requirements
 * document, the hierarchy and the report), which are Release 2 groundwork.
 */
export const LIMIT_RUN_STEP_SETS = Object.freeze(["all", "without-sprint"]);
/** The steps each partial set leaves out; a run of such a set can end `partial`, never `green`. */
export const LIMIT_RUN_SKIPPED_STEPS = Object.freeze({
  "without-sprint": ["ac6-sprint", "ac9-sprint-*"],
});

function stepSetOf(extra) {
  if (extra.length === 0) return "all";
  assert.ok(extra.length === 2 && extra[0] === "--steps", "Unexpected limit-run argument");
  assert.ok(LIMIT_RUN_STEP_SETS.includes(extra[1]), "Unknown limit-run step set");
  return extra[1];
}

export function limitRunArguments(argv) {
  const [sessionDir, modelId, embeddingModelId, permittedToken, deniedToken, projectKey, ...extra] =
    argv;
  assert.ok(
    [sessionDir, permittedToken, deniedToken].every(
      (path) => typeof path === "string" && isAbsolute(path),
    ),
  );
  assert.ok(modelId && embeddingModelId && modelId !== embeddingModelId);
  assert.ok(
    [modelId, embeddingModelId].every((value) => value.length <= 255 && !/\p{Cc}/u.test(value)),
  );
  assert.notEqual(resolve(permittedToken), resolve(deniedToken));
  assert.match(projectKey ?? "", /^LIM[1-9][0-9]{0,6}$/u);
  const steps = stepSetOf(extra);
  return { sessionDir, modelId, embeddingModelId, permittedToken, deniedToken, projectKey, steps };
}

/** Missing owner exports are an incomplete build, never a successful skipped step. */
export async function loadLimitRunBlocks(importer = (path) => import(path), owners = OWNERS) {
  const modules = new Map(
    await Promise.all(
      [...new Set(Object.values(owners))].map(async (path) => [path, await importer(path)]),
    ),
  );
  return Object.fromEntries(
    Object.entries(owners).map(([name, path]) => {
      assert.equal(
        typeof modules.get(path)[name],
        "function",
        `Missing limit-run owner export: ${name}`,
      );
      return [name, modules.get(path)[name]];
    }),
  );
}

/** Reuse privateJson's exclusive reservation and atomic replacements, including failed intents. */
export function createLimitRunIntent(sessionDir, identity, assertOwned = () => undefined) {
  const path = join(sessionDir, "browser-limit-run.pending.json");
  const state = {
    schemaVersion: 1,
    kind: "browser-limit-run",
    id: randomUUID(),
    identity,
    phase: "reserved",
    data: {},
    results: [],
  };
  assertOwned();
  privateJson(path, state, true);
  return limitRunIntentHandle(path, state, assertOwned);
}

/** The recorded-state handle of one intent file; the follow-up runner reuses it for its own file. */
export function limitRunIntentHandle(path, state, assertOwned = () => undefined) {
  const persist = () => {
    assertOwned();
    privateJson(path, state);
  };
  return {
    path,
    get state() {
      return structuredClone(state.data);
    },
    update(patch) {
      state.data = { ...state.data, ...patch };
      persist();
    },
    record(name, value) {
      state.data[name] = value;
      persist();
    },
    ...intentLifecycle(state, persist),
  };
}

function intentLifecycle(state, persist) {
  return {
    begin(step) {
      state.phase = "running";
      state.current = step;
      persist();
    },
    settled(step, result) {
      state.results.push({ step, result });
      delete state.current;
      state.phase = "checkpoint";
      persist();
    },
    failed() {
      state.phase = "incomplete";
      persist();
    },
    complete() {
      assert.equal(state.current, undefined);
      state.phase = "completed";
      persist();
    },
  };
}

function privateEvidence(ctx, path) {
  assert.ok(isAbsolute(path), "Evidence must be an existing private absolute file");
  const inside = relative(realpathSync(ctx.sessionDir), realpathSync(path));
  assert.ok(inside !== "" && inside !== ".." && !inside.startsWith("../") && !isAbsolute(inside));
  JSON.parse(readPrivateFile(path));
  return path;
}

export function validateLimitStepResult(ctx, result) {
  assert.ok(result && typeof result === "object");
  assert.match(result.step ?? "", /^[a-z0-9][a-z0-9-]{0,79}$/u);
  assert.ok(new Set(["green", "red", "unverified"]).has(result.status));
  assert.ok(
    typeof result.detail === "string" &&
      result.detail.length > 0 &&
      result.detail.length <= 1024 &&
      !/[\r\n]/u.test(result.detail),
  );
  validateCounts(result.counts);
  if (result.step.startsWith("ac8-")) validateFaultResult(result);
  if (result.evidenceFile !== undefined) privateEvidence(ctx, result.evidenceFile);
  return result;
}

function validateFaultResult(result) {
  assert.ok(FAULT_STEPS.has(result.step), "Fault evidence belongs to a configured run scope");
  const counts = result.counts;
  assert.ok(
    Object.keys(RECOVERED_FAULT_COUNTS).every((key) => Object.hasOwn(counts, key)),
    "Fault evidence retains every required counter",
  );
  assert.ok(Object.values(counts).every(Number.isSafeInteger), "Fault counters are exact counts");
  assert.ok(
    counts.injected <= 2 && counts.recovered <= counts.injected,
    "Observed recoveries cannot exceed the fixed two injected faults",
  );
  const incomplete = ["pending", "skipped", "unverified"];
  assert.ok(incomplete.every((key) => counts[key] === undefined || counts[key] <= 2));
  assert.ok(
    result.status === "red" || (counts.duplicates === 0 && counts.lost === 0),
    "Observed duplicates or lost records stop the run",
  );
  if (result.status === "green") {
    assert.ok(
      Object.entries(RECOVERED_FAULT_COUNTS).every(([key, value]) => counts[key] === value),
      "Green fault evidence proves both complete recoveries without duplicate or lost records",
    );
    assert.ok(
      incomplete.every((key) => counts[key] === undefined || counts[key] === 0),
      "Incomplete fault evidence cannot be green",
    );
  }
}

function validateCounts(counts) {
  assert.ok(counts && typeof counts === "object" && !Array.isArray(counts));
  for (const [name, value] of Object.entries(counts)) {
    assert.match(name, /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u);
    assert.ok(Number.isFinite(value) && value >= 0);
  }
}

/** One validated step of a run: license window, durable begin/settle and a green-only continuation. */
export async function runLimitStep(ctx, results, name, run) {
  ctx.signal.throwIfAborted();
  await ctx.checkLicense?.(name);
  ctx.intent.begin(name);
  const result = validateLimitStepResult(ctx, await run());
  ctx.signal.throwIfAborted();
  ctx.intent.settled(name, result);
  results.push(result);
  assert.ok(
    result.status === "green" ||
      (FAULT_STEPS.has(name) && result.step === name && result.status === "unverified"),
    "An incomplete limit-run step stops the run",
  );
  return result;
}

async function cards(ctx, blocks, results, checkpoint) {
  const documentRegion = ctx.region;
  if (ctx.focusChat) {
    const focused = await ctx.focusChat(checkpoint === "report" ? ctx.reportChat : ctx.chat);
    ctx.cardChat = focused.chat;
    ctx.region = focused.region;
  }
  try {
    await bilingualCards(ctx, blocks, results, checkpoint);
  } finally {
    ctx.region = documentRegion;
    delete ctx.cardChat;
  }
}

async function bilingualCards(ctx, blocks, results, checkpoint) {
  for (const locale of ["en", "de"]) {
    await runLimitStep(ctx, results, `ac9-${checkpoint}-${locale}-language`, () =>
      blocks.setUiLanguage(ctx, locale),
    );
    ctx.locale = locale;
    await runLimitStep(ctx, results, `ac9-${checkpoint}-${locale}`, () =>
      blocks.assertCardsReadable(ctx, { reload: true }),
    );
  }
  await runLimitStep(ctx, results, `ac9-${checkpoint}-restore-language`, () =>
    blocks.setUiLanguage(ctx, "en"),
  );
  ctx.locale = "en";
}

function faultPlan(blocks, scope) {
  const plan = blocks.createFaultPlan({
    scope,
    at: [0.4, 0.8],
    kinds: ["response-drop", "server-kill"],
  });
  assert.equal(typeof plan?.maybeInject, "function");
  const maybeInject = plan.maybeInject;
  plan.maybeInject = async (ctx, progress01) => {
    const result = validateLimitStepResult(ctx, await maybeInject.call(plan, ctx, progress01));
    assert.ok(result.step === `ac8-${scope}`, "Fault evidence matches its calling scope");
    assert.ok(
      progress01 === 1 || result.status !== "red",
      "A red fault verdict stops further product work",
    );
    return result;
  };
  return plan;
}

async function finishFaultPlan(ctx, results, scope, plan) {
  return runLimitStep(ctx, results, `ac8-${scope}`, async () => {
    const result = await plan.maybeInject(ctx, 1);
    assert.ok(result?.step === `ac8-${scope}`, "The final fault verdict matches its calling scope");
    return result;
  });
}

function bulkSeeds(ctx) {
  const state = ctx.intent.state;
  const seeded = state.bulkEpics?.seeded;
  assert.ok(
    Array.isArray(seeded) && seeded.length >= 37 && seeded.length <= 55,
    "Ten to fifteen percent of 370 requirements need concrete rule-violation probes",
  );
  assert.equal(new Set(seeded.map((entry) => entry.requirementId)).size, seeded.length);
  for (const entry of seeded) {
    assert.ok(typeof entry.requirementId === "string" && entry.requirementId.length > 0);
    assert.ok(typeof entry.ruleId === "string" && entry.ruleId.length > 0);
  }
  if (state["ac1-bulk-refusals"] === undefined && Array.isArray(state.bulkEpics?.refusals))
    ctx.intent.record("ac1-bulk-refusals", {
      projectKey: ctx.projectKey,
      chatId: ctx.chat.id,
      refusals: state.bulkEpics.refusals.map(({ requirementId, ruleId, clientTurnId }) => ({
        requirementId,
        ruleId,
        clientTurnId,
      })),
    });
  return seeded;
}

async function stages(ctx, options, blocks, results) {
  await runLimitStep(ctx, results, "ac5-project", () =>
    blocks.runProjectSetup(ctx, { deniedActor: true }),
  );
  await ctx.prepareTruth?.();
  await runLimitStep(ctx, results, "ac1-templates", () => blocks.installTemplates(ctx));
  await runLimitStep(ctx, results, "ac1-probes", () =>
    blocks.runRuleProbes(ctx, { modes: [...MODES] }),
  );
  await runLimitStep(ctx, results, "ac2-lastenheft", () => blocks.stageLastenheft(ctx));
  const epicFaults = faultPlan(blocks, "bulk-epics");
  await runLimitStep(ctx, results, "ac2-epics", () =>
    blocks.runBulkEpics(ctx, {
      violationRate: options.violationRate,
      faults: epicFaults,
    }),
  );
  await finishFaultPlan(ctx, results, "bulk-epics", epicFaults);
  await runLimitStep(ctx, results, "ac1-bulk-refusals", () =>
    blocks.gradeBulkRefusals(ctx, { seeded: bulkSeeds(ctx) }),
  );
  await cards(ctx, blocks, results, "epics");
  const hierarchyFaults = faultPlan(blocks, "hierarchy");
  await runLimitStep(ctx, results, "ac4-hierarchy", () =>
    blocks.runHierarchyBulk(ctx, { faults: hierarchyFaults }),
  );
  await finishFaultPlan(ctx, results, "hierarchy", hierarchyFaults);
  if (options.steps !== "without-sprint") {
    await runLimitStep(ctx, results, "ac6-sprint", () =>
      blocks.runSprintBulk(ctx, { size: options.sprintSize, batch: 50 }),
    );
    await cards(ctx, blocks, results, "sprint");
  }
  ctx.faults = faultPlan(blocks, "progress");
  const progress = await runLimitStep(ctx, results, "progress-simulation", () =>
    blocks.simulateProgress(ctx, { seedDeviations: true }),
  );
  await finishFaultPlan(ctx, results, "progress", ctx.faults);
  assert.ok(
    progress.evidenceFile,
    "Progress simulation must return its independently observed private truth",
  );
  await runLimitStep(ctx, results, "ac3-report", () =>
    blocks.runProgressReport(ctx, { truthFile: progress.evidenceFile }),
  );
  await cards(ctx, blocks, results, "report");
}

/** Fixed-contract composition; tests inject the same owner signatures without live services. */
export async function runBrowserLimitRun(ctx, options = {}, blocks) {
  const selected = validateLimitOptions(ctx, options, blocks);
  const results = [];
  try {
    await stages(ctx, selected, blocks, results);
    return limitRunOutcome(ctx, selected, results);
  } catch (error) {
    ctx.intent.failed();
    throw error;
  }
}

/** The terminal verdict of the steps that ran: green, partial (a package left out) or unverified. */
function limitRunOutcome(ctx, selected, results) {
  const verified = results.every((result) => result.status === "green");
  const skipped = LIMIT_RUN_SKIPPED_STEPS[selected.steps] ?? [];
  const partial = verified && skipped.length > 0;
  ctx.intent.record("orchestrator", {
    phase: verified ? "steps-verified" : "steps-unverified",
    steps: selected.steps,
    partial,
    skipped,
    results,
  });
  if (!verified) ctx.intent.failed();
  return {
    step: "browser-limit-run",
    status: verified ? (partial ? "partial" : "green") : "unverified",
    detail: limitRunDetail({ verified, partial, selected, skipped }),
    counts: { steps: results.length },
    ...(partial ? { partial: true, skipped } : {}),
    evidenceFile: ctx.intent.path,
  };
}

function limitRunDetail({ verified, partial, selected, skipped }) {
  if (!verified) return "Fault evidence remains incomplete";
  if (!partial) return "All limit-run steps independently verified";
  return `All ${selected.steps} limit-run steps independently verified; ${skipped.join(", ")} not run`;
}

/** Finalization runs only after the owned browser/server cleanup has completed. */
export function finalizeLimitRun(intent, result) {
  assert.ok(
    result?.step === "browser-limit-run" &&
      new Set(["green", "partial", "unverified"]).has(result.status),
    "A terminal run verdict is required",
  );
  if (result.status === "unverified") {
    intent.failed();
    return "unverified";
  }
  assert.equal(intent.state.orchestrator?.phase, "steps-verified");
  // A partial set is complete as a set but never a full green: the status stays distinct.
  assert.equal(result.status === "partial", intent.state.orchestrator?.partial === true);
  intent.complete();
  return result.status;
}

function validateLimitOptions(ctx, options, blocks) {
  const selected = { violationRate: 0.125, sprintSize: 250, steps: "all", ...options };
  assert.ok(LIMIT_RUN_STEP_SETS.includes(selected.steps), "Unknown limit-run step set");
  assert.ok(selected.violationRate >= 0.1 && selected.violationRate <= 0.15);
  assert.ok(
    Number.isInteger(selected.sprintSize) &&
      selected.sprintSize >= 200 &&
      selected.sprintSize <= 300,
  );
  for (const name of Object.keys(OWNERS)) assert.equal(typeof blocks?.[name], "function");
  assert.ok(ctx.intent && ctx.signal && ctx.page && /^LIM[1-9][0-9]{0,6}$/u.test(ctx.projectKey));
  const chats = [ctx.chat, ctx.reportChat, ctx.deniedChat];
  assert.ok(chats.every((chat) => typeof chat?.id === "string" && chat.id.length > 0));
  assert.equal(new Set(chats.map((chat) => chat.id)).size, 3);
  return selected;
}

async function requiredFields(read, path) {
  const fields = new Map();
  let total;
  for (let startAt = 0, pages = 0; pages < 100; pages += 1) {
    const body = await read(`${path}?startAt=${startAt}&maxResults=100`);
    assert.equal(body.startAt, startAt);
    assert.ok(Number.isSafeInteger(body.total) && body.total >= 0 && Array.isArray(body.values));
    assert.ok(
      Number.isSafeInteger(body.maxResults) && body.maxResults > 0 && body.maxResults <= 100,
    );
    assert.ok(body.values.length <= body.maxResults);
    total ??= body.total;
    assert.equal(body.total, total);
    for (const field of body.values) {
      assert.ok(typeof field.fieldId === "string" && typeof field.required === "boolean");
      assert.equal(fields.has(field.fieldId), false);
      fields.set(field.fieldId, field.required);
    }
    assert.ok(fields.size <= total);
    if (fields.size === total)
      return [...fields].filter(([, required]) => required).map(([id]) => id);
    assert.ok(body.values.length > 0);
    startAt += body.values.length;
  }
  throw new TypeError("Native required-field metadata is incomplete");
}

export const LIMIT_ISSUE_TYPES = Object.freeze(["Epic", "Task", "Bug", "Sub-task"]);

export async function readLimitFieldTruth(read, projectKey, typeNames = LIMIT_ISSUE_TYPES) {
  const fields = await read("/rest/api/2/field");
  assert.ok(Array.isArray(fields));
  const epic = fields.filter(
    (field) => field.schema?.custom === "com.pyxis.greenhopper.jira:gh-epic-link",
  );
  assert.equal(epic.length, 1);
  assert.match(epic[0].id, /^customfield_[1-9][0-9]*$/u);
  const path = `/rest/api/2/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`;
  const types = await nativePages(read, path, "values");
  const requiredFieldsByType = {};
  for (const name of typeNames) {
    const matches = types.filter((type) => type.name === name);
    assert.equal(matches.length, 1);
    requiredFieldsByType[name] = await requiredFields(read, `${path}/${matches[0].id}`);
  }
  return { fieldIds: { epicLink: epic[0].id }, requiredFieldsByType };
}

function recordLimitChat(intent, slot, facts) {
  const fields = ["phase", "chatId", "windowId", "podId", "actorClass"];
  const saved = Object.fromEntries(
    fields.filter((key) => facts[key] !== undefined).map((key) => [key, facts[key]]),
  );
  intent.record("chats", {
    ...intent.state.chats,
    [slot]: { ...intent.state.chats?.[slot], ...saved },
  });
}

function resumableLimitChat(intent, slot) {
  const saved = intent.state.chats?.[slot] ?? {};
  assert.ok(
    saved.phase !== "chat-creation-may-have-started" || saved.chatId,
    "An uncertain Chat creation requires reconciliation",
  );
  assert.ok(
    saved.phase !== "pod-creation-may-have-started" || saved.podId,
    "An uncertain Pod creation requires reconciliation",
  );
  return saved;
}

function limitChatOptions(slot, saved, handles, options, intent) {
  const restricted = slot === "denied";
  const actorClass = restricted ? "restricted" : "permitted";
  assert.ok(saved.actorClass === undefined || saved.actorClass === actorClass);
  if (slot === "report" && saved.podId !== undefined)
    assert.equal(saved.podId, handles.document.podId);
  const titles = { document: "Documents", report: "Reporting", denied: "Restricted" };
  return {
    shared: handles.document,
    chatId: saved.chatId,
    podId: saved.podId ?? (slot === "report" ? handles.document.podId : undefined),
    title: `Limit Run ${titles[slot]}`,
    label: restricted ? "Limit Run Restricted" : LIMIT_RUN_JIRA_POD_LABEL,
    tokenFile: restricted ? options.deniedToken : options.permittedToken,
    actorClass,
    mode: "autonomous-delivery",
    administration: true,
    jiraOnly: slot !== "document",
    onPhase: (facts) => recordLimitChat(intent, slot, facts),
    onChat: (facts) => recordLimitChat(intent, slot, facts),
    onPod: (facts) => recordLimitChat(intent, slot, facts),
  };
}

/** Three ordinary UI Chats share one signed-in page and exactly two verified Jira Pods. */
export async function openLimitRunChats(live, options, intent, ports) {
  const ui = ports ?? (await import("./browser-workflow-turn.mjs"));
  const handles = {};
  try {
    for (const slot of CHAT_SLOTS) {
      const saved = resumableLimitChat(intent, slot);
      const selected = limitChatOptions(slot, saved, handles, options, intent);
      const handle = await ui.openWorkflowBrowser(live, selected);
      handles[slot] = handle;
      if (saved.chatId !== undefined) assert.equal(handle.chat.id, saved.chatId);
      if (saved.podId !== undefined) assert.equal(handle.podId, saved.podId);
      if (slot !== "document") {
        assert.equal(handle.page, handles.document.page);
        assert.equal(handle.browser, handles.document.browser);
      }
      recordLimitChat(intent, slot, {
        phase: "ready",
        chatId: handle.chat.id,
        windowId: handle.windowId,
        podId: handle.podId,
        actorClass: selected.actorClass,
      });
    }
    assert.equal(new Set(CHAT_SLOTS.map((slot) => handles[slot].chat.id)).size, 3);
    assert.equal(handles.report.podId, handles.document.podId);
    assert.notEqual(handles.denied.podId, handles.document.podId);
    await handles.document.focus(handles.document.page);
    return handles;
  } catch (error) {
    await handles.document?.close();
    throw error;
  }
}

function limitChatHandle(ctx, handles, chat) {
  const slot = CHAT_SLOTS.find((name) => handles[name].chat.id === chat?.id);
  assert.ok(slot, "A turn must target one of this run's three registered Chats");
  const handle = handles[slot];
  const saved = ctx.intent.state.chats?.[slot];
  assert.ok(
    saved?.chatId === handle.chat.id && saved.podId === handle.podId,
    "The saved Chat binding changed",
  );
  return { slot, handle };
}

/** Full access is the run's mode; a step that selected another mode in the UI names it. */
async function focusLimitChat(ctx, handles, chat, ui, mode = "autonomous-delivery") {
  ctx.signal.throwIfAborted();
  assert.ok(MODES.includes(mode), "A limit-run turn names one of the three access modes");
  const { slot, handle } = limitChatHandle(ctx, handles, chat);
  const focused = await handle.focus(ctx.page, mode);
  ctx.signal.throwIfAborted();
  assert.equal(focused.chat.id, handle.chat.id);
  ui.assertWorkflowChatConfiguration(focused.chat, ctx, handle.podId, {
    mode,
    administration: true,
    jiraOnly: slot !== "document",
  });
  ctx[slot === "document" ? "chat" : `${slot}Chat`] = focused.chat;
  ctx.activeChatId = focused.chat.id;
  return focused;
}

function limitRecovery(ctx, live, handles, ui) {
  if (typeof live.restartServer !== "function") return undefined;
  let pending = false;
  return {
    async restartServer(options = {}) {
      assert.ok(Object.keys(options).every((key) => key === "signal"));
      assert.equal(pending, false, "The owned laboratory restart is already in progress");
      const signal = globalThis.AbortSignal.any([
        ctx.signal,
        ...(options.signal ? [options.signal] : []),
      ]);
      signal.throwIfAborted();
      for (const slot of CHAT_SLOTS) limitChatHandle(ctx, handles, handles[slot].chat);
      pending = true;
      try {
        return await recoverLimitBrowser(ctx, live, handles, ui, signal);
      } finally {
        pending = false;
      }
    },
  };
}

async function recoverLimitBrowser(ctx, live, handles, ui, signal) {
  const began = globalThis.performance.now();
  const root = live.root;
  const origin = live.origin;
  const active = ctx.activeChatId ?? ctx.chat.id;
  const count = (ctx.intent.state.recovery?.count ?? 0) + 1;
  ctx.intent.record("recovery", { phase: "restarting", count });
  try {
    const restarted = await live.restartServer({ signal });
    assert.equal(restarted.restarted, true);
    assert.ok(
      live.root === root && live.origin === origin,
      "The owned laboratory state must be retained",
    );
    signal.throwIfAborted();
    await ctx.page.reload({ waitUntil: "domcontentloaded" });
    await ui.redeemWorkflowBrowserSession(ctx.page, ctx);
    for (const slot of CHAT_SLOTS) {
      signal.throwIfAborted();
      const focused = await ctx.focusChat(handles[slot].chat);
      if (slot === "document") ctx.region = focused.region;
    }
    await ctx.focusChat({ id: active });
    signal.throwIfAborted();
    const downtimeMs = Math.ceil(globalThis.performance.now() - began);
    ctx.intent.record("recovery", { phase: "recovered", count, downtimeMs });
    return { restarted: true, downtimeMs };
  } catch (error) {
    ctx.intent.record("recovery", { phase: "failed", count });
    throw error;
  }
}

function bindLimitTurnOwner(ctx, handles, ui) {
  ctx.focusChat = (chat) => focusLimitChat(ctx, handles, chat, ui);
  ctx.turn = async (chat, prompt, { mode, ...extra } = {}) => {
    const focused = await focusLimitChat(ctx, handles, chat, ui, mode);
    return ui.sendBrowserTurn(ctx.page, focused.region, ctx, focused.chat.id, prompt, {
      operations: ["jira.draft", "jira.create"],
      timeoutMs: 1800000,
      ...extra,
      persist: (value) => ctx.intent.record("browserTurn", { chatId: focused.chat.id, ...value }),
    });
  };
}

/** Explicit Chat routing keeps document and live-report sources separate across recovery. */
export async function createLimitRunContext(live, handles, options, intent, signal, ports) {
  const { loadGoldenManifest, readGoldenIssues } =
    await import("./requirements/golden-jira-oracle.mjs");
  const ui = ports ?? (await import("./browser-workflow-turn.mjs"));
  assert.equal(typeof ui.assertWorkflowChatConfiguration, "function");
  const ctx = {
    ...live,
    ...handles.document,
    ...options,
    reportChat: handles.report.chat,
    deniedChat: handles.denied.chat,
    locale: "en",
    intent,
    signal,
    truth: loadGoldenManifest(),
  };
  for (const name of ["cookie", "secret", "origin", "root", "projectPath"])
    Object.defineProperty(ctx, name, { enumerable: true, get: () => live[name] });
  ctx.read = (path) => projectAgileRead(ctx.session, path);
  ctx.checkLicense = createLimitLicenseGuard({
    session: ctx.session,
    intent,
    renew: ports?.renewLicenseWindow,
  });
  bindLimitTurnOwner(ctx, handles, ui);
  ctx.recovery = limitRecovery(ctx, live, handles, ui);
  ctx.search = (jql, fields = "*all") => {
    const normalized = jql.replaceAll('"', "").replaceAll(/\s+/gu, " ").trim();
    assert.ok(
      new Set([`project = ${ctx.projectKey}`, `project = ${ctx.projectKey} ORDER BY id ASC`]).has(
        normalized,
      ),
    );
    return readGoldenIssues(ctx.read, ctx.projectKey, { fields, signal });
  };
  ctx.prepareTruth = async () => {
    const fields = await readLimitFieldTruth(ctx.read, ctx.projectKey);
    ctx.truth = { ...ctx.truth, ...fields };
    intent.record("fieldTruth", fields);
  };
  return ctx;
}

/** One closed verdict per step: names and statuses only, never a detail or a path. */
export function printLimitVerdict(intent, status) {
  const orchestrator = intent.state.orchestrator;
  const steps = (intent.state.orchestrator?.results ?? []).map(({ step, status: verdict }) => ({
    step,
    status: verdict,
  }));
  console.log(
    JSON.stringify({
      operation: "jira-browser-limit-run",
      status,
      steps: orchestrator?.steps ?? "all",
      partial: orchestrator?.partial === true,
      verdicts: steps,
    }),
  );
}

async function main(argv) {
  const options = limitRunArguments(argv);
  const session = loadSession(options.sessionDir);
  const blocks = await loadLimitRunBlocks();
  await withExclusiveProcessLock(
    join(session.directory, "browser-limit-run-owner"),
    "browser-limit-run",
    async (assertOwned) => {
      const intent = createLimitRunIntent(session.directory, options, assertOwned);
      const { withLiveChat } = await import("./chat-read.mjs");
      const signal = globalThis.AbortSignal.timeout(14 * 60 * 60 * 1000);
      let outcome;
      let status;
      // Marks this run as a lane, so a renewal restart never overlaps another lane's active turn.
      const releaseLane = registerLane(session.directory);
      try {
        await withLiveChat({
          session,
          modelId: options.modelId,
          embeddingModelId: options.embeddingModelId,
          browser: true,
          ownedChild: true,
          retainState: true,
          modelRetries: 0,
          stateReady: (directory) => intent.record("stateDirectory", directory),
          run: async (live) => {
            const opened = await openLimitRunChats(live, options, intent);
            try {
              outcome = await runBrowserLimitRun(
                await createLimitRunContext(live, opened, options, intent, signal),
                { steps: options.steps },
                blocks,
              );
            } finally {
              await opened.document.close();
            }
          },
        });
        status = finalizeLimitRun(intent, outcome);
      } catch (error) {
        intent.failed();
        throw error;
      } finally {
        releaseLane();
      }
      if (status === "unverified") process.exitCode = 1;
      printLimitVerdict(intent, status);
    },
  );
}

await runLabCliWhenMain(import.meta.url, "jira-browser-limit-run", main);
