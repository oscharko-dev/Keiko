import { afterEach, describe, expect, it } from "vitest";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { validateChatToolAuthorityEnvelope } from "@oscharko-dev/keiko-contracts/runtime/chat-tool-authority";
import { createInMemoryUiStore } from "./store/index.js";
import { EditorAgentAuthorityRegistry } from "./editor/agentAuthorityRegistry.js";
import {
  mintAcceptedConnectedFolderChatAuthority,
  reserveCurrentConnectedFolderChatAuthority,
  resolveCurrentConnectedFolderChatAuthority,
  soleConnectedFolderScope,
} from "./connected-folder-chat-authority.js";
import { CONNECTED_FOLDER_CHAT_SOURCE_OWNER } from "./connected-folder-chat-turn.js";
import { CONNECTED_FOLDER_FILES_TOOL } from "./connectedFolderToolName.js";
import { KNOWLEDGE_DOCUMENTS_TOOL } from "./requirementsToolName.js";
import { createKnowledgeChatAdmission } from "./knowledge-chat-consumer.js";
import { mintAcceptedKnowledgeChatAuthority } from "./knowledge-chat-authority.js";
import type { LocalChatSourceAuthorityDeps } from "./local-chat-source-authority.js";
import { createLocalChatSourceAdmission } from "./local-chat-source-consumer.js";
import { localChatSourceTurnContext } from "./local-chat-source-turn.js";

const stores: ReturnType<typeof createInMemoryUiStore>[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const CORRELATION = "folder-authority-proof";
const ROOT = "/connected/folder";
const POD = "knowledge-pod" as KnowledgeCapsuleId;
const FOLDER = { kind: "workspace-root", root: ROOT, relativePaths: [], connectedAtMs: 1 } as const;
type Store = ReturnType<typeof createInMemoryUiStore>;
type ChatPatch = Parameters<Store["updateChat"]>[1];

interface Fixture {
  readonly deps: LocalChatSourceAuthorityDeps;
  readonly store: Store;
  readonly chatId: string;
  readonly now: number;
  readonly turn: Parameters<typeof mintAcceptedConnectedFolderChatAuthority>[1];
  readonly message: NonNullable<ReturnType<Store["findMessageById"]>>;
  readonly changeActor: () => void;
}

function fixture(patch: ChatPatch = { connectedScopes: [FOLDER] }): Fixture {
  const store = createInMemoryUiStore();
  stores.push(store);
  const project = store.createProject(process.cwd());
  const chat = store.updateChat(store.createChat(project.path, "Folder", "synthetic").id, {
    toolMode: "governed-assist",
    ...patch,
  });
  const now = Date.now();
  const admitted = store.admitChatTurn("folder-human-turn", {
    chatId: chat.id,
    role: "user",
    content: "What is in my folder?",
    timestamp: now,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  if (admitted.kind !== "admitted") throw new Error("Expected admitted turn");
  let principal = "synthetic-local-operator";
  return {
    store,
    chatId: chat.id,
    now,
    message: admitted.userMessage,
    deps: {
      store,
      serverPrincipal: () => principal,
      agentAuthorityRegistry: new EditorAgentAuthorityRegistry(),
      autonomousDeliveryDeploymentCeiling: "autonomous-delivery",
      chatToolTurnBudget: { maxToolCalls: 2, maxRuntimeMs: 60_000, maxPatchBytes: 0 },
    },
    turn: {
      chatId: chat.id,
      userMessageId: admitted.userMessage.id,
      startedAtMs: now,
      nowMs: now,
      correlationId: CORRELATION,
    },
    changeActor: (): void => {
      principal = "other-local-operator";
    },
  };
}

function minted(
  f: Fixture,
): Extract<ReturnType<typeof mintAcceptedConnectedFolderChatAuthority>, { ok: true }> {
  const accepted = mintAcceptedConnectedFolderChatAuthority(f.deps, f.turn);
  if (!accepted.ok) throw new Error("Expected connected-folder authority");
  return accepted;
}

function current(f: Fixture, accepted: ReturnType<typeof minted>, chatId = f.chatId): boolean {
  return resolveCurrentConnectedFolderChatAuthority(
    f.deps,
    chatId,
    accepted.reference,
    new Date(f.now).toISOString(),
    CORRELATION,
  ).ok;
}

describe("the one connected folder of a Chat", () => {
  it.each([
    ["one folder", { connectedScopes: [FOLDER] }, true],
    [
      "one selection of files",
      { connectedScopes: [{ ...FOLDER, kind: "files", relativePaths: ["a.md"] }] },
      true,
    ],
    ["no folder", {}, false],
    ["two folders", { connectedScopes: [FOLDER, { ...FOLDER, root: "/other" }] }, false],
    [
      "a folder and a Knowledge Pod",
      {
        connectedScopes: [FOLDER],
        localKnowledgeScope: { kind: "capsule", capsuleId: POD, connectedAtMs: 1 },
      },
      false,
    ],
  ] satisfies [string, ChatPatch, boolean][])("%s", (_name, patch, eligible) => {
    const f = fixture(patch);
    const chat = f.store.findChatById(f.chatId);
    expect(soleConnectedFolderScope(chat) !== undefined).toBe(eligible);
    expect(mintAcceptedConnectedFolderChatAuthority(f.deps, f.turn).ok).toBe(eligible);
  });

  it("is absent for a Chat bound to a Jira Pod or a Git change, and for no Chat", () => {
    const f = fixture();
    const chat = f.store.findChatById(f.chatId);
    if (chat === undefined) throw new Error("Expected the Chat.");
    expect(soleConnectedFolderScope(chat)).toMatchObject({ root: ROOT });
    expect(
      soleConnectedFolderScope({
        ...chat,
        jiraPodBinding: {
          podId: "d5f5681e-ce98-4c3c-b27e-51d707c9d018",
          authenticationGeneration: 1,
          bindingGeneration: 1,
          connectedAtMs: 1,
        },
      }),
    ).toBeUndefined();
    expect(
      soleConnectedFolderScope({
        ...chat,
        gitChangeScopes: [{} as NonNullable<(typeof chat)["gitChangeScopes"]>[number]],
      }),
    ).toBeUndefined();
    expect(soleConnectedFolderScope(undefined)).toBeUndefined();
  });
});

describe("connected-folder Chat authority", () => {
  it("binds an accepted turn to the folder scope: local, read-only, no network egress", () => {
    const f = fixture();
    const { envelope } = minted(f);
    expect(envelope.subject).toMatchObject({ kind: "connected-folder", chatId: f.chatId });
    expect(envelope.subject.configurationDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(envelope.subject).not.toHaveProperty("podId");
    expect(envelope.connectorScopes).toEqual(["folder.read"]);
    expect(envelope.actionClasses).toEqual(["connector-access"]);
    expect(envelope.budget.maxPatchBytes).toBe(0);
    expect(validateChatToolAuthorityEnvelope(envelope)).toEqual({ ok: true, value: envelope });
  });

  it.each([
    ["another root", { connectedScopes: [{ ...FOLDER, root: "/connected/other" }] }],
    [
      "narrowed paths",
      { connectedScopes: [{ ...FOLDER, kind: "directory", relativePaths: ["docs"] }] },
    ],
    ["a second folder", { connectedScopes: [FOLDER, { ...FOLDER, root: "/connected/other" }] }],
    ["no folder", { connectedScopes: null }],
    [
      "an added Knowledge Pod",
      { localKnowledgeScope: { kind: "capsule", capsuleId: POD, connectedAtMs: 1 } },
    ],
    ["an added MCP server", { mcpServers: ["synthetic-server"] }],
  ] satisfies [string, ChatPatch][])(
    "ends when the Chat's scope changes mid-turn to %s",
    (_name, patch) => {
      const f = fixture();
      const accepted = minted(f);
      expect(current(f, accepted)).toBe(true);
      f.store.updateChat(f.chatId, patch);
      expect(current(f, accepted)).toBe(false);
      expect(
        reserveCurrentConnectedFolderChatAuthority(
          f.deps,
          f.chatId,
          accepted.reference,
          { toolCalls: 1, patchBytes: 0 },
          new Date(f.now).toISOString(),
          CORRELATION,
        ).ok,
      ).toBe(false);
    },
  );

  it("is the same authority again only for the identical scope", () => {
    const f = fixture();
    const accepted = minted(f);
    f.store.updateChat(f.chatId, { connectedScopes: [{ ...FOLDER, root: "/connected/other" }] });
    expect(current(f, accepted)).toBe(false);
    f.store.updateChat(f.chatId, { connectedScopes: [FOLDER] });
    expect(current(f, accepted)).toBe(true);
  });

  // One fixture per case: a refused resolution may revoke the authority, which would make every
  // later refusal of the same fixture pass for the wrong reason.
  it.each([
    [
      "a changed actor",
      (f: Fixture): void => {
        f.changeActor();
      },
    ],
    [
      "a changed mode",
      (f: Fixture): void => void f.store.updateChat(f.chatId, { toolMode: "autonomous-delivery" }),
    ],
    [
      "a closed Chat",
      (f: Fixture): void => void f.store.updateChat(f.chatId, { status: "closed" }),
    ],
  ] satisfies [string, (f: Fixture) => void][])("refuses %s", (_name, change) => {
    const f = fixture();
    const accepted = minted(f);
    expect(current(f, accepted)).toBe(true);
    change(f);
    expect(current(f, accepted)).toBe(false);
  });

  it("refuses another Chat that is connected to the same folder", () => {
    const f = fixture();
    const accepted = minted(f);
    const other = f.store.updateChat(f.store.createChat(process.cwd(), "Other", "synthetic").id, {
      connectedScopes: [FOLDER],
    });
    expect(soleConnectedFolderScope(other)).toMatchObject({ root: ROOT });
    expect(current(f, accepted, other.id)).toBe(false);
  });

  it("refuses a turn that is not the accepted one and stays within the turn budget", () => {
    const f = fixture();
    expect(
      mintAcceptedConnectedFolderChatAuthority(f.deps, { ...f.turn, userMessageId: "unaccepted" })
        .ok,
    ).toBe(false);
    const accepted = minted(f);
    const reserve = (): boolean =>
      reserveCurrentConnectedFolderChatAuthority(
        f.deps,
        f.chatId,
        accepted.reference,
        { toolCalls: 1, patchBytes: 0 },
        new Date(f.now).toISOString(),
        CORRELATION,
      ).ok;
    expect([reserve(), reserve(), reserve()]).toEqual([true, true, false]);
  });
});

describe("connected-folder catalog admission", () => {
  function action(
    tool: string,
  ): Parameters<ReturnType<typeof createKnowledgeChatAdmission>["authorityPort"]["preview"]>[1] {
    return {
      tool,
      actionId: "action-1",
      idempotencyKey: "action-1",
      argumentsDigest: "0".repeat(64),
    } as Parameters<ReturnType<typeof createKnowledgeChatAdmission>["authorityPort"]["preview"]>[1];
  }

  it("admits only the folder read under the folder authority, without an approval port", () => {
    const f = fixture();
    const accepted = minted(f);
    const context = localChatSourceTurnContext({
      deps: f.deps as Parameters<typeof localChatSourceTurnContext>[0]["deps"],
      message: f.message,
      authority: accepted,
      managed: {} as Parameters<typeof localChatSourceTurnContext>[0]["managed"],
      signal: new AbortController().signal,
      correlationId: CORRELATION,
    });
    const admission = createLocalChatSourceAdmission(
      { deps: f.deps, context: () => context, now: () => f.now },
      CONNECTED_FOLDER_CHAT_SOURCE_OWNER,
    );
    const capability = accepted.reference.envelopeDigest;
    expect(
      admission.authorityPort.preview(capability, action(CONNECTED_FOLDER_FILES_TOOL)).ok,
    ).toBe(true);
    expect(admission.authorityPort.preview(capability, action(KNOWLEDGE_DOCUMENTS_TOOL)).ok).toBe(
      false,
    );
    expect(admission.authorityPort.preview("foreign", action(CONNECTED_FOLDER_FILES_TOOL)).ok).toBe(
      false,
    );
    expect(admission.approvalPort.available(action(CONNECTED_FOLDER_FILES_TOOL), context)).toBe(
      false,
    );
    const admitted = admission.authorityPort.admit(capability, action(CONNECTED_FOLDER_FILES_TOOL));
    if (!admitted.ok) throw new Error("Expected the folder read to be admitted.");
    expect(admitted.mutationGuard.check()).toBe(true);
    f.store.updateChat(f.chatId, { connectedScopes: [{ ...FOLDER, root: "/connected/other" }] });
    // The guard of a running call sees the changed scope at its effect boundary.
    expect(admitted.mutationGuard.check()).toBe(false);
    expect(
      admission.authorityPort.preview(capability, action(CONNECTED_FOLDER_FILES_TOOL)).ok,
    ).toBe(false);
  });

  it("is not admitted by the Knowledge authority of a Chat with Pods", () => {
    const f = fixture({
      localKnowledgeScope: { kind: "capsule", capsuleId: POD, connectedAtMs: 1 },
    });
    const accepted = mintAcceptedKnowledgeChatAuthority(f.deps, f.turn);
    if (!accepted.ok) throw new Error("Expected Knowledge authority");
    const context = localChatSourceTurnContext({
      deps: f.deps as Parameters<typeof localChatSourceTurnContext>[0]["deps"],
      message: f.message,
      authority: accepted,
      managed: {} as Parameters<typeof localChatSourceTurnContext>[0]["managed"],
      signal: new AbortController().signal,
      correlationId: CORRELATION,
    });
    const admission = createKnowledgeChatAdmission({
      deps: f.deps,
      context: () => context,
      now: () => f.now,
    });
    const capability = accepted.reference.envelopeDigest;
    expect(admission.authorityPort.preview(capability, action(KNOWLEDGE_DOCUMENTS_TOOL)).ok).toBe(
      true,
    );
    expect(
      admission.authorityPort.preview(capability, action(CONNECTED_FOLDER_FILES_TOOL)).ok,
    ).toBe(false);
  });
});
