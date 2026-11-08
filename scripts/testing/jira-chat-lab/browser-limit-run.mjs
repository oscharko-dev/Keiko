// One continuous ordinary-UI limit run. Importing this module never starts a live lab.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSession, readPrivateFile, requireLicense } from "./lab-client.mjs";
import { privateJson } from "./private-json.mjs";
import { nativePages, projectAgileRead } from "./project-agile-oracles.mjs";
import { withExclusiveProcessLock } from "./requirements/work-project-lock.mjs";

const MODES = ["governed-assist", "supervised-coding", "autonomous-delivery"];
const OWNERS = {
  runProjectSetup: "./browser-project-agile-journey.mjs",
  installTemplates: "./requirements/templates.mjs",
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
  assert.equal(extra.length, 0);
  return { sessionDir, modelId, embeddingModelId, permittedToken, deniedToken, projectKey };
}

/** Missing owner exports are an incomplete build, never a successful skipped step. */
export async function loadLimitRunBlocks(importer = (path) => import(path)) {
  const modules = new Map(
    await Promise.all(
      [...new Set(Object.values(OWNERS))].map(async (path) => [path, await importer(path)]),
    ),
  );
  return Object.fromEntries(
    Object.entries(OWNERS).map(([name, path]) => {
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
  const persist = () => {
    assertOwned();
    privateJson(path, state);
  };
  assertOwned();
  privateJson(path, state, true);
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
  if (result.evidenceFile !== undefined) privateEvidence(ctx, result.evidenceFile);
  return result;
}

function validateCounts(counts) {
  assert.ok(counts && typeof counts === "object" && !Array.isArray(counts));
  for (const [name, value] of Object.entries(counts)) {
    assert.match(name, /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u);
    assert.ok(Number.isFinite(value) && value >= 0);
  }
}

async function step(ctx, results, name, run) {
  ctx.signal.throwIfAborted();
  await ctx.checkLicense?.();
  ctx.intent.begin(name);
  const result = validateLimitStepResult(ctx, await run());
  ctx.signal.throwIfAborted();
  ctx.intent.settled(name, result);
  results.push(result);
  assert.equal(result.status, "green", "An incomplete limit-run step stops the run");
  return result;
}

async function cards(ctx, blocks, results, checkpoint) {
  for (const locale of ["en", "de"]) {
    await step(ctx, results, `ac9-${checkpoint}-${locale}-language`, () =>
      blocks.setUiLanguage(ctx, locale),
    );
    ctx.locale = locale;
    await step(ctx, results, `ac9-${checkpoint}-${locale}`, () =>
      blocks.assertCardsReadable(ctx, { reload: true }),
    );
  }
  await step(ctx, results, `ac9-${checkpoint}-restore-language`, () =>
    blocks.setUiLanguage(ctx, "en"),
  );
  ctx.locale = "en";
}

function faultPlan(blocks) {
  const plan = blocks.createFaultPlan({ at: [0.4, 0.8], kinds: ["response-drop", "server-kill"] });
  assert.equal(typeof plan?.maybeInject, "function");
  return plan;
}

function bulkSeeds(ctx) {
  const seeded = ctx.intent.state.bulkEpics?.seeded;
  assert.ok(
    Array.isArray(seeded) && seeded.length >= 37 && seeded.length <= 55,
    "Ten to fifteen percent of 370 requirements need concrete rule-violation probes",
  );
  assert.equal(new Set(seeded.map((entry) => entry.requirementId)).size, seeded.length);
  for (const entry of seeded) {
    assert.ok(typeof entry.requirementId === "string" && entry.requirementId.length > 0);
    assert.ok(typeof entry.ruleId === "string" && entry.ruleId.length > 0);
  }
  return seeded;
}

async function stages(ctx, options, blocks, results) {
  await step(ctx, results, "ac5-project", () => blocks.runProjectSetup(ctx, { deniedActor: true }));
  await ctx.prepareTruth?.();
  await step(ctx, results, "ac1-templates", () => blocks.installTemplates(ctx));
  await step(ctx, results, "ac1-probes", () => blocks.runRuleProbes(ctx, { modes: [...MODES] }));
  await step(ctx, results, "ac2-lastenheft", () => blocks.stageLastenheft(ctx));
  await step(ctx, results, "ac2-epics", () =>
    blocks.runBulkEpics(ctx, { violationRate: options.violationRate, faults: faultPlan(blocks) }),
  );
  await step(ctx, results, "ac1-bulk-refusals", () =>
    blocks.gradeBulkRefusals(ctx, { seeded: bulkSeeds(ctx) }),
  );
  await cards(ctx, blocks, results, "epics");
  await step(ctx, results, "ac4-hierarchy", () =>
    blocks.runHierarchyBulk(ctx, { faults: faultPlan(blocks) }),
  );
  ctx.faults = faultPlan(blocks);
  await step(ctx, results, "ac6-sprint", () =>
    blocks.runSprintBulk(ctx, { size: options.sprintSize, batch: 50 }),
  );
  await cards(ctx, blocks, results, "sprint");
  const progress = await step(ctx, results, "progress-simulation", () =>
    blocks.simulateProgress(ctx, { seedDeviations: true }),
  );
  assert.ok(
    progress.evidenceFile,
    "Progress simulation must return its independently observed private truth",
  );
  await step(ctx, results, "ac3-report", () =>
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
    ctx.intent.record("orchestrator", { phase: "steps-verified", results });
    return {
      step: "browser-limit-run",
      status: "green",
      detail: "All limit-run steps independently verified",
      counts: { steps: results.length },
      evidenceFile: ctx.intent.path,
    };
  } catch (error) {
    ctx.intent.failed();
    throw error;
  }
}

function validateLimitOptions(ctx, options, blocks) {
  const selected = { violationRate: 0.125, sprintSize: 250, ...options };
  assert.ok(selected.violationRate >= 0.1 && selected.violationRate <= 0.15);
  assert.ok(
    Number.isInteger(selected.sprintSize) &&
      selected.sprintSize >= 200 &&
      selected.sprintSize <= 300,
  );
  for (const name of Object.keys(OWNERS)) assert.equal(typeof blocks?.[name], "function");
  assert.ok(ctx.intent && ctx.signal && ctx.page && /^LIM[1-9][0-9]{0,6}$/u.test(ctx.projectKey));
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

export async function readLimitFieldTruth(read, projectKey) {
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
  for (const name of ["Epic", "Task", "Bug", "Sub-task"]) {
    const matches = types.filter((type) => type.name === name);
    assert.equal(matches.length, 1);
    requiredFieldsByType[name] = await requiredFields(read, `${path}/${matches[0].id}`);
  }
  return { fieldIds: { epicLink: epic[0].id }, requiredFieldsByType };
}

async function limitContext(live, opened, options, intent, signal) {
  const { loadGoldenManifest, readGoldenIssues } =
    await import("./requirements/golden-jira-oracle.mjs");
  const { sendBrowserTurn } = await import("./browser-workflow-turn.mjs");
  const ctx = {
    ...live,
    ...opened,
    ...options,
    locale: "en",
    intent,
    signal,
    truth: loadGoldenManifest(),
  };
  ctx.read = (path) => projectAgileRead(ctx.session, path);
  ctx.checkLicense = async () =>
    assert.ok(
      (await requireLicense(ctx.session)) >= 1800,
      "Thirty minutes of the existing license window are required; no automatic Jira restart",
    );
  ctx.turn = (chat, prompt, extra = {}) =>
    sendBrowserTurn(ctx.page, ctx.region, ctx, chat.id, prompt, {
      operations: ["jira.draft", "jira.create"],
      timeoutMs: 1800000,
      ...extra,
      persist: (value) => intent.record("browserTurn", { chatId: chat.id, ...value }),
    });
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
  intent.record("chat", opened.chat);
  return ctx;
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
      const { openWorkflowBrowser } = await import("./browser-workflow-turn.mjs");
      const signal = globalThis.AbortSignal.timeout(14 * 60 * 60 * 1000);
      try {
        await withLiveChat({
          session,
          modelId: options.modelId,
          embeddingModelId: options.embeddingModelId,
          browser: true,
          retainState: true,
          modelRetries: 0,
          stateReady: (directory) => intent.record("stateDirectory", directory),
          run: async (live) => {
            const opened = await openWorkflowBrowser(live, {
              tokenFile: options.permittedToken,
              administration: true,
            });
            try {
              await runBrowserLimitRun(
                await limitContext(live, opened, options, intent, signal),
                {},
                blocks,
              );
            } finally {
              await opened.browser.close();
            }
          },
        });
        assert.equal(intent.state.orchestrator?.phase, "steps-verified");
        intent.complete();
      } catch (error) {
        intent.failed();
        throw error;
      }
      console.log(JSON.stringify({ operation: "jira-browser-limit-run", status: "green" }));
    },
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2)).catch((error) => {
    console.log(
      JSON.stringify({
        operation: "jira-browser-limit-run",
        status: "incomplete",
        errorType: error instanceof Error ? error.name : "unknown",
      }),
    );
    process.exitCode = 1;
  });
}
