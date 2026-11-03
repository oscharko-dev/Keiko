// One isolated Keiko instance per scenario run (#4207): the real BFF and Gateway composition of the
// chat-skills lab, started with a private state directory, its own vault key and the lab's models,
// driven only through public HTTP routes, and torn down with its fixture. Nothing here reads the
// vault file or imports a memory package; what the lab sees is what a person would get.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { REPO_ROOT, importBuilt } from "../coding-workbench-lab/lab-common.mjs";
import { readActivityEvents } from "../coding-workbench-lab/activity-log-events.mjs";
import { buildDevBffEnv } from "../../lib/dev-bff-env.mjs";
import { ANSWERER_MODEL_ID, LEARNER_MODEL_ID } from "./scripted-model.mjs";

export const CEILINGS = Object.freeze([
  "governed-assist",
  "supervised-coding",
  "autonomous-delivery",
]);
const PARENT_ENV_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
]);
const OFFLINE_CONTEXT_WINDOW = 32768;
const DEFAULT_QUIET_MS = 1500;
const DEFAULT_MAX_WAIT_MS = 60000;
const DEFAULT_GRACE_MS = 3000;
const POLL_MS = 100;

function offlineCapability() {
  return {
    kind: "chat",
    contextWindow: OFFLINE_CONTEXT_WINDOW,
    maxOutputTokens: 2048,
    toolCalling: false,
    structuredOutput: false,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "low",
    latencyClass: "standard",
    throughputHint: "local",
    preferredUseCases: ["Chat"],
    knownLimitations: [],
  };
}

/** Gateway configuration pointing both lab model ids at the scripted model server. */
function offlineGatewayConfig(baseUrl) {
  return {
    providers: [ANSWERER_MODEL_ID, LEARNER_MODEL_ID].map((modelId) => ({
      modelId,
      baseUrl,
      timeoutMs: 60000,
      maxRetries: 0,
      retryBaseDelayMs: 100,
      capability: offlineCapability(),
    })),
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenProbes: 1 },
  };
}

function apiKeyEnvName(modelId) {
  return `KEIKO_MODEL_${modelId.toUpperCase().replaceAll(/[^A-Z0-9]/gu, "_")}_API_KEY`;
}

function parentEnv(source) {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) => PARENT_ENV_KEYS.includes(key) || /^KEIKO_MODEL_[A-Z0-9_]+_API_KEY$/u.test(key),
    ),
  );
}

async function launcherSecretEnvName() {
  const { CODING_APP_SESSION_LAUNCHER_SECRET_ENV } = await importBuilt(
    "keiko-contracts",
    "coding-app-session.js",
  );
  return CODING_APP_SESSION_LAUNCHER_SECRET_ENV;
}

/** The hermetic child environment; `foldedKeys` names repo `.env` keys the BFF would fold in. */
async function labEnvironment(dir, options, source = process.env) {
  const project = realpathSync(join(dir, "project"));
  const env = {
    ...parentEnv(source),
    KEIKO_STATE_DIR: join(dir, "state"),
    KEIKO_UI_DATA_DIR: join(dir, "ui"),
    KEIKO_MEMORY_DIR: join(dir, "memory"),
    KEIKO_EVIDENCE_DIR: join(dir, "evidence"),
    KEIKO_CONFIG_FILE: options.configPath,
    KEIKO_INITIAL_PROJECT_PATH: project,
    KEIKO_MEMORY_KEY: randomBytes(32).toString("base64"),
    KEIKO_MEMORY_SALIENCE_MODEL_ID: options.learnModelId,
    KEIKO_CODING_DEPLOYMENT_CEILING: options.ceiling,
    KEIKO_LOG_LEVEL: "info",
    [apiKeyEnvName(options.answerModelId)]: source[apiKeyEnvName(options.answerModelId)] ?? "lab",
    [apiKeyEnvName(options.learnModelId)]: source[apiKeyEnvName(options.learnModelId)] ?? "lab",
    [await launcherSecretEnvName()]: randomBytes(32).toString("hex"),
  };
  const folded = buildDevBffEnv({
    repoRoot: options.subjectRoot ?? REPO_ROOT,
    processEnv: env,
    stateDir: env.KEIKO_STATE_DIR,
  });
  const foldedKeys = Object.keys(folded)
    .filter((key) => env[key] === undefined)
    .toSorted();
  return { project, env, foldedKeys };
}

function stubProxy() {
  return {
    address: () => ({ port: 0 }),
    close: (callback) => callback(),
    closeAllConnections: () => undefined,
  };
}

async function subjectRuntime(subjectRoot) {
  const file = join(
    subjectRoot ?? REPO_ROOT,
    "scripts",
    "testing",
    "chat-skills-lab",
    "runtime.mjs",
  );
  return import(pathToFileURL(file).href);
}

/**
 * Starts an instance. Offline mode needs a scripted model server (`fixture`); live mode needs an
 * existing gateway configuration file whose models the caller names.
 */
export async function startLabInstance(options) {
  if (!CEILINGS.includes(options.ceiling))
    throw new RangeError(`unknown ceiling ${options.ceiling}`);
  mkdirSync(join(options.dir, "project"), { recursive: true });
  const offline = options.fixture !== undefined;
  const configPath = offline ? join(options.dir, "gateway.json") : options.configPath;
  if (offline)
    writeFileSync(configPath, JSON.stringify(offlineGatewayConfig(options.fixture.baseUrl)), {
      mode: 0o600,
    });
  const answerModelId = offline ? ANSWERER_MODEL_ID : options.answerModelId;
  const learnModelId = offline ? LEARNER_MODEL_ID : options.learnModelId;
  const prepared = await labEnvironment(options.dir, {
    configPath,
    answerModelId,
    learnModelId,
    ceiling: options.ceiling,
    subjectRoot: options.subjectRoot,
  });
  const runtime = await subjectRuntime(options.subjectRoot);
  const started = await runtime.startObservedBff(
    options.dir,
    options.fixture ?? stubProxy(),
    undefined,
    OFFLINE_CONTEXT_WINDOW,
    async () => ({ project: prepared.project, env: prepared.env }),
  );
  return {
    dir: options.dir,
    logDirectory: join(prepared.env.KEIKO_STATE_DIR, "logs"),
    project: prepared.project,
    foldedKeys: prepared.foldedKeys,
    answerModelId,
    learnModelId,
    baseUrl: started.bff.baseUrl,
    request: (method, path, body, requestOptions) =>
      started.bff.request(method, path, body, requestOptions),
    close: () => started.close(),
  };
}

function expectOk(result, what) {
  if (result.status < 200 || result.status >= 300)
    throw new Error(
      `${what} failed with HTTP ${String(result.status)}: ${JSON.stringify(result.json)}`,
    );
  return result.json;
}

/** The capture ledger of the instance: every capture decision since the start, oldest first. */
export async function readCaptures(instance) {
  const json = expectOk(
    await instance.request("GET", "/api/memory?since=0&order=asc&limit=200"),
    "capture ledger",
  );
  return Array.isArray(json.captures) ? json.captures : [];
}

/** Every stored memory across the instance's scopes, as the list route returns them. */
export async function listMemories(instance) {
  const json = expectOk(await instance.request("GET", "/api/memory?limit=200"), "memory list");
  return Array.isArray(json.memories) ? json.memories : [];
}

// Without a pending-work signal (live mode) the learner's call is invisible until its capture
// lands, so the grace period is always waited through; with the signal, served queues end it early.
// Two signals end the wait. `openCalls` is the product's own evidence (model calls it started and
// has not completed) and is never cut short. `pendingLearner` is the lab's expectation (queued
// scripted replies) and is bounded by the grace period, because a turn the product handles without
// its learner, an explicit statement or a refused one, would otherwise wait forever.
async function learnerDone(options, startedAt) {
  if (options.openCalls !== undefined && (await options.openCalls()) > 0) return false;
  if (options.pendingLearner === undefined) return true;
  if ((await options.pendingLearner()) === 0) return true;
  return Date.now() - startedAt >= (options.graceMs ?? DEFAULT_GRACE_MS);
}

const GATEWAY_STARTED = "gateway.chat.started";
const GATEWAY_COMPLETED = new Set(["gateway.chat.completed", "gateway.stream.completed"]);

/**
 * Model calls the product has started and not completed, read from the instance's own Activity
 * Log. While the lab waits for learning no chat turn is in flight, so every open call is a learning
 * call; this is the live-mode counterpart of the scripted model's queue.
 */
export async function pendingGatewayCalls(instance) {
  const events = await readActivityEvents(instance.logDirectory);
  const started = new Set();
  const completed = new Set();
  for (const event of events) {
    if (event.op === GATEWAY_STARTED) started.add(event.correlationId);
    else if (GATEWAY_COMPLETED.has(event.op)) completed.add(event.correlationId);
  }
  let open = 0;
  for (const id of started) if (!completed.has(id)) open += 1;
  return open;
}

function observeLedger(state, count) {
  if (count === state.lastCount) return;
  state.lastCount = count;
  state.quietSince = Date.now();
}

/**
 * Waits until learning has settled: the capture ledger stays unchanged for `quietMs`, no model call
 * the product started is still open (`openCalls`, read from the instance's own Activity Log by
 * `pendingGatewayCalls`), and every scripted reply the lab queued was served or the grace period
 * passed (`pendingLearner`). Fails after `maxMs`.
 */
export async function awaitLearning(instance, options = {}) {
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  const maxMs = options.maxMs ?? DEFAULT_MAX_WAIT_MS;
  const startedAt = Date.now();
  const state = { lastCount: -1, quietSince: Date.now() };
  for (;;) {
    const count = (await readCaptures(instance)).length;
    observeLedger(state, count);
    const quiet = Date.now() - state.quietSince >= quietMs;
    if (quiet && (await learnerDone(options, startedAt))) return { captures: count };
    if (Date.now() - startedAt > maxMs) throw new Error("learning did not settle in time");
    await delay(POLL_MS);
  }
}
