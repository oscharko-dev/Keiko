import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { McpServerDefinition } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { createNodeUiStore, type UiStore } from "../store/index.js";
import { EditorAgentAuthorityRegistry } from "../editor/agentAuthorityRegistry.js";
import { AtlassianActionApprovalRegistry } from "../atlassian/actionApprovals.js";
import type { ChatReadGrantEntry } from "../atlassian/chatReadGrantState.js";
import { createMcpSettingsStore } from "./mcpSettingsStore.js";
import {
  isCurrentMcpChatReadGrant,
  mintAcceptedMcpChatAuthority,
  requestMcpChatReadGrant,
  type McpChatAuthorityDeps,
} from "./mcpChatAuthority.js";

const REFERENCE = "KEIKO_MCP_SECRET_RESTART_FIXTURE";
const CORRELATION = "mcp-credential-restart-proof";
const disposals: (() => void)[] = [];
afterEach(() => {
  for (const close of disposals.splice(0).reverse()) close();
});
interface Session {
  readonly deps: McpChatAuthorityDeps;
  readonly store: UiStore;
  readonly settings: ReturnType<typeof createMcpSettingsStore>;
  readonly registry: AtlassianActionApprovalRegistry;
  readonly close: () => void;
}
function openSession(stateDir: string, env: Readonly<Record<string, string | undefined>>): Session {
  const store = createNodeUiStore(join(stateDir, "ui.db"));
  let closed = false;
  const close = (): void => {
    if (!closed) {
      closed = true;
      store.close();
    }
  };
  disposals.push(close);
  const settings = createMcpSettingsStore({ stateDir, env, keychainAccess: () => undefined });
  const registry = new AtlassianActionApprovalRegistry(Date.now, store.chatToolReadGrants);
  const deps: McpChatAuthorityDeps = {
    store,
    mcpSettings: settings,
    serverPrincipal: () => "synthetic-operator",
    agentAuthorityRegistry: new EditorAgentAuthorityRegistry(),
    atlassianActionApprovalRegistry: registry,
    autonomousDeliveryDeploymentCeiling: "autonomous-delivery",
  };
  return { deps, store, settings, registry, close };
}
function readRequest(session: Session, chatId: string): ReturnType<typeof requestMcpChatReadGrant> {
  const now = Date.now();
  const admitted = session.store.admitChatTurn(randomUUID(), {
    chatId,
    role: "user",
    content: "Use the synthetic MCP server",
    timestamp: now,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  if (admitted.kind !== "admitted") throw new Error("Expected a fresh accepted turn");
  const message = admitted.userMessage;
  const authority = mintAcceptedMcpChatAuthority(session.deps, {
    chatId,
    userMessageId: message.id,
    startedAtMs: now,
    nowMs: now,
    correlationId: CORRELATION,
  });
  if (!authority.ok) throw new Error("Expected accepted Chat authority");
  return requestMcpChatReadGrant(
    session.deps,
    chatId,
    authority.reference,
    new Date(now).toISOString(),
    CORRELATION,
  );
}
function grant(session: Session, chatId: string): ChatReadGrantEntry {
  const requested = readRequest(session, chatId);
  if (requested.kind !== "review-required") throw new Error("Expected read disclosure");
  const pending = session.registry.getChatReadGrant(requested.grant.grantId, CORRELATION);
  if (pending === undefined) throw new Error("Missing persisted grant");
  expect(
    session.registry.acceptChatReadGrant(
      pending.grant.grantId,
      pending.grant.subject,
      pending.authority,
      "f".repeat(64),
      CORRELATION,
    ).ok,
  ).toBe(true);
  const entry = session.registry.getChatReadGrant(pending.grant.grantId, CORRELATION);
  if (entry === undefined) throw new Error("Missing accepted grant");
  return entry;
}
function fixture(sealed: boolean): {
  readonly stateDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly initial: Session;
  readonly chatIds: readonly string[];
  readonly grants: readonly ChatReadGrantEntry[];
} {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-mcp-env-restart-")));
  disposals.push(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });
  const env = {
    KEIKO_MCP_OAUTH_CREDENTIALS_KEY: randomBytes(32).toString("base64"),
    [REFERENCE]: "synthetic-original-credential",
  };
  const initial = openSession(stateDir, env);
  const server: McpServerDefinition = {
    name: "synthetic",
    description: undefined,
    enabled: true,
    transport: {
      kind: "remote",
      url: "https://synthetic.example.invalid/mcp",
      headers: { Authorization: { secretEnv: REFERENCE, prefix: "Bearer " } },
    },
    tools: { get_status: "read" },
  };
  initial.settings.update(
    {
      expectedRevision: initial.settings.read(CORRELATION).revision,
      servers: [server],
      secrets: sealed
        ? { [REFERENCE]: { server: server.name, value: "synthetic-sealed-credential" } }
        : {},
    },
    CORRELATION,
  );
  initial.store.createProject(stateDir);
  const chatIds = ["First", "Second"].map(
    (name) => initial.store.createChat(stateDir, name, "synthetic-model").id,
  );
  return { stateDir, env, initial, chatIds, grants: chatIds.map((id) => grant(initial, id)) };
}
it.each([
  { label: "changed", credential: "synthetic-replacement-credential" },
  { label: "unchanged", credential: "synthetic-original-credential" },
])(
  "requires fresh disclosure for both persisted Chats after restarting with $label legacy env credentials",
  ({ credential }) => {
    const f = fixture(false);
    const file = join(f.stateDir, "mcp-servers.json");
    const saved = readFileSync(file, "utf8");
    const before = f.initial.settings.read(CORRELATION);
    f.initial.close();
    const restarted = openSession(f.stateDir, { ...f.env, [REFERENCE]: credential });
    for (const entry of f.grants) {
      const restored = restarted.registry.getChatReadGrant(entry.grant.grantId, CORRELATION);
      expect(restored?.grant.state).toBe("granted");
      if (restored === undefined) throw new Error("Missing restored consent");
      expect(
        isCurrentMcpChatReadGrant(restarted.deps, restored, new Date().toISOString(), CORRELATION),
      ).toBe(false);
    }
    for (const id of f.chatIds) expect(readRequest(restarted, id).kind).toBe("review-required");
    expect(restarted.settings.read(CORRELATION).revision).not.toBe(before.revision);
    expect(readFileSync(file, "utf8")).toBe(saved);
  },
);
it("keeps both persisted Chat disclosures and the stable revision for unchanged vault credentials", () => {
  const f = fixture(true);
  const before = f.initial.settings.read(CORRELATION);
  const files = [
    join(f.stateDir, "mcp-servers.json"),
    join(f.stateDir, "credentials", "mcp-oauth-credentials.vault"),
  ];
  const saved = files.map((file) => readFileSync(file, "utf8"));
  f.initial.close();
  const restarted = openSession(f.stateDir, {
    ...f.env,
    [REFERENCE]: "synthetic-ignored-replacement",
  });
  expect(restarted.settings.read(CORRELATION)).toEqual(before);
  for (const id of f.chatIds) expect(readRequest(restarted, id).kind).toBe("granted");
  expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(saved);
});
