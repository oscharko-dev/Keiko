// Actual connected-chat qualification: existing pairing, API, source identity and log reader.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { URLSearchParams } from "node:url";
import { buildDevBffEnv } from "../../lib/dev-bff-env.mjs";
import {
  REPO_ROOT,
  UsageError,
  importBuilt,
  labBaseUrl,
  openApiSession,
  parseCli,
} from "./lab-common.mjs";
import {
  CONNECTED_CHAT_CAMPAIGNS,
  materializeCompactionCases,
  materializeManualCases,
} from "./connected-chat-cases.mjs";
import {
  connectedChatObservation,
  expectedSourceFactObservation,
  historyCheckpointContinuity,
} from "./connected-chat-record.mjs";

const USAGE =
  "connected-chat-run.mjs --campaign customer|knowledge|compaction|manual --repo <explicit-root> --runtime-state <private-json> --output <external-jsonl> [--corpus-witness <private-json>] [--prepare]";
const REQUEST_TIMEOUT_MS = 120_000;

function sourceHead() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function requireHeldHead(runtime) {
  if (sourceHead() !== runtime.testedSha) throw new UsageError("source-hold-mismatch");
}

function requiredExternalPath(value) {
  if (typeof value !== "string" || value.length === 0) throw new UsageError("missing-path");
  const resolved = resolve(value);
  const candidate = join(realpathSync(dirname(resolved)), basename(resolved));
  const path = existsSync(candidate) ? realpathSync(candidate) : candidate;
  if (path === REPO_ROOT || path.startsWith(`${REPO_ROOT}${sep}`))
    throw new UsageError("external-state-required");
  return path;
}

function privateRuntime(path) {
  if ((statSync(path).mode & 0o077) !== 0) throw new UsageError("private-runtime-required");
  const runtime = JSON.parse(readFileSync(path, "utf8"));
  if (
    !/^[a-f0-9]{40}$/u.test(runtime.testedSha) ||
    !Number.isInteger(runtime.port) ||
    runtime.port < 1 ||
    runtime.port > 65535 ||
    typeof runtime.selectedModel !== "string"
  )
    throw new UsageError("invalid-runtime-metadata");
  const stateDir = requiredExternalPath(runtime.stateDir);
  const launcherPath = requiredExternalPath(runtime.launcherPath);
  if ((statSync(launcherPath).mode & 0o077) !== 0)
    throw new UsageError("private-launcher-required");
  return { ...runtime, stateDir, launcherPath };
}

function appendRecord(path, record) {
  if (existsSync(path) && (statSync(path).mode & 0o077) !== 0)
    throw new UsageError("private-output-required");
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

async function request(session, method, path, body) {
  return session.request(method, path, body, {
    signal: globalThis.AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function requireSuccess(result) {
  if (result.status < 200 || result.status >= 300) throw new UsageError("lab-request-refused");
  return result.json;
}

async function createChat(session, root, runtime, campaign) {
  const project = requireSuccess(
    await request(session, "POST", "/api/projects", {
      path: root,
      name: "Connected-chat local-model qualification",
    }),
  ).project;
  const created = requireSuccess(
    await request(session, "POST", "/api/chats", {
      projectPath: project.path,
      title: `Connected-chat ${campaign}`,
      selectedModel: runtime.selectedModel,
    }),
  ).chat;
  const bound = requireSuccess(
    await request(session, "PATCH", `/api/chats?id=${encodeURIComponent(created.id)}`, {
      connectedScopes: [
        { kind: "workspace-root", root, relativePaths: [], connectedAtMs: Date.now() },
      ],
    }),
  ).chat;
  return {
    chatId: bound.id,
    projectPath: project.path,
    groundingScopeIdentity: bound.groundingScopeIdentity,
  };
}

async function currentAcknowledgedChat(session, chat) {
  const query = new URLSearchParams({ id: chat.chatId, projectPath: chat.projectPath });
  const current = requireSuccess(await request(session, "GET", `/api/chats?${query}`)).chats?.[0];
  if (current?.id !== chat.chatId || current.groundingScopeIdentity !== chat.groundingScopeIdentity)
    throw new UsageError("acknowledged-scope-drift");
  return current;
}

function chatAddress(chat) {
  return { chatId: chat.chatId, projectPath: chat.projectPath };
}

async function evidenceManifests(session, answer) {
  const runIds =
    answer.evidenceRunIds ?? (answer.evidenceRunId === undefined ? [] : [answer.evidenceRunId]);
  const manifests = [];
  for (const runId of runIds) {
    const result = await request(session, "GET", `/api/evidence/${encodeURIComponent(runId)}`);
    if (result.status === 200) manifests.push(result.json.manifest);
  }
  return manifests;
}

async function runCase(session, runtime, chat, row, evidenceStore) {
  requireHeldHead(runtime);
  const before = await currentAcknowledgedChat(session, chat);
  requireHeldHead(runtime);
  const startedAt = Date.now();
  const result = await request(session, "POST", "/api/chats/messages/grounded", {
    ...chatAddress(chat),
    modelId: runtime.selectedModel,
    content: row.question,
    expectedGroundingScopeIdentity: before.groundingScopeIdentity,
  });
  const finishedAt = Date.now();
  requireHeldHead(runtime);
  const manifests = await evidenceManifests(session, result.json);
  const history = await request(
    session,
    "GET",
    `/api/chats/messages?chatId=${encodeURIComponent(chat.chatId)}&projectPath=${encodeURIComponent(chat.projectPath)}&limit=500`,
  );
  const after = await currentAcknowledgedChat(session, chat);
  const contextQuery = new URLSearchParams({
    ...chatAddress(chat),
    modelId: runtime.selectedModel,
  });
  const context = await request(session, "GET", `/api/chats/context?${contextQuery}`);
  const binding = {
    chatId: chat.chatId,
    question: row.question,
    startedAt,
    finishedAt,
    evidenceStore,
    modelId: runtime.selectedModel,
    scopeIdentityBefore: before.groundingScopeIdentity,
    scopeIdentityAfter: after.groundingScopeIdentity,
    persistedMessages: history.status === 200 ? history.json.messages : undefined,
    contextStatus: context.status === 200 ? context.json : undefined,
  };
  return {
    caseId: row.id,
    testedSha: runtime.testedSha,
    timestamp: new Date().toISOString(),
    status: result.status,
    elapsedMs: Date.now() - startedAt,
    ...(row.setup === undefined ? {} : { setup: row.setup }),
    persistedMessageCount: history.json.messages?.length,
    ...(await connectedChatObservation(runtime, result, manifests, row.target, binding)),
    ...(await expectedSourceFactObservation(result.json.content ?? "", row.expectedFact)),
  };
}

function campaignOptions() {
  const parsed = parseCli({
    usage: USAGE,
    options: {
      campaign: { type: "string" },
      repo: { type: "string" },
      "runtime-state": { type: "string" },
      output: { type: "string" },
      "corpus-witness": { type: "string" },
      prepare: { type: "boolean" },
    },
  });
  if (parsed.help) return undefined;
  const campaign = parsed.values.campaign;
  if (!Object.hasOwn(CONNECTED_CHAT_CAMPAIGNS, campaign)) throw new UsageError("invalid-campaign");
  const cases = CONNECTED_CHAT_CAMPAIGNS[campaign];
  if (parsed.values.prepare) {
    console.log(
      JSON.stringify({
        disposition: "preparation-only",
        campaign,
        caseIds: cases.map((row) => row.id),
        setupSynthesisTurns: cases.filter((row) => row.setupNote !== undefined).length,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
      }),
    );
    return undefined;
  }
  return { values: parsed.values, campaign, cases };
}

async function boundCampaignCases(parsed, root) {
  if (parsed.campaign !== "manual") return parsed.cases;
  const path = requiredExternalPath(parsed.values["corpus-witness"]);
  if ((statSync(path).mode & 0o077) !== 0) throw new UsageError("private-manual-witness-required");
  const corpus = JSON.parse(readFileSync(path, "utf8"));
  if (realpathSync(corpus.root) !== root || existsSync(join(root, ".git")))
    throw new UsageError("manual-root-witness-mismatch");
  return materializeManualCases(corpus);
}

async function setupCampaign(parsed) {
  const runtime = privateRuntime(requiredExternalPath(parsed.values["runtime-state"]));
  const output = requiredExternalPath(parsed.values.output);
  if (typeof parsed.values.repo !== "string") throw new UsageError("explicit-root-required");
  const root = realpathSync(parsed.values.repo);
  const cases = await boundCampaignCases(parsed, root);
  requireHeldHead(runtime);
  const env = {
    ...process.env,
    KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET: readFileSync(runtime.launcherPath, "utf8"),
  };
  const session = await openApiSession(labBaseUrl(`http://127.0.0.1:${runtime.port}`), env);
  const chat = await createChat(session, root, runtime, parsed.campaign);
  const { createNodeEvidenceStore, resolveEvidenceDir } = await importBuilt(
    "keiko-evidence",
    "index.js",
  );
  const effectiveEnv = buildDevBffEnv({
    repoRoot: REPO_ROOT,
    processEnv: process.env,
    stateDir: runtime.stateDir,
  });
  const evidenceStore = createNodeEvidenceStore(resolveEvidenceDir(undefined, effectiveEnv));
  const readyCases =
    parsed.campaign === "compaction"
      ? await compactionCases(session, runtime, chat, effectiveEnv)
      : cases;
  return { session, runtime, chat, output, cases: readyCases, evidenceStore };
}

async function compactionCases(session, runtime, chat, env) {
  const path = env.KEIKO_CONFIG_FILE ?? join(env.KEIKO_UI_DATA_DIR, "keiko.config.json");
  if ((statSync(path).mode & 0o077) !== 0) throw new UsageError("private-config-required");
  const { parseGatewayConfig } = await importBuilt("keiko-model-gateway", "index.js");
  const { currentContextProfileForModel } = await importBuilt("keiko-server", "deps.js");
  const config = parseGatewayConfig(JSON.parse(readFileSync(path, "utf8")));
  const profile = currentContextProfileForModel({ config }, runtime.selectedModel);
  const query = new URLSearchParams({ ...chatAddress(chat), modelId: runtime.selectedModel });
  const status = requireSuccess(await request(session, "GET", `/api/chats/context?${query}`));
  if (
    profile === undefined ||
    profile.maxInputTokens !== status.contextWindowTokens ||
    profile.effectiveInputBudget !== status.inputBudgetTokens
  )
    throw new UsageError("compaction-profile-unbound");
  return materializeCompactionCases(profile);
}

async function runCampaign({ session, runtime, chat, output, cases, evidenceStore }) {
  let checkpoint;
  for (const row of cases) {
    console.log(
      JSON.stringify({
        disposition: "query-started",
        caseId: row.id,
        testedSha: runtime.testedSha,
      }),
    );
    try {
      if (row.requireHistoryCheckpoint && checkpoint?.disposition !== "observed")
        throw new UsageError("compaction-checkpoint-unobserved");
      const record = await runCase(session, runtime, chat, row, evidenceStore);
      if (row.requireHistoryCheckpoint)
        record.checkpointContinuity = historyCheckpointContinuity(
          checkpoint,
          record.historyCompaction,
        );
      appendRecord(output, record);
      console.log(
        JSON.stringify({
          caseId: row.id,
          status: record.status,
          elapsedMs: record.elapsedMs,
          assessmentChars: record.assessmentChars,
          citationCount: record.citationCount,
          analysisSufficiency: record.analysisSufficiency,
        }),
      );
      if (record.status !== 200) throw new UsageError("lab-request-refused");
      checkpoint = nextHistoryCheckpoint(row, record, checkpoint);
    } catch (error) {
      appendRecord(output, {
        caseId: row.id,
        testedSha: runtime.testedSha,
        disposition: "unobserved-or-interrupted",
        cause: qualificationFailureCause(error),
      });
      throw new UsageError("qualification-incomplete");
    }
  }
}

function nextHistoryCheckpoint(row, record, previous) {
  if (record.checkpointContinuity?.disposition === "unobserved")
    throw new UsageError("compaction-checkpoint-unobserved");
  if (!row.establishHistoryCheckpoint) return previous;
  if (record.historyCompaction?.disposition !== "observed")
    throw new UsageError("compaction-checkpoint-unobserved");
  return record.historyCompaction;
}

function qualificationFailureCause(error) {
  const causes = new Set([
    "source-hold-mismatch",
    "acknowledged-scope-drift",
    "compaction-checkpoint-unobserved",
    "lab-request-refused",
  ]);
  return error instanceof UsageError && causes.has(error.message)
    ? error.message
    : "request-or-observation-failed";
}

async function main() {
  const parsed = campaignOptions();
  if (parsed === undefined) return;
  await runCampaign(await setupCampaign(parsed));
}

main().catch(() => {
  console.error(
    "connected-chat-lab: incomplete; inspect the body-free local record and Activity Log",
  );
  process.exitCode = 1;
});
