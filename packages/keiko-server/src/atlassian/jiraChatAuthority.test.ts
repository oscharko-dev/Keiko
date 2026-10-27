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
  resolveCurrentJiraChatAuthority,
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
