import {
  AtlassianActionApprovalRegistry,
  ATLASSIAN_ACTION_APPROVAL_TTL_MS,
  ATLASSIAN_ACTION_APPROVAL_MAX_PENDING,
} from "./actionApprovals.js";
import type { JiraLivePodMetadata } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { randomUUID } from "node:crypto";
import { createHarnessCatalogBudget, DEFAULT_LIMITS } from "@oscharko-dev/keiko-harness";
import type { ChatToolReadGrantView, RunCounters } from "@oscharko-dev/keiko-contracts";
import type { CatalogHandlerContext } from "../tool-catalog/catalogToolPorts.js";
import { createManagedProviderCatalog } from "../tool-catalog/managedProviderCatalog.js";
import { createCatalogToolBinder } from "../tool-catalog/catalogToolDispatch.js";
import { createCodingToolInvocationRegistry } from "../coding-runtime/codingToolInvocationRegistry.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";
import { JIRA_MANAGED_READ_TOOLS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { UiHandlerDeps } from "../deps.js";
import { KNOWLEDGE_CHAT_TOOLS } from "../requirementsToolName.js";
import { createKnowledgeRequirementsProvider } from "../requirementsTool.js";
import {
  createJiraChatCatalogAdmission,
  jiraChatCatalogConsumerPort,
  jiraChatCatalogRoutes,
  jiraChatReadCatalogRoutes,
  type JiraChatCatalogConsumer,
  type JiraChatCatalogContext,
} from "./jiraChatCatalogConsumer.js";
import {
  createFileServerLogSink,
  createServerLogger,
  setServerLogger,
} from "../observability/index.js";
import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import {
  expectActivityLogProof,
  readPersistedActivityLog,
  persistedActivityLogLines,
} from "../../../../tests/support/activity-log-proof.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AtlassianCredentialMetadata,
  AtlassianConnectorActionType,
  CodingWorkbenchMode,
  EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import { createInMemoryUiStore, type Chat, type UiStore } from "../store/index.js";
import { EditorAgentAuthorityRegistry } from "../editor/agentAuthorityRegistry.js";
import {
  chatAuthorityFixture,
  CHAT_AUTHORITY_TEST_NOW,
} from "../editor/chatAuthority.test-support.js";
import {
  isCurrentJiraChatWriteApproval,
  requestJiraChatWriteApproval,
} from "./jiraChatWriteApproval.js";
import { jiraChatActorDigest } from "./jiraPodAccess.js";
import {
  requestJiraChatReadGrant,
  mintAcceptedJiraChatAuthority,
  resolveCurrentJiraChatAuthority,
  decideGovernedJiraChatAction,
  reserveCurrentJiraChatAuthority,
  type JiraChatAuthorityDeps,
  type JiraChatAuthorityEnvelope as ChatToolAuthorityEnvelope,
} from "./jiraChatAuthority.js";

const POD = "d5f5681e-ce98-4c3c-b27e-51d707c9d018";
let store: UiStore;
let project: string;
let chat: Chat;
let metadata: AtlassianCredentialMetadata[];
let actor: string;
let deps: JiraChatAuthorityDeps;
let reference: EditorAgentGovernedAuthorityReference;

beforeEach(() => {
  project = mkdtempSync(join(realpathSync(tmpdir()), "keiko-jira-authority-"));
  store = createInMemoryUiStore();
  store.createProject(project);
  actor = "synthetic-local-operator";
  const serverPrincipal = (): string => actor;
  const actorDigest = jiraChatActorDigest({ serverPrincipal });
  if (actorDigest === undefined) throw new Error("Expected actor digest");
  const created = store.createChat(project, "Jira", "model");
  chat = store.updateChat(
    created.id,
    { jiraPodId: POD },
    { verifiedJiraPod: { podId: POD, authenticationGeneration: 1 } },
  );
  metadata = [
    {
      schemaVersion: "1",
      authRef: "private-credential-reference",
      displayName: "Synthetic Jira",
      baseUrl: "https://jira.example.invalid",
      createdAt: 1,
      generation: 1,
      provider: "jira",
      deployment: "data-center",
      authScheme: "bearer-pat",
      livePod: {
        podId: POD,
        ownerDigest: actorDigest,
        creationRequestId: "d5f5681e-ce98-4c3c-b27e-51d707c9d019",
        verificationRevision: 1,
        verificationInProgress: false,
        verificationStatus: "ok",
      },
    },
  ];
  const registry = new EditorAgentAuthorityRegistry();
  deps = {
    store,
    serverPrincipal,
    agentAuthorityRegistry: registry,
    autonomousDeliveryDeploymentCeiling: "autonomous-delivery",
    atlassianConnectorCredentials: {
      custody: { list: (): readonly AtlassianCredentialMetadata[] => metadata },
    },
  };
  const value = chatAuthorityFixture({
    requestedMode: "governed-assist",
    subject: {
      actorDigest,
      chatId: chat.id,
      podId: POD,
      bindingGeneration: 1,
      authenticationGeneration: 1,
    },
  });
  const registration = registry.registerChat(value, "autonomous-delivery", CHAT_AUTHORITY_TEST_NOW);
  if (!registration.ok) throw new Error("Expected authority");
  reference = registration.authorityRef;
});

afterEach(() => {
  store.close();
  rmSync(project, { recursive: true, force: true });
});

function resolve(): ReturnType<typeof resolveCurrentJiraChatAuthority> {
  return resolveCurrentJiraChatAuthority(
    deps,
    chat.id,
    reference,
    CHAT_AUTHORITY_TEST_NOW,
    "fresh-state-proof",
  );
}

function updatePod(patch: Partial<JiraLivePodMetadata>): void {
  const credential = metadata[0];
  if (credential?.deployment !== "data-center" || credential.livePod === undefined)
    throw new Error("Expected Jira metadata");
  metadata = [{ ...credential, livePod: { ...credential.livePod, ...patch } }];
}

describe("accepted ordinary Chat turn authority", () => {
  function acceptedMessage(role: "user" | "assistant" = "user"): string {
    return store.createMessage({
      chatId: chat.id,
      role,
      content: "Synthetic accepted task",
      timestamp: Date.parse(CHAT_AUTHORITY_TEST_NOW),
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    }).id;
  }

  function mint(userMessageId: string): ReturnType<typeof mintAcceptedJiraChatAuthority> {
    return mintAcceptedJiraChatAuthority(deps, {
      chatId: chat.id,
      userMessageId,
      startedAtMs: Date.parse(CHAT_AUTHORITY_TEST_NOW),
      nowMs: Date.parse(CHAT_AUTHORITY_TEST_NOW),
      correlationId: "accepted-chat-authority",
    });
  }

  it("mints from the stored human turn and current binding with one exact deadline", () => {
    const result = mint(acceptedMessage());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected accepted authority");
    expect(
      resolveCurrentJiraChatAuthority(
        deps,
        chat.id,
        result.reference,
        CHAT_AUTHORITY_TEST_NOW,
        "accepted-chat-authority",
      ),
    ).toMatchObject({ ok: true, envelope: result.envelope });
    expect(result.envelope.requestedMode).toBe("governed-assist");
    expect(Date.parse(result.envelope.expiresAt)).toBe(
      Date.parse(CHAT_AUTHORITY_TEST_NOW) + result.envelope.budget.maxRuntimeMs,
    );
    expect(JSON.stringify(result)).not.toMatch(
      /Synthetic accepted task|private-credential-reference/,
    );
  });

  it("reuses one canonical admission and cumulative budget on duplicate minting", async () => {
    const admitted = store.admitChatTurn("accepted-canonical-turn", {
      chatId: chat.id,
      role: "user",
      content: "Accepted canonical task",
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
      timestamp: Date.parse(CHAT_AUTHORITY_TEST_NOW),
    });
    if (admitted.kind !== "admitted") throw new Error("Expected fresh admission");
    const first = mint(admitted.userMessage.id);
    if (!first.ok) throw new Error("Expected authority");
    const registry = deps.agentAuthorityRegistry;
    if (registry === undefined) throw new Error("Missing registry");
    expect(
      registry.reserveForChat(
        first.reference,
        first.envelope.subject,
        "autonomous-delivery",
        { toolCalls: first.envelope.budget.maxToolCalls, promptTokens: 0, patchBytes: 0 },
        CHAT_AUTHORITY_TEST_NOW,
      ).ok,
    ).toBe(true);
    const duplicates = await Promise.all([
      Promise.resolve().then(() => mint(admitted.userMessage.id)),
      Promise.resolve().then(() => mint(admitted.userMessage.id)),
    ]);
    expect(duplicates).toEqual([first, first]);
    expect(
      registry.reserveForChat(
        first.reference,
        first.envelope.subject,
        "autonomous-delivery",
        { toolCalls: 1, promptTokens: 0, patchBytes: 0 },
        CHAT_AUTHORITY_TEST_NOW,
      ),
    ).toEqual({ ok: false, reason: "budget-exceeded" });
  });

  it("does not replace the same turn budget after a mode change or revocation", () => {
    const id = acceptedMessage();
    const first = mint(id);
    if (!first.ok) throw new Error("Expected authority");
    deps.agentAuthorityRegistry?.revoke(first.reference);
    expect(mint(id)).toEqual({ ok: false, reason: "revoked" });
    store.updateChat(chat.id, { toolMode: "autonomous-delivery" });
    expect(mint(id)).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses replay with a caller-renewed clock or a superseded human message", () => {
    const id = acceptedMessage();
    expect(
      mintAcceptedJiraChatAuthority(deps, {
        chatId: chat.id,
        userMessageId: id,
        startedAtMs: Date.parse(CHAT_AUTHORITY_TEST_NOW) + 1,
        nowMs: Date.parse(CHAT_AUTHORITY_TEST_NOW) + 1,
        correlationId: "renewed-clock",
      }).ok,
    ).toBe(false);
    acceptedMessage();
    expect(mint(id).ok).toBe(false);
  });

  it("refuses missing/nonhuman turns, missing binding and unverified credentials", () => {
    expect(mint("missing").ok).toBe(false);
    expect(mint(acceptedMessage("assistant")).ok).toBe(false);
    const message = acceptedMessage();
    updatePod({ verificationStatus: "unverified" });
    expect(mint(message).ok).toBe(false);
    updatePod({ verificationStatus: "ok" });
    store.updateChat(chat.id, { jiraPodId: null });
    expect(mint(message).ok).toBe(false);
  });

  it("reuses accepted consent across separately admitted human turns without replacing the issuer", () => {
    const first = mint(acceptedMessage());
    if (!first.ok) throw new Error("Expected accepted authority");
    const grants = new AtlassianActionApprovalRegistry(() => Date.parse(CHAT_AUTHORITY_TEST_NOW));
    const owners = { ...deps, atlassianActionApprovalRegistry: grants };
    const pending = requestJiraChatReadGrant(
      owners,
      chat.id,
      first.reference,
      CHAT_AUTHORITY_TEST_NOW,
      "first-human-turn",
    );
    if (pending.kind !== "review-required") throw new Error("Expected read consent");
    expect(
      grants.acceptChatReadGrant(
        pending.grant.grantId,
        first.envelope.subject,
        first.reference,
        "b".repeat(64),
      ).ok,
    ).toBe(true);
    const second = mint(acceptedMessage());
    if (!second.ok) throw new Error("Expected second accepted authority");
    expect(second.reference).not.toEqual(first.reference);
    expect(
      requestJiraChatReadGrant(
        owners,
        chat.id,
        second.reference,
        CHAT_AUTHORITY_TEST_NOW,
        "second-human-turn",
      ),
    ).toEqual({
      kind: "granted",
      grant: {
        ...pending.grant,
        state: "granted",
      },
    });
    expect(grants.getChatReadGrant(pending.grant.grantId)?.authority).toEqual(first.reference);
  });

  it.each([Number.NaN, -1, Number.MAX_SAFE_INTEGER])(
    "rejects invalid accepted time %s",
    (startedAtMs) => {
      expect(
        mintAcceptedJiraChatAuthority(deps, {
          chatId: chat.id,
          userMessageId: acceptedMessage(),
          startedAtMs,
          nowMs: Date.parse(CHAT_AUTHORITY_TEST_NOW),
          correlationId: "invalid-acceptance-time",
        }).ok,
      ).toBe(false);
    },
  );
});

describe("current ordinary Chat Jira authority facts", () => {
  it("resolves private metadata only from the current owned and verified binding", () => {
    expect(resolve()).toMatchObject({
      ok: true,
      credential: { authRef: "private-credential-reference" },
      envelope: { subject: { chatId: chat.id } },
    });
  });

  it("rereads binding generations rather than accepting a retained snapshot", () => {
    expect(resolve().ok).toBe(true);
    store.updateChat(chat.id, { toolMode: "autonomous-delivery" });
    expect(resolve().ok).toBe(false);
  });

  it.each(["disconnect", "close", "delete"] as const)(
    "denies after a direct store %s",
    (operation) => {
      if (operation === "disconnect") store.updateChat(chat.id, { jiraPodId: null });
      if (operation === "close") store.updateChat(chat.id, { status: "closed" });
      if (operation === "delete") store.deleteChat(chat.id);
      expect(resolve().ok).toBe(false);
    },
  );

  it.each([
    { verificationStatus: "auth-failed" },
    { verificationStatus: "unverified" },
    { verificationInProgress: true },
    { credentialOperation: "replace-token" },
    { credentialOperation: "delete" },
    { ownerDigest: "e".repeat(64) },
  ] as const)("rereads verification, custody work and ownership %j", (patch) => {
    expect(resolve().ok).toBe(true);
    updatePod(patch);
    expect(resolve().ok).toBe(false);
  });

  it("refuses a removed credential, replacement generation or changed actor", () => {
    const original = metadata;
    metadata = [];
    expect(resolve().ok).toBe(false);
    metadata = original.map((entry) => ({ ...entry, generation: 2 }));
    expect(resolve().ok).toBe(false);
    metadata = original;
    actor = "another-operator";
    expect(resolve().ok).toBe(false);
    actor = "";
    expect(resolve().ok).toBe(false);
  });

  it("fails closed without a graph registry", () => {
    deps = { ...deps, agentAuthorityRegistry: undefined };
    expect(resolve().ok).toBe(false);
  });

  it("revalidates the current deployment ceiling", () => {
    deps = { ...deps, autonomousDeliveryDeploymentCeiling: "governed-assist" };
    expect(resolve().ok).toBe(false);
  });
});

it("records closed current-state reasons through the real Activity Log without private metadata", () => {
  const sink = createFileServerLogSink(project, { level: "debug" });
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  try {
    expect(resolve().ok).toBe(true);
    updatePod({ verificationInProgress: true });
    expect(resolve().ok).toBe(false);
    updatePod({ verificationInProgress: false });
    store.updateChat(chat.id, { toolMode: "autonomous-delivery" });
    expect(resolve().ok).toBe(false);
    store.updateChat(chat.id, { jiraPodId: null });
    expect(resolve().ok).toBe(false);
    sink.close?.();
    const lines = persistedActivityLogLines(
      readPersistedActivityLog(project),
      "chat.tool-authority.operation",
    );
    const records = lines.map((line) =>
      expectActivityLogProof("chat.tool-authority.operation.current-state", line),
    );
    const current = records.filter((entry) => entry.phase === "current-state");
    expect(current.map((entry) => entry.readiness)).toEqual([
      "ready",
      "verification-required",
      "authority-denied",
      "not-bound",
    ]);
    expect(current.every((entry) => entry.correlationId === "fresh-state-proof")).toBe(true);
    for (const privateValue of [
      chat.id,
      POD,
      "private-credential-reference",
      "https://jira.example.invalid",
      actor,
    ])
      expect(lines.join("\n")).not.toContain(privateValue);
  } finally {
    sink.close?.();
    resetServerLogger();
  }
});

function registerCurrentAuthority(overrides: Partial<ChatToolAuthorityEnvelope> = {}): void {
  const current = store.findChatById(chat.id);
  const binding = current?.jiraPodBinding;
  const actorDigest = jiraChatActorDigest(deps);
  if (current === undefined || binding === undefined || actorDigest === undefined)
    throw new Error("Expected current Chat authority facts");
  const value = chatAuthorityFixture({
    runId: "policy-run",
    requestedMode: current.toolMode ?? "governed-assist",
    subject: {
      actorDigest,
      chatId: chat.id,
      podId: binding.podId,
      bindingGeneration: binding.bindingGeneration,
      authenticationGeneration: binding.authenticationGeneration,
    },
    ...overrides,
  });
  const result = deps.agentAuthorityRegistry?.registerChat(
    value,
    "autonomous-delivery",
    CHAT_AUTHORITY_TEST_NOW,
    "chat-policy-proof",
  );
  if (result?.ok !== true) throw new Error("Expected current authority registration");
  reference = result.authorityRef;
}

function decide(
  action: AtlassianConnectorActionType,
): ReturnType<typeof decideGovernedJiraChatAction> {
  return decideGovernedJiraChatAction(
    action,
    deps,
    chat.id,
    reference,
    CHAT_AUTHORITY_TEST_NOW,
    "chat-policy-proof",
  );
}

function reserve(
  toolCalls = 1,
  promptTokens = 0,
): ReturnType<typeof reserveCurrentJiraChatAuthority> {
  return reserveCurrentJiraChatAuthority(
    deps,
    chat.id,
    reference,
    { toolCalls, promptTokens, patchBytes: 0 },
    CHAT_AUTHORITY_TEST_NOW,
    "chat-policy-proof",
  );
}

describe("ordinary Chat composes the existing Atlassian policy", () => {
  it.each<CodingWorkbenchMode>(["governed-assist", "supervised-coding", "autonomous-delivery"])(
    "applies %s without a Coding session",
    (mode) => {
      store.updateChat(chat.id, { toolMode: mode });
      registerCurrentAuthority();
      expect(decide("jira.issue").kind).toBe(
        mode === "autonomous-delivery" ? "allowed" : "review-required",
      );
      expect(decide("create-issue").kind).toBe(
        mode === "autonomous-delivery" ? "allowed" : "review-required",
      );
      expect(decide("create-page").kind).toBe("policy-denied");
    },
  );

  it("never widens read-only authority in Full access", () => {
    store.updateChat(chat.id, { toolMode: "autonomous-delivery" });
    registerCurrentAuthority({ connectorScopes: ["issue-tracker.read"] });
    expect(decide("jira.issue").kind).toBe("allowed");
    expect(decide("create-issue").kind).toBe("policy-denied");
  });

  it("does not charge pending policy decisions and accumulates reservations", () => {
    registerCurrentAuthority({
      budget: { maxRuntimeMs: 60_000, maxToolCalls: 2, maxPromptTokens: 10, maxPatchBytes: 0 },
    });
    for (let i = 0; i < 4; i++) expect(decide("create-issue").kind).toBe("review-required");
    expect(reserve(1, 4).ok).toBe(true);
    expect(reserve(1, 6).ok).toBe(true);
    expect(reserve()).toEqual({ ok: false, reason: "budget-exceeded" });
  });

  it("rechecks current facts immediately before reservation", () => {
    expect(decide("jira.issue").kind).toBe("review-required");
    updatePod({ verificationInProgress: true });
    expect(reserve()).toEqual({ ok: false, reason: "invalid" });
    expect(decide("jira.issue")).toEqual({ kind: "authority-denied", reason: "authority-invalid" });
    updatePod({ verificationInProgress: false });
    expect(reserve().ok).toBe(true);
  });
});

it("reconstructs Chat policy and reservation through the real Activity Log", () => {
  const sink = createFileServerLogSink(project, { level: "debug" });
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  try {
    expect(decide("jira.issue").kind).toBe("review-required");
    store.updateChat(chat.id, { toolMode: "autonomous-delivery" });
    registerCurrentAuthority();
    expect(decide("jira.issue").kind).toBe("allowed");
    expect(decide("create-issue").kind).toBe("allowed");
    expect(decide("create-page").kind).toBe("policy-denied");
    expect(reserve(1, 2).ok).toBe(true);
    const lines = persistedActivityLogLines(
      readPersistedActivityLog(project),
      "chat.tool-authority.operation",
    );
    const records = lines.map((line) =>
      expectActivityLogProof("chat.tool-authority.operation.action-policy", line),
    );
    expect(
      records
        .filter((line) => line.phase === "action-policy")
        .map((line) => [line.actionType, line.outcome]),
    ).toEqual([
      ["jira.issue", "review-required"],
      ["jira.issue", "allowed"],
      ["create-issue", "allowed"],
      ["create-page", "policy-denied"],
    ]);
    expect(records.find((line) => line.outcome === "review-required")).toMatchObject({
      level: "info",
    });
    expect(records.find((line) => line.phase === "reserve")).toMatchObject({
      toolCalls: 1,
      promptTokens: 2,
      outcome: "allowed",
    });
    expect(records.every((line) => line.correlationId === "chat-policy-proof")).toBe(true);
    expect(lines.join("\n")).not.toContain("private-credential-reference");
    expect(lines.join("\n")).not.toContain(chat.id);
  } finally {
    sink.close?.();
    resetServerLogger();
  }
});

describe("ordinary Chat first-read consent admission", () => {
  let grants: AtlassianActionApprovalRegistry;
  const now = Date.parse(CHAT_AUTHORITY_TEST_NOW);
  beforeEach(() => {
    grants = new AtlassianActionApprovalRegistry(() => now, store.chatToolReadGrants);
  });

  function request(): ReturnType<typeof requestJiraChatReadGrant> {
    return requestJiraChatReadGrant(
      { ...deps, atlassianActionApprovalRegistry: grants },
      chat.id,
      reference,
      CHAT_AUTHORITY_TEST_NOW,
      "read-admission-proof",
    );
  }

  function pendingId(): string {
    const value = request();
    expect(value.kind).toBe("review-required");
    if (value.kind === "denied") throw new Error("Expected a grant request");
    return value.grant.grantId;
  }

  it.each(["governed-assist", "supervised-coding", "autonomous-delivery"] as const)(
    "requests one explicit read grant in %s",
    (mode) => {
      store.updateChat(chat.id, { toolMode: mode });
      registerCurrentAuthority();
      const first = request();
      expect(first.kind).toBe("review-required");
      expect(request()).toEqual(first);
      if (first.kind === "denied") throw new Error("Expected grant");
      expect(first.grant.expiresAt).toBe(now + ATLASSIAN_ACTION_APPROVAL_TTL_MS);
      expect(JSON.stringify(first)).not.toMatch(
        /actorDigest|consentProofDigest|authority|authRef|baseUrl/,
      );
    },
  );

  it("reuses one pending request across current authorities without replacing its origin", () => {
    const id = pendingId();
    const origin = reference;
    registerCurrentAuthority({ runId: "next-turn" });
    expect(pendingId()).toBe(id);
    expect(grants.getChatReadGrant(id)?.authority).toEqual(origin);
  });

  it("retains consent across originating-turn changes but still requires current authority", () => {
    const id = pendingId();
    const entry = grants.getChatReadGrant(id);
    if (entry === undefined) throw new Error("Expected pending grant");
    expect(
      grants.acceptChatReadGrant(id, entry.grant.subject, entry.authority, "b".repeat(64)).ok,
    ).toBe(true);
    expect(request()).toMatchObject({ kind: "granted", grant: { grantId: id } });
    registerCurrentAuthority({ runId: "later-turn" });
    expect(request()).toMatchObject({ kind: "granted", grant: { grantId: id } });
    deps.agentAuthorityRegistry?.revoke(entry.authority);
    expect(request()).toMatchObject({ kind: "granted", grant: { grantId: id } });
    deps.agentAuthorityRegistry?.revoke(reference);
    expect(request()).toEqual({ kind: "denied", reason: "authority-denied" });
  });

  it("does not automatically ask again after rejection within the same authority", () => {
    const id = pendingId();
    const entry = grants.getChatReadGrant(id);
    if (entry === undefined) throw new Error("Expected pending grant");
    expect(grants.rejectChatReadGrant(id, entry.grant.subject, entry.authority).ok).toBe(true);
    expect(request()).toEqual({ kind: "denied", reason: "rejected" });
    registerCurrentAuthority({ runId: "new-human-turn" });
    expect(pendingId()).not.toBe(id);
  });

  it("caps the grant lifetime at the original authority expiry", () => {
    registerCurrentAuthority({ expiresAt: new Date(now + 30_000).toISOString() });
    const id = pendingId();
    expect(grants.getChatReadGrant(id)?.grant.expiresAt).toBe(now + 30_000);
  });

  it("fails closed without a graph approval owner or current read authority", () => {
    expect(
      requestJiraChatReadGrant(deps, chat.id, reference, CHAT_AUTHORITY_TEST_NOW, "missing-owner")
        .kind,
    ).toBe("denied");
    registerCurrentAuthority({ connectorScopes: ["issue-tracker.write"] });
    expect(request().kind).toBe("denied");
    updatePod({ verificationInProgress: true });
    expect(request().kind).toBe("denied");
  });

  it("records one request and causal reuse without private facts", () => {
    const sink = createFileServerLogSink(project, { level: "debug" });
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    try {
      const id = pendingId();
      expect(pendingId()).toBe(id);
      const lines = persistedActivityLogLines(
        readPersistedActivityLog(project),
        "chat.tool-authority.operation",
      );
      const records = lines.map((line) =>
        expectActivityLogProof("chat.tool-authority.operation.read-grant-admission", line),
      );
      expect(
        records.filter((line) => line.grantState === "pending").map((line) => line.affectedCount),
      ).toEqual([1, 0]);
      expect(records.every((line) => line.correlationId === "read-admission-proof")).toBe(true);
      for (const value of [id, chat.id, POD, actor, "private-credential-reference"])
        expect(lines.join("\n")).not.toContain(value);
    } finally {
      sink.close?.();
      resetServerLogger();
    }
  });

  it("fails closed when the authority expires during grant creation", () => {
    registerCurrentAuthority({ expiresAt: new Date(now + 1).toISOString() });
    grants = new AtlassianActionApprovalRegistry(() => now + 2);
    expect(request()).toEqual({ kind: "denied", reason: "unavailable" });
  });

  it("retains the shared approval capacity bound", () => {
    const current = resolve();
    if (!current.ok) throw new Error("Expected authority");
    for (let i = 0; i < ATLASSIAN_ACTION_APPROVAL_MAX_PENDING; i++) {
      expect(
        grants.createChatReadGrant({
          authority: reference,
          grant: {
            schemaVersion: "1",
            kind: "jira-chat-read-grant",
            grantId: `occupied-${String(i)}`,
            subject: { ...current.envelope.subject, bindingGeneration: i + 50 },
            disclosureVersion: "jira-chat-read-v1",
            requestedAt: now,
            expiresAt: now + ATLASSIAN_ACTION_APPROVAL_TTL_MS,
            state: "pending",
            consentProofDigest: null,
          },
        }).ok,
      ).toBe(true);
    }
    expect(request()).toEqual({ kind: "denied", reason: "capacity-exhausted" });
  });
});

describe("ordinary Chat catalog read admission", () => {
  const now = Date.parse(CHAT_AUTHORITY_TEST_NOW);
  let grants: AtlassianActionApprovalRegistry;
  let requests: number;
  let notifications: number;
  let beforeConnection: () => void;
  let afterRequest: () => void;
  let responseBody: string;
  let consent: (grant: ChatToolReadGrantView) => void | Promise<void>;
  const hosts: { close: () => Promise<void> }[] = [];

  beforeEach(() => {
    grants = new AtlassianActionApprovalRegistry(() => now);
    requests = 0;
    notifications = 0;
    beforeConnection = (): void => undefined;
    afterRequest = (): void => undefined;
    responseBody = "[]";
    consent = (view): void => {
      const entry = grants.getChatReadGrant(view.grantId);
      if (entry === undefined) throw new Error("Expected retained grant");
      expect(
        grants.acceptChatReadGrant(
          view.grantId,
          entry.grant.subject,
          entry.authority,
          "f".repeat(64),
          "catalog-consent-proof",
        ).ok,
      ).toBe(true);
    };
  });
  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
  });

  function context(): JiraChatCatalogContext {
    return {
      runId: "ordinary-chat-turn",
      correlationId: "catalog-consent-proof",
      chatId: chat.id,
      authority: reference.envelopeDigest,
      authorityReference: reference,
      authorityExpiresAt: "2026-07-09T13:00:00.000Z",
      deadlineAt: new Date(now + 60_000).toISOString(),
      signal: new AbortController().signal,
    };
  }

  async function catalogFixture(
    maxToolCalls = 3,
    primary: import("@oscharko-dev/keiko-activity-log").ServerLogSink = createBufferedServerLogSink(),
    withKnowledge = false,
  ): Promise<{
    binder: ReturnType<typeof createCatalogToolBinder>;
    budget: ReturnType<typeof createHarnessCatalogBudget>;
    counters: RunCounters;
    managed: Awaited<ReturnType<typeof createManagedProviderCatalog<JiraChatCatalogConsumer>>>;
    handlers: readonly { execute: ReturnType<typeof vi.fn> }[];
  }> {
    const current = context();
    const counters: RunCounters = {
      iterations: 0,
      modelCalls: 0,
      toolCalls: 0,
      commandExecutions: 0,
      failureAttempts: 0,
      browserNavigations: 0,
    };
    const budget = createHarnessCatalogBudget({
      ...current,
      counters,
      now: () => now,
      deadlineAt: now + 60_000,
      limits: { ...DEFAULT_LIMITS, maxToolCalls },
    });
    const log = {
      primary,
      diagnostics: { record: (): void => undefined },
    };
    const provider = createJiraProviderForCatalog<CatalogHandlerContext<JiraChatCatalogConsumer>>(
      () => {
        beforeConnection();
        return {
          baseUrl: "https://jira.example.invalid/context",
          deployment: "data-center",
          http: async (): Promise<
            import("@oscharko-dev/keiko-connectors").AtlassianHttpBodyResult
          > => {
            requests++;
            await Promise.resolve();
            afterRequest();
            return {
              kind: "response",
              status: 200,
              bodyText: responseBody,
              bodyBytes: Buffer.byteLength(responseBody),
              truncated: false,
            };
          },
        };
      },
    );
    const managed = await createManagedProviderCatalog<JiraChatCatalogConsumer>({
      providers: withKnowledge
        ? [provider, createKnowledgeRequirementsProvider(deps as unknown as UiHandlerDeps)]
        : [provider],
      profile: { id: "jira-chat", version: 1 },
      log,
      correlationId: current.correlationId,
      now: () => now,
      routes: withKnowledge
        ? jiraChatCatalogRoutes([...JIRA_MANAGED_READ_TOOLS, ...KNOWLEDGE_CHAT_TOOLS])
        : jiraChatReadCatalogRoutes(),
    });
    hosts.push(managed);
    const admission = createJiraChatCatalogAdmission({
      deps: { ...deps, atlassianActionApprovalRegistry: grants },
      context: () => current,
      now: () => now,
      requestReadConsent: (view): Promise<void> => {
        notifications++;
        expect(requests).toBe(0);
        expect(counters.toolCalls).toBe(0);
        return Promise.resolve(consent(view));
      },
    });
    const handlers = managed.handlerBindings.map((binding) => ({
      ...binding,
      execute: vi.fn(binding.execute),
    }));
    const binder = createCatalogToolBinder<JiraChatCatalogConsumer>(
      {
        ...admission,
        consumerPort: jiraChatCatalogConsumerPort,
        projection: managed.projection,
        handlerBindings: handlers,
        budgetPort: budget.port,
        logPort: log,
      },
      {
        catalog: managed.catalog,
        context: () => current,
        now: () => now,
        mintId: randomUUID,
        invocationRegistry: createCodingToolInvocationRegistry({ now: () => now }),
      },
    );
    return { binder, budget, counters, managed, handlers };
  }

  async function dispatch(
    f: Awaited<ReturnType<typeof catalogFixture>>,
    suffix: string,
    args: unknown = {},
    tool = "keiko.jira.projects",
  ): Promise<Awaited<ReturnType<typeof f.binder.dispatch>>> {
    const offered = f.binder.offer();
    const descriptor = f.managed.catalog.descriptors.find(
      (entry) => entry.toolRef.canonicalId === tool,
    );
    if (descriptor === undefined) throw new Error("Expected project descriptor");
    const result = await f.binder.dispatch(
      {
        kind: "bound",
        toolRef: descriptor.toolRef,
        projectionDigest: offered.binding.projectionDigest,
        offerId: offered.offerId,
        arguments: args,
      },
      { actionId: `read-${suffix}`, idempotencyKey: `read-key-${suffix}` },
    );
    if (result.kind === "settled") f.budget.acceptReceipt(result.receipt, descriptor);
    return result;
  }

  it.each(["governed-assist", "supervised-coding", "autonomous-delivery"] as const)(
    "reads through the SDK only after consent in %s",
    async (mode) => {
      store.updateChat(chat.id, { toolMode: mode });
      registerCurrentAuthority();
      const f = await catalogFixture();
      expect(f.binder.offer().toolRefs).toHaveLength(10);
      expect(notifications).toBe(0);
      expect(await dispatch(f, "first")).toMatchObject({
        kind: "settled",
        result: { status: "completed", data: { items: [] } },
      });
      expect(requests).toBe(1);
      expect(f.counters.toolCalls).toBe(1);
      expect(await dispatch(f, "second")).toMatchObject({
        kind: "settled",
        result: { status: "completed" },
      });
      expect(notifications).toBe(1);
      expect(requests).toBe(2);
      expect(f.counters.toolCalls).toBe(2);
    },
  );

  it.each(["mode", "budget"] as const)(
    "refuses handler entry when %s changes while read approval is pending",
    async (change) => {
      registerCurrentAuthority({
        budget: { maxRuntimeMs: 60_000, maxToolCalls: 1, maxPromptTokens: 100, maxPatchBytes: 0 },
      });
      const accept = consent;
      let resume = (): void => undefined;
      let entered = (_view: ChatToolReadGrantView): void => undefined;
      const waiting = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const requested = new Promise<ChatToolReadGrantView>((resolve) => {
        entered = resolve;
      });
      consent = (view): Promise<void> => {
        entered(view);
        return waiting;
      };
      const f = await catalogFixture();
      const pending = dispatch(f, `pending-${change}`);
      try {
        const view = await requested;
        expect(grants.getChatReadGrant(view.grantId)?.grant.state).toBe("pending");
        if (change === "mode") store.updateChat(chat.id, { toolMode: "autonomous-delivery" });
        else expect(reserve().ok).toBe(true);
        await accept(view);
        expect(grants.getChatReadGrant(view.grantId)?.grant.state).toBe("granted");
        resume();
        expect(await pending).toMatchObject({
          kind: "settled",
          result: { status: "denied", effectStarted: false },
        });
        for (const handler of f.handlers) expect(handler.execute).not.toHaveBeenCalled();
        expect(requests).toBe(0);
        expect(f.counters.toolCalls).toBe(0);
      } finally {
        resume();
        await pending;
      }
    },
  );

  it("hosts the requirements read on the same catalog without a Jira read grant (#4179)", async () => {
    registerCurrentAuthority();
    const f = await catalogFixture(3, undefined, true);

    // The ten Jira reads plus knowledge.requirements.
    expect(f.binder.offer().toolRefs).toHaveLength(11);
    const result = await dispatch(f, "knowledge", {}, "keiko.knowledge.requirements");

    // The Chat has no Knowledge Pod: the handler is entered and answers with a closed reason.
    expect(result).toMatchObject({
      kind: "settled",
      result: { status: "failed", data: { outcome: "failed", reason: "no-knowledge-pod" } },
    });
    expect(notifications).toBe(0);
    expect(requests).toBe(0);
    expect(f.handlers.filter((handler) => handler.execute.mock.calls.length > 0)).toHaveLength(1);
  });

  it("refuses the requirements read once the Chat's Jira binding is gone (#4179)", async () => {
    registerCurrentAuthority();
    const f = await catalogFixture(3, undefined, true);
    store.updateChat(chat.id, { jiraPodId: null });

    const result = await dispatch(f, "no-authority", {}, "keiko.knowledge.requirements");

    expect(result).toMatchObject({ kind: "settled" });
    expect(result).not.toMatchObject({ result: { status: "completed" } });
    for (const handler of f.handlers) expect(handler.execute).not.toHaveBeenCalled();
  });

  it("does not treat a completed notification as human consent", async () => {
    consent = (): void => undefined;
    const f = await catalogFixture();
    expect(await dispatch(f, "unapproved")).toMatchObject({
      kind: "settled",
      result: { status: "denied" },
      receipt: { effectStarted: false, budgetDisposition: "not-reserved" },
    });
    expect(requests).toBe(0);
    expect(f.counters.toolCalls).toBe(0);
  });

  it("rejects model authority and routing overrides before requesting consent", async () => {
    const f = await catalogFixture();
    expect(await dispatch(f, "override", { chatId: "other", authority: reference })).toMatchObject({
      kind: "settled",
      result: { status: "invalid" },
    });
    expect(notifications).toBe(0);
    expect(requests).toBe(0);
  });

  it.each(["disconnect", "reverify", "actor", "revoke"] as const)(
    "stops at the final HTTP boundary after %s",
    async (change) => {
      const f = await catalogFixture();
      beforeConnection = (): void => {
        if (change === "disconnect") store.updateChat(chat.id, { jiraPodId: null });
        if (change === "reverify") updatePod({ verificationInProgress: true });
        if (change === "actor") actor = "other-operator";
        if (change === "revoke") grants.revokeChatReadGrants(chat.id);
      };
      const result = await dispatch(f, change);
      expect(result).not.toMatchObject({ result: { status: "completed" } });
      expect(requests).toBe(0);
      expect(f.counters.toolCalls).toBe(0);
    },
  );

  it("reconstructs consent admission and a refused effect through the real Activity Log", async () => {
    const sink = createFileServerLogSink(project, { level: "debug" });
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    try {
      const f = await catalogFixture();
      expect(await dispatch(f, "logged")).toMatchObject({ result: { status: "completed" } });
      beforeConnection = (): void => {
        updatePod({ verificationInProgress: true });
      };
      expect(await dispatch(f, "refused")).not.toMatchObject({ result: { status: "completed" } });
      const lines = persistedActivityLogLines(
        readPersistedActivityLog(project),
        "chat.tool-authority.operation",
      );
      const records = lines.map((line) =>
        expectActivityLogProof("chat.tool-authority.operation.catalog-read", line),
      );
      const outcomes = new Set(
        records.filter((line) => line.phase === "catalog-read").map((line) => line.outcome),
      );
      expect([...outcomes].sort()).toEqual(["allowed", "invalid", "review-required"]);
      expect(requests).toBe(1);
      for (const value of [
        chat.id,
        POD,
        actor,
        "private-credential-reference",
        "jira.example.invalid",
      ])
        expect(lines.join("\n")).not.toContain(value);
    } finally {
      sink.close?.();
      resetServerLogger();
    }
  });

  it.each(["disconnect", "reverify", "actor", "revoke"] as const)(
    "discards a late read result after %s while retaining the performed-effect charge",
    async (change) => {
      const f = await catalogFixture();
      responseBody = JSON.stringify([{ id: "10", key: "KEIKO", name: "Late private project" }]);
      afterRequest = (): void => {
        if (change === "disconnect") store.updateChat(chat.id, { jiraPodId: null });
        if (change === "reverify") updatePod({ verificationInProgress: true });
        if (change === "actor") actor = "other-operator";
        if (change === "revoke") grants.revokeChatReadGrants(chat.id);
      };
      const result = await dispatch(f, `late-${change}`);
      expect(result).toMatchObject({
        kind: "settled",
        result: { status: "denied", reason: "effect-denied" },
        receipt: { effectStarted: true, budgetDisposition: "committed" },
      });
      expect(JSON.stringify(result)).not.toContain("Late private project");
      expect(requests).toBe(1);
      expect(f.counters.toolCalls).toBe(1);
    },
  );

  it("records a discarded late read with one committed settlement", async () => {
    const sink = createFileServerLogSink(project, { level: "debug" });
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    try {
      const f = await catalogFixture(3, sink);
      afterRequest = (): void => {
        grants.revokeChatReadGrants(chat.id, "catalog-consent-proof");
      };
      expect(await dispatch(f, "late-proof")).toMatchObject({ result: { status: "denied" } });
      const persisted = readPersistedActivityLog(project);
      const checks = persistedActivityLogLines(persisted, "chat.tool-authority.operation").map(
        (line) => expectActivityLogProof("chat.tool-authority.operation.late-read-result", line),
      );
      expect(
        checks.some((entry) => entry.phase === "catalog-read" && entry.outcome === "invalid"),
      ).toBe(true);
      const settlements = persistedActivityLogLines(persisted, "tool-catalog.invocation-settled");
      expect(settlements).toHaveLength(1);
      expect(settlements[0]).toContain('"effectStarted":true');
      expect(settlements[0]).toContain('"budgetDisposition":"committed"');
      expect(requests).toBe(1);
      expect(f.counters.toolCalls).toBe(1);
    } finally {
      sink.close?.();
      resetServerLogger();
    }
  });

  it("uses the existing Harness counter and stops at its last slot", async () => {
    const f = await catalogFixture(1);
    expect(await dispatch(f, "one")).toMatchObject({ result: { status: "completed" } });
    expect(await dispatch(f, "two")).toMatchObject({
      result: { status: "denied", reason: "budget-exhausted" },
    });
    expect(requests).toBe(1);
    expect(f.counters.toolCalls).toBe(1);
  });
});

describe("ordinary Chat exact-action write approval admission", () => {
  let approvals: AtlassianActionApprovalRegistry;
  const now = Date.parse(CHAT_AUTHORITY_TEST_NOW);
  const action = {
    invocationId: "canonical-turn-call",
    operation: "jira.comment",
    actionDigest: "a".repeat(64),
  } as const;
  beforeEach(() => {
    approvals = new AtlassianActionApprovalRegistry(() => now);
  });

  function request(digest = action.actionDigest): ReturnType<typeof requestJiraChatWriteApproval> {
    return requestJiraChatWriteApproval(
      { ...deps, atlassianActionApprovalRegistry: approvals },
      chat.id,
      reference,
      { ...action, actionDigest: digest },
      CHAT_AUTHORITY_TEST_NOW,
      "write-admission",
    );
  }

  function grantRead(): string {
    const value = requestJiraChatReadGrant(
      { ...deps, atlassianActionApprovalRegistry: approvals },
      chat.id,
      reference,
      CHAT_AUTHORITY_TEST_NOW,
      "write-read-consent",
    );
    if (value.kind === "denied") throw new Error("Expected read consent request");
    const retained = approvals.getChatReadGrant(value.grant.grantId);
    if (retained === undefined) throw new Error("Expected retained read consent");
    expect(
      approvals.acceptChatReadGrant(
        value.grant.grantId,
        retained.grant.subject,
        retained.authority,
        "b".repeat(64),
      ).ok,
    ).toBe(true);
    return value.grant.grantId;
  }

  function pending(): NonNullable<
    ReturnType<AtlassianActionApprovalRegistry["getChatWriteApproval"]>
  > {
    const value = request();
    if (value.kind === "denied" || value.kind === "allowed")
      throw new Error("Expected approval request");
    const entry = approvals.getChatWriteApproval(value.approval.approvalId);
    if (entry === undefined) throw new Error("Expected retained write approval");
    return entry;
  }

  it.each(["governed-assist", "supervised-coding", "autonomous-delivery"] as const)(
    "requires current read consent before writes and obeys the %s policy",
    (mode) => {
      store.updateChat(chat.id, { toolMode: mode });
      registerCurrentAuthority();
      expect(request()).toEqual({ kind: "denied", reason: "authority-denied" });
      grantRead();
      expect(request().kind).toBe(mode === "autonomous-delivery" ? "allowed" : "review-required");
    },
  );

  it("reuses the exact pending, approved and claimed action without authorizing changed arguments", () => {
    grantRead();
    const entry = pending();
    expect(pending()).toEqual(entry);
    expect(request("f".repeat(64))).toEqual({ kind: "denied", reason: "invalid" });
    expect(
      approvals.acceptChatWriteApproval(
        entry.approval.approvalId,
        entry.subject,
        entry.authority,
        action,
        "c".repeat(64),
      ).ok,
    ).toBe(true);
    expect(request().kind).toBe("approved");
    expect(
      approvals.claimChatWriteApproval(
        entry.approval.approvalId,
        entry.subject,
        entry.authority,
        action,
      ).ok,
    ).toBe(true);
    expect(request().kind).toBe("claimed");
  });

  it("cannot silently recreate a rejected exact action", () => {
    grantRead();
    const entry = pending();
    expect(
      approvals.rejectChatWriteApproval(
        entry.approval.approvalId,
        entry.subject,
        entry.authority,
        action,
      ).ok,
    ).toBe(true);
    expect(request()).toEqual({ kind: "denied", reason: "rejected" });
  });

  it("never widens read-only authority even in Full access", () => {
    store.updateChat(chat.id, { toolMode: "autonomous-delivery" });
    registerCurrentAuthority({ connectorScopes: ["issue-tracker.read"] });
    grantRead();
    expect(request()).toEqual({ kind: "denied", reason: "authority-denied" });
  });

  it.each(["actor", "credential", "binding", "read-consent", "authority", "expiry"] as const)(
    "invalidates pending writes when current %s changes",
    (kind) => {
      const readId = grantRead();
      const entry = pending();
      let at = CHAT_AUTHORITY_TEST_NOW;
      if (kind === "actor") actor = "another-actor";
      if (kind === "credential") metadata = metadata.map((value) => ({ ...value, generation: 2 }));
      if (kind === "binding") store.updateChat(chat.id, { jiraPodId: null });
      if (kind === "read-consent") approvals.revokeChatReadGrant(readId);
      if (kind === "authority") deps.agentAuthorityRegistry?.revoke(reference);
      if (kind === "expiry") at = new Date(entry.approval.expiresAt).toISOString();
      expect(
        isCurrentJiraChatWriteApproval(
          { ...deps, atlassianActionApprovalRegistry: approvals },
          entry,
          at,
          "write-invalidated",
        ),
      ).toBe(false);
    },
  );

  it("bounds pending expiry to the retained read consent and emits no private approval context", () => {
    const readId = grantRead();
    const entry = pending();
    expect(entry.approval.expiresAt).toBeLessThanOrEqual(
      approvals.getChatReadGrant(readId)?.grant.expiresAt ?? 0,
    );
    expect(JSON.stringify(request())).not.toMatch(
      /actorDigest|approvalProofDigest|authority|claimId|baseUrl|authRef/,
    );
  });
});
