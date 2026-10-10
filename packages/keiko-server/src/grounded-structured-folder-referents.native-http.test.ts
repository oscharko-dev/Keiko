import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatConnectedScope,
  HybridGroundedAnswer,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import {
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  updateCapsuleState,
} from "@oscharko-dev/keiko-local-knowledge";
import { seedCapsuleWithVectors } from "@oscharko-dev/keiko-local-knowledge/testing";
import { createDefaultChatCapability, parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import { buildCspHeader } from "./csp.js";
import { createNodeUiStore } from "./store/index.js";
import {
  createFileServerLogSink,
  createServerLogger,
  setServerLogger,
} from "./observability/index.js";
import { closeUiTestServer, startUiTestServer } from "./ui-test-server/_support.js";
import { readPersistedActivityLog } from "../../../tests/support/activity-log-proof.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";

const MODEL = "structured-folder-referent-native-proof";
const TARGET = "src/deep/Novel.ts";
const OTHER = "src/deep/Other.ts";
const BEFORE = "37;";
const AFTER = "83;";
const COLLISION = "211;";
type ReplyKind = "path" | "numeric" | "general" | "pod" | "both";
let directory = "";
const servers: Server[] = [];
const runtimes: UiHandlerDeps[] = [];

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "keiko-structured-referent-")));
  vi.stubEnv("KEIKO_STATE_DIR", join(directory, "state"));
  resetServerLogger();
});
afterEach(async () => {
  for (const server of servers.splice(0)) await closeUiTestServer(server);
  for (const deps of runtimes.splice(0)) await deps.dispose?.();
  resetServerLogger();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

interface ProviderState {
  reply: ReplyKind;
  readonly evidence: string[];
}
interface Fixture {
  readonly deps: UiHandlerDeps;
  readonly base: string;
  readonly dbPath: string;
  readonly root: string;
  readonly chatId: string;
  readonly provider: ProviderState;
}

function populate(name: string, fact = BEFORE): string {
  const root = join(directory, name);
  mkdirSync(join(root, "src/deep"), { recursive: true });
  const lines = Array.from({ length: 90 }, () => "// ordinary source padding");
  lines[60] = fact;
  writeFileSync(join(root, TARGET), lines.join("\n"));
  writeFileSync(join(root, OTHER), "export const invoiceReconciliation = 67;\n");
  for (let index = 0; index < 102; index += 1)
    writeFileSync(
      join(root, `src/ordinary-${String(index)}.ts`),
      `export function ordinary${String(index)}() { return true; }\n`,
    );
  return root;
}

function evidenceBlock(prompt: string, kind: string, fact: string): RegExpExecArray | null {
  const blocks =
    /\[(\d+)\] ### (Folder|Connector) source:[^\n]*\n([\s\S]*?)```text\n([\s\S]*?)```/gu;
  return (
    [...prompt.matchAll(blocks)].find((match) => match[2] === kind && match[4]?.includes(fact)) ??
    null
  );
}

function podReply(prompt: string): string {
  const pod = evidenceBlock(prompt, "Connector", "Pod reference value");
  return pod === null
    ? "<assessment>No matching Pod reference.</assessment>"
    : `The Pod reference value is 19 [${pod[1] ?? "0"}].`;
}

function bothReply(prompt: string): string {
  const folder = evidenceBlock(prompt, "Folder", BEFORE);
  const second = evidenceBlock(prompt, "Folder", COLLISION);
  return folder === null || second === null
    ? "<assessment>Both folder sources were not supplied.</assessment>"
    : `The values are 37 [${folder[1] ?? "0"}] and 211 [${second[1] ?? "0"}].`;
}

function folderReply(prompt: string, kind: ReplyKind): string {
  const fact = prompt.includes(AFTER) ? AFTER : BEFORE;
  const folder = evidenceBlock(prompt, "Folder", fact);
  if (folder === null) return "<assessment>No current folder evidence was supplied.</assessment>";
  const marker = folder[1] ?? "0";
  const value = fact === AFTER ? "83" : "37";
  const path = kind === "path" ? ` [source:1|${TARGET}:61]` : "";
  return `The current value is ${value} [${marker}].${path}`;
}

function replyFor(prompt: string, state: ProviderState): string {
  if (state.reply === "general")
    return "<assessment>General engineering tradeoffs require context.</assessment>";
  if (state.reply === "pod") return podReply(prompt);
  if (state.reply === "both") return bothReply(prompt);
  return folderReply(prompt, state.reply);
}

function providerReply(body: string, res: ServerResponse, state: ProviderState): void {
  const request = JSON.parse(body) as {
    readonly messages: readonly { readonly role: string; readonly content: string }[];
  };
  const prompt =
    request.messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
  const synthesized = prompt.includes("Connected sources:");
  if (synthesized) state.evidence.push(prompt.slice(prompt.indexOf("Connected sources:")));
  const content = synthesized ? replyFor(state.evidence.at(-1) ?? "", state) : "Explain that.";
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "structured-referent-proof",
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
}

async function provider(): Promise<{ readonly baseUrl: string; readonly state: ProviderState }> {
  const state: ProviderState = { reply: "path", evidence: [] };
  const server = createServer((req, res): void => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (part: string): void => {
      body += part;
    });
    req.once("end", (): void => {
      providerReply(body, res, state);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("Unbound provider");
  return { baseUrl: `http://127.0.0.1:${String(address.port)}/v1`, state };
}

async function connectPod(deps: UiHandlerDeps, chatId: string): Promise<void> {
  const runtimeStateDir = dirname(deps.uiDbPath ?? "");
  const store = openKnowledgeStore({ dbPath: resolveKnowledgeStorePath({ runtimeStateDir }) });
  try {
    const pod = await seedCapsuleWithVectors(store, {
      displayName: "Structured referents",
      chunkingOptions: { maxTokens: 256, minTokens: 0, overlapTokens: 0 },
      text: "Explain that. Pod reference value is 19. src/deep/Novel.ts is a document locator.",
    });
    updateCapsuleState(store, pod.capsuleId, "ready");
    deps.store.updateChat(chatId, {
      localKnowledgeScopes: [{ kind: "capsule", capsuleId: pod.capsuleId, connectedAtMs: 1 }],
    });
  } finally {
    store.close();
  }
}

function runtime(
  root: string,
  baseUrl: string,
): { readonly deps: UiHandlerDeps; readonly chatId: string; readonly dbPath: string } {
  const stateDir = join(directory, "state");
  setServerLogger(
    createServerLogger({
      sink: createFileServerLogSink(stateDir, { level: "debug" }),
      level: "debug",
    }),
  );
  const dbPath = join(stateDir, "ui.db");
  const deps = buildUiHandlerDeps({
    configPath: join(stateDir, "gateway.json"),
    evidenceDir: join(stateDir, "evidence"),
    uiDbPath: dbPath,
    env: {},
  });
  runtimes.push(deps);
  deps.gatewayConfig?.set(
    parseGatewayConfig({
      providers: [{ modelId: MODEL, baseUrl, apiKey: "fixture", maxRetries: 0 }],
      capabilities: [
        { ...createDefaultChatCapability(MODEL), contextWindow: 32768, maxOutputTokens: 1024 },
      ],
    }),
    true,
  );
  deps.gatewayConfig?.recordVerifiedCapability(
    MODEL,
    { conversationReady: true },
    new Date().toISOString(),
    deps.gatewayConfig.generation(),
  );
  deps.store.createProject(root, "Structured folder referents");
  const chat = deps.store.createChat(root, "Structured folder referents", MODEL);
  deps.store.updateChat(chat.id, {
    connectedScopes: [{ root, kind: "workspace-root", relativePaths: [], connectedAtMs: 1 }],
  });
  return { deps, chatId: chat.id, dbPath };
}

async function fixture(twoRoots = false): Promise<Fixture> {
  const root = populate("alpha");
  const upstream = await provider();
  const active = runtime(root, upstream.baseUrl);
  if (twoRoots)
    active.deps.store.updateChat(active.chatId, {
      connectedScopes: [
        { ...scope(root), kind: "directory", relativePaths: ["src/deep"] },
        scope(populate("beta", COLLISION)),
      ],
    });
  await connectPod(active.deps, active.chatId);
  const started = await startUiTestServer({
    staticRoot: directory,
    csp: buildCspHeader([]),
    handlerDeps: active.deps,
  });
  servers.push(started.server);
  return {
    ...active,
    root,
    base: `http://127.0.0.1:${String(started.port)}`,
    provider: upstream.state,
  };
}

function scope(root: string): ChatConnectedScope {
  return { root, kind: "workspace-root", relativePaths: [], connectedAtMs: 1 };
}

async function jsonRequest(
  setup: Fixture,
  path: string,
  method: string,
  body: object,
): Promise<unknown> {
  const response = await fetch(`${setup.base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const result: unknown = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  return result;
}

async function ask(setup: Fixture, content: string): Promise<HybridGroundedAnswer> {
  const chat = setup.deps.store.findChatById(setup.chatId);
  const result = await jsonRequest(setup, "/api/chats/messages/grounded", "POST", {
    chatId: setup.chatId,
    content,
    expectedGroundingScopeIdentity: chat?.groundingScopeIdentity,
  });
  const answer = result as HybridGroundedAnswer;
  expect(answer.groundingKind).toBe("hybrid");
  return answer;
}

async function numericHistory(setup: Fixture): Promise<HybridGroundedAnswer> {
  const first = await ask(setup, `Explain ${TARGET}:61.`);
  expect(first.citations.some((citation) => citation.scopePath === TARGET)).toBe(true);
  setup.provider.reply = "numeric";
  const second = await ask(setup, "Explain that.");
  expect(second.citations.some((citation) => citation.scopePath === TARGET)).toBe(true);
  expect(second.content).not.toContain(TARGET);
  const reopened = createNodeUiStore(setup.dbPath);
  try {
    expect(reopened.listMessages(setup.chatId).at(-1)?.groundedAnswer).toMatchObject({
      citations: second.citations,
    });
  } finally {
    reopened.close();
  }
  return second;
}

function continuityCounts(setup: Fixture): readonly number[] {
  const raw = readPersistedActivityLog(join(directory, "state"));
  const analysis = analyzeLogText(raw);
  expect(analysis.evidence.classification).toBe("supported");
  const sourceCount = setup.deps.store.findChatById(setup.chatId)?.connectedScopes?.length ?? 1;
  const selections = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.op === "search.connected-context.selection-details")
    .slice(-sourceCount);
  expect(raw).not.toContain(AFTER);
  return selections.map((record) => Number(record.continuityReferentCount));
}

function assertFresh(setup: Fixture, answer: HybridGroundedAnswer, referred = true): void {
  expect(setup.provider.evidence.at(-1)).toContain(AFTER);
  expect(answer.content).toContain("83");
  const citation = answer.citations.find((item) => item.scopePath === TARGET);
  expect(citation?.lineRange?.startLine).toBeLessThanOrEqual(61);
  expect(citation?.lineRange?.endLine).toBeGreaterThanOrEqual(61);
  const referentCount = continuityCounts(setup).reduce((total, count) => total + count, 0);
  if (referred) expect(referentCount).toBeGreaterThan(0);
  else expect(referentCount).toBe(0);
}

describe("structured folder citations through native follow-up admission", () => {
  it("uses the persisted numeric folder citation to reread the changed line61 target", async () => {
    const setup = await fixture();
    await numericHistory(setup);
    populate("alpha", AFTER);
    assertFresh(setup, await ask(setup, "Explain that."));
  });

  it("preserves the existing prose path citation healthy twin", async () => {
    const setup = await fixture();
    await ask(setup, `Explain ${TARGET}:61.`);
    populate("alpha", AFTER);
    setup.provider.reply = "numeric";
    assertFresh(setup, await ask(setup, "Explain that."));
  });

  it("preserves independent explicit-target retrieval after a numeric citation", async () => {
    const setup = await fixture();
    await numericHistory(setup);
    populate("alpha", AFTER);
    assertFresh(setup, await ask(setup, `Explain ${TARGET}:61 again.`), false);
  });

  it("binds a numeric folder citation to its prior source among same-path roots", async () => {
    const setup = await fixture(true);
    await numericHistory(setup);
    populate("alpha", AFTER);
    const answer = await ask(setup, "Explain that.");
    assertFresh(setup, answer);
    expect(setup.provider.evidence.at(-1)).not.toContain(COLLISION);
  });

  it("does not rebind a prior citation to a newly selected same-path root", async () => {
    const setup = await fixture();
    const previous = await numericHistory(setup);
    const changed = populate("replacement", AFTER);
    await jsonRequest(setup, `/api/chats?id=${setup.chatId}`, "PATCH", {
      connectedScopes: [scope(changed)],
    });
    const answer = await ask(setup, "Explain that.");
    expect(continuityCounts(setup)).toEqual([0]);
    for (const citation of answer.citations)
      expect(citation.sourceScopeFingerprint).not.toBe(
        previous.citations[0]?.sourceScopeFingerprint,
      );
  });

  it("uses only the latest assistant and does not revive older folder citations", async () => {
    const setup = await fixture();
    await numericHistory(setup);
    setup.provider.reply = "general";
    await ask(setup, "Discuss general engineering tradeoffs.");
    populate("alpha", AFTER);
    await ask(setup, "Explain that.");
    expect(continuityCounts(setup)).toEqual([0]);
  });

  it("does not import the cited target into an independent explicit file question", async () => {
    const setup = await fixture();
    await numericHistory(setup);
    populate("alpha", AFTER);
    await ask(setup, `Explain ${OTHER}:1.`);
    expect(setup.provider.evidence.at(-1)).toContain("invoiceReconciliation");
    expect(setup.provider.evidence.at(-1)).not.toContain(AFTER);
  });

  it("keeps a Pod's numeric document locator separate from folder path hints", async () => {
    const setup = await fixture();
    await ask(setup, `Explain ${TARGET}:61.`);
    setup.provider.reply = "pod";
    const second = await ask(setup, "Explain the Pod reference value.");
    expect(second.citations).toEqual([]);
    expect(second.knowledgeCitations.length).toBeGreaterThan(0);
    populate("alpha", AFTER);
    setup.provider.reply = "numeric";
    await ask(setup, "Explain that.");
    expect(continuityCounts(setup)).toEqual([0]);
  });

  it("retains both source-bound same-path hints after repeated first-source citations", async () => {
    const setup = await fixture(true);
    setup.provider.reply = "both";
    const first = await ask(setup, `Compare ${TARGET}:61 across both connected folders.`);
    expect(first.citations).toHaveLength(2);
    const [alpha, beta] = first.citations;
    if (alpha === undefined || beta === undefined)
      throw new TypeError("Two folder citations required");
    expect(alpha.scopePath).toBe(TARGET);
    expect(beta.scopePath).toBe(TARGET);
    expect(alpha.sourceScopeFingerprint).not.toBe(beta.sourceScopeFingerprint);
    const message = setup.deps.store.listMessages(setup.chatId).at(-1);
    if (message === undefined) throw new TypeError("Persisted assistant required");
    setup.deps.store.attachGroundedAnswer(message.id, {
      ...first,
      citations: [...Array.from({ length: 6 }, () => alpha), beta],
    });
    const second = await ask(setup, "Explain that.");
    expect(continuityCounts(setup)).toEqual([1, 1]);
    expect(setup.provider.evidence.at(-1)).toContain(BEFORE);
    expect(setup.provider.evidence.at(-1)).toContain(COLLISION);
    expect(second.citations).toHaveLength(2);
    expect(new Set(second.citations.map((item) => item.sourceScopeFingerprint)).size).toBe(2);
  });
});
