// Actual connected-chat qualification: existing pairing, API, source identity and log reader.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { REPO_ROOT, UsageError, labBaseUrl, openApiSession, parseCli } from "./lab-common.mjs";
import { CONNECTED_CHAT_CAMPAIGNS, materializeManualCases } from "./connected-chat-cases.mjs";
import {
  connectedChatObservation,
  expectedSourceFactObservation,
} from "./connected-chat-record.mjs";

const USAGE =
  "connected-chat-run.mjs --campaign customer|knowledge|compaction|manual --repo <explicit-root> --runtime-state <private-json> --output <external-jsonl> [--corpus-witness <private-json>] [--prepare]";
const REQUEST_TIMEOUT_MS = 120_000;
const HISTORY_COUNT = 120;
const HISTORY_BYTES = 8192;

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
  return { chatId: bound.id, projectPath: project.path };
}

async function seedUserHistory(session, chat) {
  const label =
    "Synthetic qualification user note: context padding, never repository evidence or a model response. ";
  const content = label.repeat(Math.ceil(HISTORY_BYTES / label.length)).slice(0, HISTORY_BYTES);
  for (let index = 0; index < HISTORY_COUNT; index += 1)
    requireSuccess(
      await request(session, "POST", "/api/chats/messages", {
        ...chat,
        role: "user",
        content,
        timestamp: Date.now(),
      }),
    );
  return {
    syntheticUserMessageCount: HISTORY_COUNT,
    syntheticHistoryBytes: content.length * HISTORY_COUNT,
  };
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

async function runCase(session, runtime, chat, row) {
  requireHeldHead(runtime);
  const seed = row.seedHistoryBefore === true ? await seedUserHistory(session, chat) : {};
  requireHeldHead(runtime);
  const startedAt = Date.now();
  const result = await request(session, "POST", "/api/chats/messages/grounded", {
    ...chat,
    modelId: runtime.selectedModel,
    content: row.question,
  });
  requireHeldHead(runtime);
  const manifests = await evidenceManifests(session, result.json);
  const history = await request(
    session,
    "GET",
    `/api/chats/messages?chatId=${encodeURIComponent(chat.chatId)}&projectPath=${encodeURIComponent(chat.projectPath)}&limit=500`,
  );
  return {
    caseId: row.id,
    testedSha: runtime.testedSha,
    timestamp: new Date().toISOString(),
    status: result.status,
    elapsedMs: Date.now() - startedAt,
    ...seed,
    persistedMessageCount: history.json.messages?.length,
    ...(await connectedChatObservation(runtime, result, manifests, row.target)),
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
  return { session, runtime, chat, output, cases };
}

async function runCampaign({ session, runtime, chat, output, cases }) {
  for (const row of cases) {
    console.log(
      JSON.stringify({
        disposition: "query-started",
        caseId: row.id,
        testedSha: runtime.testedSha,
      }),
    );
    try {
      const record = await runCase(session, runtime, chat, row);
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
    } catch {
      appendRecord(output, {
        caseId: row.id,
        testedSha: runtime.testedSha,
        disposition: "unobserved-or-interrupted",
      });
      throw new UsageError("qualification-incomplete");
    }
  }
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
