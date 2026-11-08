import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { jiraSessionBindingForInput, type JiraManagedConnection, type JiraHumanInputSelection } from "@oscharko-dev/keiko-connectors";
import type { JiraMutationAttempt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { privateJiraCustodyFixture } from "../../../../tests/support/jira-private-custody-fixture.js";
import { AVATAR_FIXTURE_BYTES, AVATAR_FIXTURE_FILE, AVATAR_MUTATION_FIXTURE_CASES } from "../../../../tests/support/jira-avatar-mutation-fixture.js";
import { createNodeUiStore } from "../store/index.js";
import { createGatewayAtlassianHttpBodyPort } from "./httpPort.js";
import { createJiraPrivatePorts } from "./httpPrivateIdentity.js";
import { executeJiraChatMutation, type JiraChatMutationExecution } from "./jiraChatMutation.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";

const BASE = "https://jira.example.invalid/context";
const COOKIE = { name: "JSESSIONID", value: "synthetic-private-journal-session" };
type Scenario = "login-proof" | "login-store" | "avatar-store" | "avatar-lost";
async function fixture(path: string, scenario: Scenario) {
  const store = createNodeUiStore(path); const privateState = privateJiraCustodyFixture("jira.login");
  const journal = store.chatToolMutations; if (journal === undefined) { store.close(); throw new TypeError("Missing mutation journal"); }
  const chat = store.createChat(store.createProject(process.cwd()).path, "Synthetic", "model");
  const turn = store.admitChatTurn("private-native-turn", { chatId: chat.id, role: "user", content: "Synthetic", timestamp: 1000,
    runId: undefined, workflowId: undefined, workflowStatus: undefined, shortResult: undefined, taskType: undefined });
  if (turn.kind !== "admitted" || turn.userMessage.canonicalTurnRef === undefined || privateState.binding.context.kind !== "chat") throw new TypeError("Missing synthetic turn");
  const binding = { ...privateState.binding, context: { ...privateState.binding.context, chatId: chat.id, messageId: turn.userMessage.id } };
  const avatar = scenario.startsWith("avatar-");
  const operation = avatar ? "jira.upload-project-avatar" : "jira.login";
  const intent: JiraChatMutationExecution["intent"] = { invocationId: "private-native-invocation", chatId: chat.id, userMessageId: turn.userMessage.id,
    turnRef: turn.userMessage.canonicalTurnRef, actorId: binding.actorUserKey, podId: binding.context.podId,
    bindingGeneration: 1, credentialGeneration: 1, authorityDigest: binding.authority.envelopeDigest, actionDigest: "f".repeat(64),
    operation, correlationId: "private-native-journal" };
  let selection: JiraHumanInputSelection | undefined;
  if (avatar) await privateState.sessions.withLease(jiraSessionBindingForInput(binding), async (session) => { session.establish(COOKIE); });
  else {
    const pending = privateState.inputs.prepare(binding);
    const ready = privateState.inputs.submit(pending.requestId, binding, pending.revision, { password: "synthetic human-only journal input" });
    selection = { requestId: ready.requestId, revision: ready.revision, binding };
  }
  let writes = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input)); const method = init?.method ?? "GET"; const cookie = new Headers(init?.headers).has("cookie");
    if (method !== "GET") {
      expect(journal.find(intent.invocationId)?.phase).toBe("dispatched"); writes++;
      if (scenario === "avatar-lost") throw new TypeError("Synthetic lost native response");
      return avatar ? Response.json({ cropperOffsetX: 0, cropperOffsetY: 0, cropperWidth: 32, needsCropping: false }, { status: 201 }) : Response.json({ session: COOKIE });
    }
    if (writes > 0) expect(journal.find(intent.invocationId)?.phase).toBe("acknowledged");
    if (url.pathname === "/context/rest/api/2/myself") return Response.json({ key: scenario === "login-proof" && cookie ? "different-actor" : binding.actorUserKey, name: binding.actorUsername });
    if (url.pathname === "/context/rest/auth/1/session") return Response.json({ name: binding.actorUsername });
    if (url.pathname === "/context/rest/api/2/project/100") return Response.json({ id: "100", key: "SYN", name: "Synthetic project" });
    throw new TypeError("Unexpected synthetic journal prerequisite");
  });
  const compare = privateState.vault.compareAndSet;
  privateState.vault.compareAndSet = (reference, previous, next) => {
    const failStore = writes > 0 && ((scenario === "login-store" && next?.includes('"cookie":')) || (scenario === "avatar-store" && next?.includes('"temporary":')));
    if (failStore) {
      expect(journal.find(intent.invocationId)?.phase).toBe("acknowledged");
      throw new TypeError("Synthetic persistence failure after native acknowledgement");
    }
    return compare(reference, previous, next);
  };
  const context = { invocationId: intent.invocationId, correlationId: intent.correlationId, signal: new AbortController().signal, beforeEffect: () => true };
  const options = { baseUrl: BASE, authRef: binding.authRef, credentials: privateState.executionResolver, fetchImpl };
  const filePorts: JiraManagedConnection["avatars"] = {
    sourceFor: () => async () => ({ ok: true, content: { name: AVATAR_FIXTURE_FILE.name, sha256: AVATAR_FIXTURE_FILE.sha256, bytes: AVATAR_FIXTURE_BYTES } }),
    inspectImage: async () => ({ ok: true, value: { mimeType: "image/png" } }),
  };
  const args = avatar ? { ...AVATAR_MUTATION_FIXTURE_CASES[4].args, expectedActorKey: binding.actorUserKey } : { expectedActorKey: binding.actorUserKey };
  const execution: JiraChatMutationExecution = { journal, intent, beforeEffect: () => true, beforeMutation: () => true,
    httpPortFactory: (lifecycle) => createGatewayAtlassianHttpBodyPort({ ...options, ...lifecycle }),
    execute: async (http, lifecycle) => {
      const privatePorts = createJiraPrivatePorts({ ...options, ...lifecycle }, { ...options, ...lifecycle }, context,
        { ...(selection === undefined ? {} : { selection }), sessionScope: jiraSessionBindingForInput(binding) });
      let attempted: JiraMutationAttempt = { ok: false, reason: "unavailable" };
      const provider = createJiraProviderForCatalog(() => ({ deployment: "data-center", baseUrl: BASE, http, avatars: filePorts }), [operation],
        async (_operation, _args, _context, executeNative) => {
          attempted = await executeNative(http, undefined, { privateIdentity: privatePorts.identity, avatars: { withSession: privatePorts.withAvatarSession } });
          return { data: { outcome: "pending" } };
        });
      const tool = provider.tools()[0]; if (tool === undefined) throw new TypeError("Missing actual private operation");
      await tool.execute(args, context); return attempted;
    },
  };
  return { store, journal, execution, fetchImpl, writeCount: () => writes };
}
describe("private native ports share the real Chat mutation journal", () => {
  it.each(["login-proof", "login-store", "avatar-store", "avatar-lost"] as const)("persists %s uncertainty and never dispatches again after reload", async (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-private-journal-")); const path = join(directory, "ui.sqlite");
    try {
      const f = await fixture(path, scenario);
      const outcome = scenario === "avatar-lost" ? "unknown" : "succeeded-unconfirmed";
      try {
        expect(await executeJiraChatMutation(f.execution)).toMatchObject({ data: { outcome, actorUserKey: "actor-key" } });
        expect(f.writeCount()).toBe(1);
        expect(f.journal.find(f.execution.intent.invocationId)).toMatchObject({ phase: "settled", outcome });
      } finally { f.store.close(); }
      const reopened = createNodeUiStore(path);
      try {
        const execute = vi.fn(f.execution.execute);
        expect(await executeJiraChatMutation({ ...f.execution, journal: reopened.chatToolMutations, execute })).toMatchObject({ data: { outcome, replayed: true } });
        expect(execute).not.toHaveBeenCalled(); expect(f.writeCount()).toBe(1);
      } finally { reopened.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
