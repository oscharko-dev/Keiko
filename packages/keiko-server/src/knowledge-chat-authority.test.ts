import { afterEach, describe, expect, it } from "vitest";
import type { CodingWorkbenchMode, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { createInMemoryUiStore } from "./store/index.js";
import { EditorAgentAuthorityRegistry } from "./editor/agentAuthorityRegistry.js";
import {
  mintAcceptedKnowledgeChatAuthority,
  resolveCurrentKnowledgeChatAuthority,
  reserveCurrentKnowledgeChatAuthority,
  type KnowledgeChatAuthorityDeps,
} from "./knowledge-chat-authority.js";
import { createKnowledgeChatAdmission } from "./knowledge-chat-consumer.js";
import { knowledgeChatTurnContext } from "./knowledge-chat-turn.js";

const stores: ReturnType<typeof createInMemoryUiStore>[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const POD = "knowledge-pod" as KnowledgeCapsuleId;
const CORRELATION = "knowledge-authority-proof";
interface Fixture {
  readonly deps: KnowledgeChatAuthorityDeps;
  readonly chat: ReturnType<KnowledgeChatAuthorityDeps["store"]["createChat"]>;
  readonly message: NonNullable<ReturnType<KnowledgeChatAuthorityDeps["store"]["findMessageById"]>>;
  readonly now: number;
  readonly turn: Parameters<typeof mintAcceptedKnowledgeChatAuthority>[1];
  readonly accepted: Extract<ReturnType<typeof mintAcceptedKnowledgeChatAuthority>, { ok: true }>;
  readonly resolve: (
    at?: number,
    currentDeps?: KnowledgeChatAuthorityDeps,
    chatId?: string,
  ) => ReturnType<typeof resolveCurrentKnowledgeChatAuthority>;
  readonly changeActor: () => void;
}
function fixture(): Fixture {
  const store = createInMemoryUiStore();
  stores.push(store);
  const project = store.createProject(process.cwd());
  const created = store.createChat(project.path, "Knowledge", "synthetic");
  const chat = store.updateChat(created.id, {
    localKnowledgeScope: { kind: "capsule", capsuleId: POD, connectedAtMs: 1 },
    toolMode: "governed-assist",
  });
  const now = Date.now();
  const admitted = store.admitChatTurn("knowledge-human-turn", {
    chatId: chat.id,
    role: "user",
    content: "Read my documents",
    timestamp: now,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  if (admitted.kind !== "admitted") throw new Error("Expected admitted turn");
  let principal = "synthetic-local-operator";
  const deps: KnowledgeChatAuthorityDeps = {
    store,
    serverPrincipal: () => principal,
    agentAuthorityRegistry: new EditorAgentAuthorityRegistry(),
    autonomousDeliveryDeploymentCeiling: "autonomous-delivery",
    chatToolTurnBudget: {
      maxToolCalls: 2,
      maxRuntimeMs: 60_000,
      maxPromptTokens: 1000,
      maxPatchBytes: 0,
    },
  };
  const turn = {
    chatId: chat.id,
    userMessageId: admitted.userMessage.id,
    startedAtMs: now,
    nowMs: now,
    correlationId: CORRELATION,
  };
  const accepted = mintAcceptedKnowledgeChatAuthority(deps, turn);
  if (!accepted.ok) throw new Error("Expected Knowledge authority");
  const resolve = (
    at = now,
    currentDeps = deps,
    chatId = chat.id,
  ): ReturnType<typeof resolveCurrentKnowledgeChatAuthority> =>
    resolveCurrentKnowledgeChatAuthority(
      currentDeps,
      chatId,
      accepted.reference,
      new Date(at).toISOString(),
      CORRELATION,
    );
  return {
    deps,
    chat,
    now,
    turn,
    message: admitted.userMessage,
    accepted,
    resolve,
    changeActor: (): void => {
      principal = "other-local-operator";
    },
  };
}
describe("Knowledge-only Chat authority", () => {
  it("binds an accepted Chat turn to its Knowledge selection without Jira or configured MCP", () => {
    const f = fixture();
    expect(f.accepted.envelope.subject).toMatchObject({
      kind: "knowledge-pods",
      chatId: f.chat.id,
    });
    expect(f.accepted.envelope.subject).not.toHaveProperty("podId");
    expect(f.accepted.envelope.connectorScopes).toEqual(["knowledge.read"]);
    expect(f.resolve().ok).toBe(true);
  });
  it("refuses a changed selection, actor, closed Chat and different Chat", () => {
    const f = fixture();
    const other = f.deps.store.createChat(process.cwd(), "Other", "synthetic");
    expect(f.resolve(f.now, f.deps, other.id).ok).toBe(false);
    f.deps.store.updateChat(f.chat.id, {
      localKnowledgeScope: {
        kind: "capsule",
        capsuleId: "different-pod" as KnowledgeCapsuleId,
        connectedAtMs: 1,
      },
    });
    expect(f.resolve().ok).toBe(false);
    f.deps.store.updateChat(f.chat.id, {
      localKnowledgeScope: { kind: "capsule", capsuleId: POD, connectedAtMs: 1 },
    });
    f.changeActor();
    expect(f.resolve().ok).toBe(false);
    const closed = fixture();
    closed.deps.store.updateChat(closed.chat.id, { status: "closed" });
    expect(closed.resolve().ok).toBe(false);
  });
  it.each(["supervised-coding", "autonomous-delivery"] as const)(
    "refuses a mid-turn mode change to %s",
    (toolMode: CodingWorkbenchMode) => {
      const f = fixture();
      f.deps.store.updateChat(f.chat.id, { toolMode });
      expect(f.resolve().ok).toBe(false);
    },
  );
  it("refuses expired authority and changed deployment ceiling", () => {
    const f = fixture();
    expect(f.resolve(f.now + 60_000).ok).toBe(false);
    expect(
      f.resolve(f.now, { ...f.deps, autonomousDeliveryDeploymentCeiling: "governed-assist" }).ok,
    ).toBe(false);
  });
  it("reserves one cumulative call/token budget and refuses fabricated acceptance", () => {
    const f = fixture();
    expect(
      mintAcceptedKnowledgeChatAuthority(f.deps, { ...f.turn, userMessageId: "unaccepted" }).ok,
    ).toBe(false);
    const reserve = (
      toolCalls: number,
      promptTokens = 0,
    ): ReturnType<typeof reserveCurrentKnowledgeChatAuthority> =>
      reserveCurrentKnowledgeChatAuthority(
        f.deps,
        f.chat.id,
        f.accepted.reference,
        { toolCalls, promptTokens, patchBytes: 0 },
        new Date(f.now).toISOString(),
        CORRELATION,
      );
    expect(reserve(1, 900).ok).toBe(true);
    expect(reserve(1, 100).ok).toBe(true);
    expect(reserve(1).ok).toBe(false);
    expect(reserve(0, 1).ok).toBe(false);
  });
  it("denies every modifying or external tool and rechecks cancellation before effects", () => {
    const f = fixture();
    const signal = new AbortController();
    const context = knowledgeChatTurnContext({
      deps: f.deps as Parameters<typeof knowledgeChatTurnContext>[0]["deps"],
      message: f.message,
      authority: f.accepted,
      managed: {} as Parameters<typeof knowledgeChatTurnContext>[0]["managed"],
      signal: signal.signal,
      correlationId: CORRELATION,
    });
    const admission = createKnowledgeChatAdmission({
      deps: f.deps,
      context: () => context,
      now: () => f.now,
    });
    const identity = {
      actionId: "knowledge-read-1",
      idempotencyKey: "knowledge-read-1",
      argumentsDigest: "a".repeat(64),
    };
    expect(
      admission.authorityPort.preview(context.authority, { ...identity, tool: "jira.create" }).ok,
    ).toBe(false);
    const read = admission.authorityPort.admit(context.authority, {
      ...identity,
      tool: "knowledge.requirements",
    });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("Expected read admission");
    expect(read.mutationGuard.check()).toBe(true);
    signal.abort();
    expect(read.mutationGuard.check()).toBe(false);
  });
});
