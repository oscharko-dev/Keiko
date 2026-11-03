import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, Server } from "node:http";
import { PassThrough } from "node:stream";
import type { EditorAgentGovernedAuthorityReference } from "@oscharko-dev/keiko-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AtlassianCredentialMetadata } from "@oscharko-dev/keiko-connectors";
import { buildUiHandlerDeps, type UiHandlerDeps } from "../deps.js";
import { buildCspHeader } from "../csp.js";
import { createUiServer, UI_HOST } from "../server.js";
import { mockResponse } from "../_support.js";
import { chatAuthorityFixture } from "../editor/chatAuthority.test-support.js";
import { AtlassianActionApprovalRegistry } from "./actionApprovals.js";
import type { ChatWriteApprovalEntry } from "./chatWriteApprovalState.js";
import { jiraChatActorDigest } from "./jiraPodAccess.js";
import { requestJiraChatReadGrant } from "./jiraChatAuthority.js";
import { requestJiraChatWriteApproval } from "./jiraChatWriteApproval.js";
import { handleDecideChatWriteApproval } from "./chatWriteApprovalRoutes.js";

const POD = "d5f5681e-ce98-4c3c-b27e-51d707c9d018";
const HEADERS = { "Content-Type": "application/json", "X-Keiko-CSRF": "1" };
let root: string;
let deps: UiHandlerDeps;
let server: Server;
let baseUrl: string;
let actor: string;
let rows: AtlassianCredentialMetadata[];
let registry: AtlassianActionApprovalRegistry;
let pending: ChatWriteApprovalEntry;
let clock: { now: () => number };

function metadata(): AtlassianCredentialMetadata {
  const ownerDigest = jiraChatActorDigest(deps);
  if (ownerDigest === undefined) throw new Error("Missing principal");
  return {
    schemaVersion: "1",
    authRef: "synthetic-credential",
    displayName: "Synthetic Jira",
    baseUrl: "https://jira.example.invalid",
    createdAt: 1,
    generation: 1,
    provider: "jira",
    deployment: "data-center",
    authScheme: "bearer-pat",
    livePod: {
      podId: POD,
      ownerDigest,
      creationRequestId: "d5f5681e-ce98-4c3c-b27e-51d707c9d019",
      verificationRevision: 1,
      verificationInProgress: false,
      verificationStatus: "ok",
    },
  };
}

function grantReadForChat(
  chatId: string,
  authority: EditorAgentGovernedAuthorityReference,
  now: string,
): void {
  const read = requestJiraChatReadGrant(deps, chatId, authority, now, "route-read");
  if (read.kind === "denied") throw new Error("Missing read consent");
  const retained = registry.getChatReadGrant(read.grant.grantId);
  if (retained === undefined) throw new Error("Missing retained read consent");
  expect(
    registry.acceptChatReadGrant(
      read.grant.grantId,
      retained.grant.subject,
      retained.authority,
      "b".repeat(64),
    ).ok,
  ).toBe(true);
}

function pendingForChat(actionDigest = "a".repeat(64)): ChatWriteApprovalEntry {
  const created = deps.store.createChat(root, "Approval", "synthetic-model");
  const chat = deps.store.updateChat(
    created.id,
    { jiraPodId: POD },
    { verifiedJiraPod: { podId: POD, authenticationGeneration: 1 } },
  );
  const binding = chat.jiraPodBinding;
  const actorDigest = jiraChatActorDigest(deps);
  if (binding === undefined || actorDigest === undefined) throw new Error("Missing Chat binding");
  const now = new Date().toISOString();
  const registered = deps.agentAuthorityRegistry?.registerChat(
    chatAuthorityFixture({
      requestedMode: "governed-assist",
      runId: `authority-${chat.id}`,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      subject: {
        actorDigest,
        chatId: chat.id,
        podId: binding.podId,
        bindingGeneration: binding.bindingGeneration,
        authenticationGeneration: binding.authenticationGeneration,
      },
    }),
    "autonomous-delivery",
    now,
  );
  if (registered?.ok !== true) throw new Error("Missing authority");
  grantReadForChat(chat.id, registered.authorityRef, now);
  const write = requestJiraChatWriteApproval(
    deps,
    chat.id,
    registered.authorityRef,
    { invocationId: `invocation-${chat.id}`, operation: "jira.comment", actionDigest },
    now,
    "route-write",
  );
  if (write.kind === "denied" || write.kind === "allowed")
    throw new Error("Missing write approval");
  const entry = registry.getChatWriteApproval(write.approval.approvalId);
  if (entry === undefined) throw new Error("Missing retained write approval");
  return entry;
}

async function listen(srv: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve) => srv.listen(port, UI_HOST, resolve));
  return (srv.address() as AddressInfo).port;
}
async function close(srv: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    srv.close(() => {
      resolve();
    });
  });
}
async function buildServer(): Promise<void> {
  const options = { staticRoot: root, csp: buildCspHeader([]), handlerDeps: deps };
  const probe = createUiServer({ ...options, port: 0 });
  const port = await listen(probe);
  await close(probe);
  server = createUiServer({ ...options, port });
  await listen(server, port);
  baseUrl = `http://${UI_HOST}:${String(port)}`;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "keiko-chat-write-route-"));
  actor = "synthetic-local-owner";
  clock = { now: Date.now };
  registry = new AtlassianActionApprovalRegistry(() => clock.now());
  deps = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(root, "evidence"),
    uiDbPath: join(root, "ui.db"),
    env: {},
    modelPortFactory: () => undefined,
  });
  Object.assign(deps, {
    serverPrincipal: (): string => actor,
    autonomousDeliveryDeploymentCeiling: "autonomous-delivery",
    atlassianActionApprovalRegistry: registry,
  });
  deps.store.createProject(root);
  rows = [metadata()];
  const credentials = deps.atlassianConnectorCredentials;
  if (credentials === undefined) throw new Error("Missing custody owner");
  vi.spyOn(credentials.custody, "list").mockImplementation(() => rows);
  vi.spyOn(credentials, "httpBodyPortFactory").mockImplementation(() => {
    throw new Error("Approval decisions must not execute a connector request");
  });
  pending = pendingForChat();
  await buildServer();
});

afterEach(async () => {
  await close(server);
  await deps.dispose?.();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function path(entry = pending): string {
  return `/api/atlassian-connectors/action-approvals/${entry.approval.approvalId}/chat-write-approval`;
}
function decide(
  body: unknown,
  headers: Record<string, string> = HEADERS,
  entry = pending,
): Promise<Response> {
  return fetch(`${baseUrl}${path(entry)}`, { method: "POST", headers, body: JSON.stringify(body) });
}
function decision(decision: "approve" | "reject" = "approve"): Record<string, string> {
  return { decision, actionDigest: pending.approval.actionDigest };
}

describe("authenticated Chat exact-action write approval routes", () => {
  it("observes, approves and claims once without dispatching an effect", async () => {
    const observed = await fetch(`${baseUrl}${path()}`);
    expect(observed.status).toBe(200);
    expect(await observed.json()).toEqual({ approval: pending.approval });
    const approved = await decide(decision());
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ approval: { state: "approved" } });
    expect((await decide(decision())).status).toBe(200);
    const claim = registry.claimChatWriteApproval(
      pending.approval.approvalId,
      pending.subject,
      pending.authority,
      pending.approval,
    );
    expect(claim.ok).toBe(true);
    expect(
      registry.claimChatWriteApproval(
        pending.approval.approvalId,
        pending.subject,
        pending.authority,
        pending.approval,
      ).ok,
    ).toBe(false);
    expect((await decide(decision())).status).toBe(409);
    expect(await (await fetch(`${baseUrl}${path()}`)).json()).toMatchObject({
      approval: { state: "claimed" },
    });
    expect(deps.atlassianConnectorCredentials?.httpBodyPortFactory).not.toHaveBeenCalled();
  });

  it("rejects without execution and never turns a rejected action back into an approval", async () => {
    expect((await decide(decision("reject"))).status).toBe(200);
    expect((await decide(decision())).status).toBe(409);
    expect(await (await fetch(`${baseUrl}${path()}`)).json()).toMatchObject({
      approval: { state: "rejected" },
    });
    expect(deps.atlassianConnectorCredentials?.httpBodyPortFactory).not.toHaveBeenCalled();
  });

  it("enforces CSRF and media-type guards before an approval state can change", async () => {
    expect((await decide(decision(), { "Content-Type": "application/json" })).status).toBe(403);
    expect(
      (await decide(decision(), { "Content-Type": "text/plain", "X-Keiko-CSRF": "1" })).status,
    ).toBe(415);
    expect(registry.getChatWriteApproval(pending.approval.approvalId)?.approval.state).toBe(
      "pending",
    );
  });

  it.each(["another-owner", ""])(
    "hides and preserves another actor's approval for principal %j",
    async (principal) => {
      actor = principal;
      expect((await fetch(`${baseUrl}${path()}`)).status).toBe(404);
      expect((await decide(decision())).status).toBe(404);
      expect(registry.getChatWriteApproval(pending.approval.approvalId)?.approval.state).toBe(
        "pending",
      );
    },
  );

  it("rejects wrong-action and cross-Chat previews without changing either retained record", async () => {
    const other = pendingForChat("c".repeat(64));
    expect((await decide({ ...decision(), actionDigest: "d".repeat(64) })).status).toBe(409);
    expect((await decide(decision(), HEADERS, other)).status).toBe(409);
    expect(registry.getChatWriteApproval(other.approval.approvalId)?.approval.state).toBe(
      "pending",
    );
    expect(registry.getChatWriteApproval(pending.approval.approvalId)?.approval.state).toBe(
      "pending",
    );
  });

  it.each([
    {},
    [],
    { decision: "approve" },
    { decision: "approve", actionDigest: "x" },
    { decision: "approve", actionDigest: "a".repeat(64), chatId: "other" },
  ])("rejects malformed or scope-overriding payload %j", async (body) => {
    expect((await decide(body)).status).toBe(400);
    expect(registry.getChatWriteApproval(pending.approval.approvalId)?.approval.state).toBe(
      "pending",
    );
  });

  it("bounds the decision body to 4 KiB", async () => {
    expect((await decide({ ...decision(), excess: "x".repeat(4096) })).status).toBe(413);
  });

  it.each(["binding", "credential", "authority", "read-consent", "expiry"] as const)(
    "denies a stale %s before approval",
    async (kind) => {
      if (kind === "binding") deps.store.updateChat(pending.subject.chatId, { jiraPodId: null });
      if (kind === "credential") rows = rows.map((entry) => ({ ...entry, generation: 2 }));
      if (kind === "authority") deps.agentAuthorityRegistry?.revoke(pending.authority);
      if (kind === "read-consent") registry.revokeChatReadGrants(pending.subject.chatId);
      if (kind === "expiry") clock.now = (): number => pending.approval.expiresAt;
      expect((await decide(decision())).status).toBe(404);
      expect(deps.atlassianConnectorCredentials?.httpBodyPortFactory).not.toHaveBeenCalled();
    },
  );

  it("rechecks authority after awaiting a delayed decision body", async () => {
    const stream = new PassThrough();
    const req = stream as unknown as IncomingMessage;
    const result = handleDecideChatWriteApproval(
      {
        req,
        res: mockResponse().res,
        params: { approvalId: pending.approval.approvalId },
        url: new URL(`${baseUrl}${path()}`),
        correlationId: "delayed-approval",
      },
      deps,
    );
    expect(stream.listenerCount("data")).toBe(1);
    deps.agentAuthorityRegistry?.revoke(pending.authority);
    stream.end(JSON.stringify(decision()));
    expect((await result).status).toBe(404);
    expect(registry.getChatWriteApproval(pending.approval.approvalId)?.approval.state).toBe(
      "pending",
    );
  });
});
