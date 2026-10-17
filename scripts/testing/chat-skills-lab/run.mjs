import { writeFileSync, mkdirSync, realpathSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, relative, isAbsolute, dirname, basename } from "node:path";
import { fileURLToPath, URL, URLSearchParams } from "node:url";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { startRuntime, MODEL, digest, workingDiffDigest } from "./runtime.mjs";
import { SOURCE, SKILL, APP, CASES } from "./cases.mjs";
import { contextObservation, expectedSkillTokens, turnObservation } from "./observations.mjs";
const runDir = process.env.KEIKO_QUALIFICATION_OUTPUT;
if (!runDir) throw new Error("Explicit private qualification output directory required.");
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const relativeOutput = relative(
  repositoryRoot,
  join(realpathSync(dirname(resolve(runDir))), basename(runDir)),
);
if (relativeOutput === "" || (!relativeOutput.startsWith("..") && !isAbsolute(relativeOutput)))
  throw new Error("Qualification output must remain outside the checkout.");
process.chdir(repositoryRoot);
mkdirSync(runDir, { mode: 0o700 });
writeFileSync(
  join(runDir, "predeclared.json"),
  JSON.stringify(
    {
      model: MODEL,
      cases: CASES.map(({ question, ...c }) => ({ ...c, questionDigest: digest(question) })),
      sourceDigest: digest(SOURCE),
      skillDigest: digest(SKILL),
      repetitions: 3,
      matchedControls: true,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
class QualificationError extends Error {
  constructor(reason, status) {
    super(reason);
    this.reason = reason;
    this.status = status;
  }
}
const reasonOf = (error) =>
  error instanceof QualificationError ? error.reason : "operation-failed";
const ledger = [];
const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const sourceDiffDigest = await workingDiffDigest(repositoryRoot);
const harnessDigests = Object.fromEntries(
  readdirSync(join(repositoryRoot, "scripts/testing/chat-skills-lab"))
    .filter((name) => name.endsWith(".mjs"))
    .sort()
    .map((name) => [name, digest(readFileSync(new URL(name, import.meta.url)))]),
);
let runtime;
const save = () =>
  writeFileSync(
    join(runDir, "ledger.json"),
    JSON.stringify(
      { sourceHead, sourceDiffDigest, harnessDigests, ledger, physical: runtime?.physical ?? [] },
      null,
      2,
    ),
    { mode: 0o600 },
  );
function checked(response) {
  if (response.status < 200 || response.status >= 300)
    throw new QualificationError("request-refused", response.status);
  return response.json;
}
async function request(method, path, body) {
  return checked(await runtime.request(method, path, body, { timeoutMs: 360000 }));
}
async function newChat(name, selected, grounded) {
  const { chat } = await request("POST", "/api/chats", {
    projectPath: runtime.project,
    title: name,
    selectedModel: MODEL,
  });
  let selection = { revision: 0, skill: null };
  if (selected) {
    const r = await request("PUT", `/api/chats/${chat.id}/skill`, {
      skill: { id: selected.id, revision: selected.revision, digest: selected.digest },
      expectedRevision: 0,
    });
    selection = r.selection;
  }
  if (grounded) {
    const bound = await request("PATCH", `/api/chats?id=${encodeURIComponent(chat.id)}`, {
      connectedScopes: [
        { kind: "files", relativePaths: ["concept.md"], connectedAtMs: Date.now() },
      ],
    });
    Object.assign(chat, bound.chat);
  }
  return { chat, selection };
}
async function seed(chat, count) {
  for (let i = 0; i < count; i++)
    await request("POST", "/api/chats/messages", {
      chatId: chat.id,
      projectPath: runtime.project,
      role: i % 2 ? "assistant" : "user",
      content:
        i === 0 || i === count - 2
          ? SOURCE
          : `Previous synthetic turn ${i}. ${"Bounded synthetic history. ".repeat(150)}`,
      timestamp: Date.now() + i,
    });
}
async function context(chat) {
  return request(
    "GET",
    `/api/chats/context?${new URLSearchParams({ chatId: chat.id, projectPath: runtime.project, modelId: MODEL })}`,
  );
}
async function send(chat, selection, content) {
  const result = await runtime.request(
    "POST",
    chat.connectedScopes?.length ? "/api/chats/messages/grounded" : "/api/desktop/chat",
    {
      chatId: chat.id,
      projectPath: runtime.project,
      content,
      modelId: MODEL,
      expectedSkillSelectionRevision: selection.skill === null ? null : selection.revision,
      ...(chat.connectedScopes?.length
        ? { expectedGroundingScopeIdentity: chat.groundingScopeIdentity }
        : { clientTurnId: randomUUID() }),
    },
    { timeoutMs: 360000 },
  );
  return { body: checked(result), correlationId: result.correlationId };
}
async function restoreSelection(chat, selection, selected) {
  await runtime.restart();
  const restored = await request("GET", `/api/chats/${chat.id}/skill`);
  if (JSON.stringify(restored.selection) !== JSON.stringify(selection))
    throw new QualificationError("restore-selection-mismatch");
  if (!selected) return;
  let result = await request("PUT", `/api/chats/${chat.id}/skill`, {
    skill: null,
    expectedRevision: selection.revision,
  });
  result = await request("PUT", `/api/chats/${chat.id}/skill`, {
    skill: { id: selected.id, revision: selected.revision, digest: selected.digest },
    expectedRevision: result.selection.revision,
  });
  Object.assign(selection, result.selection);
}

async function prepareScenario(task, entry, selected) {
  const { chat, selection } = await newChat(entry.id, selected, task.grounded);
  if (task.scenario !== "plain") {
    runtime.setActive(`${entry.id}:before`, task.question);
    const baseline = await send(chat, selection, `${task.question}\n\n${SOURCE}`);
    writeFileSync(join(runDir, `${entry.id}-before.private.json`), JSON.stringify(baseline), {
      mode: 0o600,
    });
    runtime.setActive(entry.id, task.question);
    await seed(chat, task.scenario === "automatic" ? 16 : 4);
  }
  const before = await context(chat),
    tokens = await expectedSkillTokens(runtime, selected);
  entry.before = contextObservation(before, selected, tokens);
  if (task.scenario === "manual") {
    const compacted = await request("POST", "/api/chats/context/compact", {
      chatId: chat.id,
      projectPath: runtime.project,
      modelId: MODEL,
    });
    entry.manualCompaction = contextObservation(compacted, selected, tokens);
  }
  if (task.scenario === "restore") await restoreSelection(chat, selection, selected);
  return { chat, selection, before, tokens, selected };
}

async function observeTurn(task, entry, prepared) {
  const { chat, selection, before, tokens, selected } = prepared;
  const reply = await send(chat, selection, task.question),
    response = reply.body;
  const after = await context(chat);
  entry.after = contextObservation(after, selected, tokens);
  const history = await request(
    "GET",
    `/api/chats/messages?${new URLSearchParams({ chatId: chat.id, projectPath: runtime.project, limit: "500" })}`,
  );
  entry.turn = await turnObservation(
    runtime,
    reply.correlationId,
    chat.id,
    after,
    SKILL,
    history.messages,
  );
  const output = task.grounded
    ? response.content
    : response.messages?.findLast((message) => message.role === "assistant")?.content;
  if (task.grounded)
    entry.citationCount =
      response.citations?.filter((citation) => citation.scopePath === "concept.md").length ?? 0;
  if (typeof output !== "string" || !output.trim())
    throw new QualificationError("missing-assistant-result");
  writeFileSync(join(runDir, `${entry.id}.private.md`), output, { mode: 0o600 });
  writeFileSync(
    join(runDir, `${entry.id}.private-context.json`),
    JSON.stringify({ before, after, response }, null, 2),
    { mode: 0o600 },
  );
  entry.outputDigest = digest(output);
  entry.outputBytes = Buffer.byteLength(output);
}

function checkCompactionRequests(entry, physicalStart) {
  const summaries = runtime.physical
    .slice(physicalStart)
    .filter((call) => call.caseId === entry.id && call.operation === "compaction");
  entry.compactionRequestCount = summaries.length;
  entry.compactionRequestsExcludeSkill = summaries.every((call) => call.skillOccurrences === 0);
  if (!entry.compactionRequestsExcludeSkill)
    throw new QualificationError("skill-in-summary-request");
}

function checkTransition(task, entry, physicalStart, selected) {
  if (task.scenario === "plain") return;
  const prior = runtime.physical
    .slice(physicalStart)
    .filter((call) => call.caseId === `${entry.id}:before` && call.caseRequest === true);
  entry.protectedBeforeTransition =
    prior.length > 0 && prior.every((call) => call.skillOccurrences === (selected ? 1 : 0));
  if (!entry.protectedBeforeTransition)
    throw new QualificationError("initial-protected-context-mismatch");
}

function checkTurn(task, entry, physicalStart, selected) {
  const calls = runtime.physical
    .slice(physicalStart)
    .filter((call) => call.caseId === entry.id && call.caseRequest === true);
  entry.physicalAttemptCount = calls.length;
  entry.protectedSkill =
    calls.length > 0 && calls.every((call) => call.skillOccurrences === (selected ? 1 : 0));
  if (task.grounded && entry.citationCount === 0)
    throw new QualificationError("source-citation-unobserved");
  if (!entry.protectedSkill || !entry.before.accounted || !entry.after.accounted)
    throw new QualificationError("protected-context-mismatch");
  if (
    new Set(["manual", "automatic"]).has(task.scenario) &&
    (!entry.turn.checkpoint.observed || !entry.turn.checkpoint.excludesSkill)
  )
    throw new QualificationError("compaction-unobserved");
  checkTransition(task, entry, physicalStart, selected);
  checkCompactionRequests(entry, physicalStart);
}

async function qualifyCase(task, repetition, selected) {
  const id = `${task.id}-${repetition}-${selected ? "skill" : "control"}`;
  runtime.setActive(id, task.question);
  const start = Date.now(),
    physicalStart = runtime.physical.length;
  const entry = {
    id,
    scenario: task.scenario,
    repetition,
    selected: !!selected,
    status: "running",
  };
  ledger.push(entry);
  save();
  try {
    const prepared = await prepareScenario(task, entry, selected);
    await observeTurn(task, entry, prepared);
    await runtime.drain();
    checkTurn(task, entry, physicalStart, selected);
    entry.status = "semantic-review-pending";
  } catch (error) {
    entry.status = "failed";
    entry.reason = reasonOf(error);
    entry.httpStatus = error instanceof QualificationError ? error.status : undefined;
  }
  entry.durationMs = Date.now() - start;
  save();
  console.log(JSON.stringify(entry));
}

async function qualifyAuthor(repetition) {
  const id = `author-${repetition}`;
  runtime.setActive(id);
  const start = Date.now(),
    entry = { id, status: "running" };
  ledger.push(entry);
  save();
  try {
    const result = await request("POST", "/api/prompt-enhancement", {
      text: SOURCE,
      modelId: MODEL,
      outputKind: "markdown-skill",
      candidateCount: 1,
    });
    writeFileSync(join(runDir, `${id}.private.md`), result.renderedPrompt, { mode: 0o600 });
    Object.assign(entry, {
      status: "semantic-review-pending",
      outputDigest: digest(result.renderedPrompt),
      evidenceStatus: result.evidence.status,
      evidenceReason: result.evidence.reason,
    });
    if (entry.evidenceStatus !== "not-recorded" || entry.evidenceReason !== "private-skill-draft")
      throw new QualificationError("private-evidence-mismatch");
  } catch (error) {
    entry.status = "failed";
    entry.reason = reasonOf(error);
  }
  entry.durationMs = Date.now() - start;
  save();
  console.log(JSON.stringify(entry));
}

try {
  const selectedCase = process.argv[2] ?? "setup";
  const task = CASES.find((item) => item.id === selectedCase);
  runtime = await startRuntime(join(runDir, "runtime"), {
    contextWindow: new Set(["manual", "automatic"]).has(task?.scenario) ? 8192 : 131072,
    skillBody: SKILL,
    source: SOURCE,
  });
  const registered = await request("POST", "/api/projects", {
    path: runtime.project,
    name: "Synthetic skill qualification",
  });
  runtime.project = registered.project.path;
  writeFileSync(join(runtime.project, "concept.md"), SOURCE, { mode: 0o600 });
  const { skill } = await request("POST", "/api/skills", {
    fileName: "garden-method.md",
    contentBase64: Buffer.from(SKILL).toString("base64"),
  });
  writeFileSync(join(runDir, "SensorBadge.tsx"), APP, { mode: 0o600 });
  if (selectedCase === "setup")
    console.log(JSON.stringify({ ready: true, skillImported: true, revision: skill.revision }));
  else if (selectedCase === "author") {
    for (let repetition = 1; repetition <= 3; repetition++) await qualifyAuthor(repetition);
  } else if (task) {
    for (let repetition = 1; repetition <= 3; repetition++) {
      await qualifyCase(task, repetition, skill);
      await qualifyCase(task, repetition, undefined);
    }
  } else throw new Error("unknown-case");
} catch (error) {
  console.log(
    JSON.stringify({
      status: "setup-failed",
      reason: reasonOf(error),
    }),
  );
  process.exitCode = 1;
} finally {
  if (ledger.some((item) => item.status === "failed")) process.exitCode = 1;
  try {
    await runtime?.drain();
  } finally {
    await runtime?.close();
    save();
  }
}
