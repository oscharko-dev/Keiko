import {
  AtlassianActionApprovalRegistry,
  ATLASSIAN_ACTION_APPROVAL_TTL_MS,
  ATLASSIAN_ACTION_APPROVAL_MAX_PENDING,
} from "./actionApprovals.js";
import type { JiraLivePodMetadata } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AtlassianCredentialMetadata,
  ChatToolAuthorityEnvelope,
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
import { jiraChatActorDigest } from "./jiraPodAccess.js";
import {
  requestJiraChatReadGrant,
  resolveCurrentJiraChatAuthority,
  decideGovernedJiraChatAction,
  reserveCurrentJiraChatAuthority,
  type JiraChatAuthorityDeps,
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
    grants = new AtlassianActionApprovalRegistry(() => now);
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

  it("reuses accepted consent only while original and current authorities remain valid", () => {
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
    const renewed = pendingId();
    expect(renewed).not.toBe(id);
    expect(grants.getChatReadGrant(id)?.grant.state).toBe("revoked");
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
