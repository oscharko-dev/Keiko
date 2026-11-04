// One isolated Keiko instance per scenario run (#4207): the real BFF and Gateway composition of the
// chat-skills lab, started with a private state directory, its own vault key and the lab's models,
// driven only through public HTTP routes, and torn down with its fixture. Nothing here reads the
// vault file or imports a memory package; what the lab sees is what a person would get.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { REPO_ROOT, importBuilt } from "../coding-workbench-lab/lab-common.mjs";
import { readActivityEvents } from "../coding-workbench-lab/activity-log-events.mjs";
import { buildDevBffEnv } from "../../lib/dev-bff-env.mjs";
import { openCallKeys } from "./gateway-calls.mjs";
import { LabConfigurationError } from "./isolation.mjs";
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

// The repository `.env` keys the BFF would fold into the child's environment change the product
// that is measured (a memory mode, a model, a limit), so they are refused unless the operator says
// that is wanted; the run's manifest records the decision either way.
function assertNoFoldedEnvironment(foldedKeys, allowed) {
  if (foldedKeys.length === 0 || allowed === true) return;
  throw new LabConfigurationError(
    `the repository .env would fold ${String(foldedKeys.length)} KEIKO_* key(s) into the measured instance (${foldedKeys.join(", ")}); remove them or pass --allow-folded-env to measure with them`,
  );
}

/**
 * Starts an instance. Offline mode needs a scripted model server (`fixture`); live mode needs an
 * existing gateway configuration file whose models the caller names. An instance whose environment
 * the repository `.env` would change is refused unless `allowFoldedEnv` is true.
 */
export async function startLabInstance(options) {
  if (!CEILINGS.includes(options.ceiling))
    throw new RangeError(`unknown ceiling ${options.ceiling}`);
  mkdirSync(join(options.dir, "project"), { recursive: true });
  const offline = options.fixture !== undefined;
  // The product writes its configuration file back (credentials it persists at start, a context
  // window it adopts), so every instance gets a private copy and the operator's file is never
  // written; the runner checks that file's digest before each unit. Paths inside it must be absolute.
  const configPath = join(options.dir, "gateway.json");
  writeFileSync(
    configPath,
    offline
      ? JSON.stringify(offlineGatewayConfig(options.fixture.baseUrl))
      : readFileSync(options.configPath),
    { mode: 0o600 },
  );
  const answerModelId = offline ? ANSWERER_MODEL_ID : options.answerModelId;
  const learnModelId = offline ? LEARNER_MODEL_ID : options.learnModelId;
  const prepared = await labEnvironment(options.dir, {
    configPath,
    answerModelId,
    learnModelId,
    ceiling: options.ceiling,
    subjectRoot: options.subjectRoot,
  });
  assertNoFoldedEnvironment(prepared.foldedKeys, options.allowFoldedEnv);
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

// The largest page either listing route serves (MAX_LIST_LIMIT of memory-handlers.ts).
const PAGE_SIZE = 200;

// Both listing routes report how many rows exist beyond the page they served. A response without
// that figure cannot be paged through, and reading it as complete would measure a window.
function reportedTotal(json, what) {
  if (!Number.isSafeInteger(json?.total) || json.total < 0)
    throw new Error(`${what} response carries no usable total`);
  return json.total;
}

/**
 * Every stored memory across the instance's scopes, as the list route returns them (newest first).
 * The route serves at most 200 rows per page, so the list is read page by page until the reported
 * total is reached. It fails when the total changes between pages (the store moved under the
 * reader) or a page comes back empty before the total is reached (paging is impossible); a partial
 * list would make a large run look smaller than it is.
 */
export async function listMemories(instance) {
  const memories = [];
  let total;
  do {
    const json = expectOk(
      await instance.request(
        "GET",
        `/api/memory?limit=${String(PAGE_SIZE)}&offset=${String(memories.length)}`,
      ),
      "memory list",
    );
    const reported = reportedTotal(json, "memory list");
    if (total !== undefined && reported !== total)
      throw new Error(
        `memory list changed while it was read (${String(total)} -> ${String(reported)})`,
      );
    total = reported;
    const page = Array.isArray(json.memories) ? json.memories : [];
    if (page.length === 0 && memories.length < total)
      throw new Error(
        `memory list paging stalled at ${String(memories.length)} of ${String(total)}`,
      );
    memories.push(...page);
  } while (memories.length < total);
  if (memories.length !== total)
    throw new Error(
      `memory list returned ${String(memories.length)} rows for a total of ${String(total)}`,
    );
  return memories;
}

async function readLedgerPage(instance, since) {
  const json = expectOk(
    await instance.request(
      "GET",
      `/api/memory?since=${String(since)}&order=asc&limit=${String(PAGE_SIZE)}`,
    ),
    "capture ledger",
  );
  return {
    captures: Array.isArray(json.captures) ? json.captures : [],
    total: reportedTotal(json, "capture ledger"),
  };
}

/**
 * The number of capture decisions the instance has recorded since its start. One row is requested:
 * the quiet detector needs the count, which the ledger reports whatever the page size.
 */
export async function captureTotal(instance) {
  const json = expectOk(
    await instance.request("GET", "/api/memory?since=0&order=asc&limit=1"),
    "capture ledger",
  );
  return reportedTotal(json, "capture ledger");
}

// What the pages read so far say about the whole ledger: the decisions older than `since` that were
// already read plus the route's count from `since` on. It must not move while the ledger is read.
function ledgerSize(read, since, page) {
  let older = 0;
  for (const capture of read.values()) if (capture.occurredAt < since) older += 1;
  return older + page.total;
}

// Adds the decisions of a page that were not read before and returns how many were new. A decision
// is known by its event id, so a row without one cannot be paged through.
function absorb(read, captures) {
  let added = 0;
  for (const capture of captures) {
    if (typeof capture?.eventId !== "string" || capture.eventId.length === 0)
      throw new Error("capture ledger row carries no event id");
    if (read.has(capture.eventId)) continue;
    read.set(capture.eventId, capture);
    added += 1;
  }
  return added;
}

/**
 * The capture ledger of the instance: every capture decision since the start, oldest first. The
 * ledger route has no offset, so it is read by time: each page starts at the last decision of the
 * page before (the route's `since` includes it) and decisions already read are dropped by their event
 * id. It fails when the ledger's size changes between pages or when a whole page repeats decisions
 * already read (more than a page of them share one millisecond, so paging cannot advance).
 */
export async function readCaptures(instance) {
  const read = new Map();
  let since = 0;
  let size;
  do {
    const page = await readLedgerPage(instance, since);
    const current = ledgerSize(read, since, page);
    if (size !== undefined && current !== size)
      throw new Error(
        `capture ledger changed while it was read (${String(size)} -> ${String(current)})`,
      );
    size = current;
    if (absorb(read, page.captures) === 0 && read.size < size)
      throw new Error(`capture ledger paging stalled at ${String(read.size)} of ${String(size)}`);
    since = page.captures.at(-1)?.occurredAt ?? since;
  } while (read.size < size);
  if (read.size !== size)
    throw new Error(
      `capture ledger returned ${String(read.size)} decisions for a size of ${String(size)}`,
    );
  return [...read.values()];
}

// The lab's own expectation: queued scripted replies (`pendingLearner`) end the wait once served and
// are bounded by the grace period, because a turn the product handles without its learner, an
// explicit statement or a refused one, would otherwise wait forever. Without the signal (live mode)
// the grace period is always waited through.
async function learnerDone(options, startedAt) {
  if (options.pendingLearner === undefined) return true;
  if ((await options.pendingLearner()) === 0) return true;
  return Date.now() - startedAt >= (options.graceMs ?? DEFAULT_GRACE_MS);
}

/**
 * Model calls the product has started and not ended, read from the instance's own Activity Log: a
 * call ends with a completed, failed or abandoned line, so a learner call that failed (an unreachable
 * model, a refused request) is finished and must not hold the wait open. While the lab waits for
 * learning no chat turn is in flight, so every open call is a learning call; this is the live-mode
 * counterpart of the scripted model's queue.
 */
export async function pendingGatewayCalls(instance) {
  return openCallKeys(await readActivityEvents(instance.logDirectory)).size;
}

// The quiet period starts over whenever the ledger moved or a model call is still open. A capture is
// written only after its learner call completed, so a wait that merely saw the call end could return
// in the gap before the capture lands; the quiet period must outlast the call's end.
function observeActivity(state, count, openCalls) {
  const moved = count !== state.lastCount;
  state.lastCount = count;
  if (moved || openCalls > 0) state.quietSince = Date.now();
}

/**
 * Waits until learning has settled: for `quietMs` the capture ledger stayed unchanged and no model
 * call the product started was open (`openCalls`, read from the instance's own Activity Log by
 * `pendingGatewayCalls`; the product's own evidence, never cut short), and every scripted reply the
 * lab queued was served or the grace period passed (`pendingLearner`). Fails after `maxMs`, naming
 * the `phase` of the unit when the caller gives one.
 */
export async function awaitLearning(instance, options = {}) {
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  const maxMs = options.maxMs ?? DEFAULT_MAX_WAIT_MS;
  const startedAt = Date.now();
  const state = { lastCount: -1, quietSince: Date.now() };
  for (;;) {
    const count = await captureTotal(instance);
    const open = options.openCalls === undefined ? 0 : await options.openCalls();
    observeActivity(state, count, open);
    const quiet = Date.now() - state.quietSince >= quietMs;
    if (quiet && (await learnerDone(options, startedAt))) return { captures: count };
    if (Date.now() - startedAt > maxMs)
      throw new Error(
        `learning did not settle in time${options.phase === undefined ? "" : ` (${options.phase})`}`,
      );
    await delay(POLL_MS);
  }
}
