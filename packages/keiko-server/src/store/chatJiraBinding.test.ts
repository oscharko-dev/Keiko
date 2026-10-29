import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createInMemoryUiStore, createNodeUiStore, type UiStore, type Chat } from "./index.js";
import {
  createFileServerLogSink,
  createServerLogger,
  setServerLogger,
} from "../observability/index.js";
import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import {
  expectActivityLogProof,
  readPersistedActivityLog,
} from "../../../../tests/support/activity-log-proof.js";
import { previewChatScopeUpdate } from "./chats.js";
import { deriveChatGroundingScopeIdentity } from "./chat-grounding-scope-identity.js";
import { decodeJiraChatState } from "./chatJiraBinding.js";
import { buildRedactor } from "../deps.js";
import { createJiraProviderForCatalog } from "../atlassian/jiraManagedProvider.js";
import {
  createKeikoToolCatalog,
  compileToolProjection,
  type ToolResultValidationBinding,
} from "@oscharko-dev/keiko-tool-catalog";
import { NATIVE_TOOL_CATALOG_RUNTIME } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

const FIRST = "aa6262ad-003d-4440-8519-5b84c3f87f01";
const SECOND = "aa6262ad-003d-4440-8519-5b84c3f87f02";
let store: UiStore;
let project: string;
beforeEach(() => {
  project = mkdtempSync(join(realpathSync(tmpdir()), "keiko-chat-jira-"));
  store = createInMemoryUiStore();
  store.createProject(project);
});
afterEach(() => {
  store.close();
  rmSync(project, { recursive: true, force: true });
});

function target(
  podId = FIRST,
  authenticationGeneration = 1,
): {
  readonly verifiedJiraPod: { readonly podId: string; readonly authenticationGeneration: number };
} {
  return { verifiedJiraPod: { podId, authenticationGeneration } };
}

function historicalIssueBinding(): ToolResultValidationBinding {
  const tool = createJiraProviderForCatalog(() => {
    throw new Error("Persistence proof must not call Jira");
  }, ["jira.issue"]).tools()[0];
  if (tool === undefined) throw new Error("Missing real Jira issue descriptor");
  const profile = { id: "historical-jira", version: 1 };
  const catalog = createKeikoToolCatalog(
    [
      {
        profile,
        adapterDialect: { id: "gateway-json-schema", version: 1 },
        adapterRuntime: NATIVE_TOOL_CATALOG_RUNTIME,
        entries: [{ alias: "jira_issue", descriptor: tool.descriptor }],
      },
    ],
    [],
    { referenceTimeMs: 0 },
  );
  return {
    descriptor: tool.descriptor,
    projectionDigest: compileToolProjection(catalog, profile).projectionDigest,
  };
}

function historicalIssue(chatId: string, podId: string, browseUrl: string): void {
  const binding = historicalIssueBinding();
  const data = {
    outcome: "succeeded",
    items: [{ id: "10001", key: "SYN-1", summary: "Synthetic", browseUrl }],
  };
  store.updateChat(chatId, { jiraPodId: podId }, target(podId));
  const message = store.createMessage({
    chatId,
    role: "user",
    content: "Read SYN-1",
    timestamp: Date.now(),
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  const call = { id: `call-${podId}`, name: "jira_issue", arguments: { issueKey: "SYN-1" } };
  store.updateChatToolTranscript(message.id, { kind: "started", call }, "historical-source");
  store.updateChatToolTranscript(
    message.id,
    {
      kind: "settled",
      callId: call.id,
      binding,
      result: {
        schemaVersion: 1,
        invocationId: `invocation-${podId}`,
        toolRef: binding.descriptor.toolRef,
        projectionDigest: binding.projectionDigest,
        status: "completed",
        reason: "none",
        effectStarted: false,
        page: { truncated: false, reason: "none", cursor: null },
        data,
        metrics: {
          inputBytes: 10,
          outputBytes: Buffer.byteLength(JSON.stringify(data)),
          resultCount: 1,
          durationMs: 1,
        },
      },
    },
    "historical-source",
  );
}

it("keeps identical ticket keys attributable to their original Jira instance after replacement and reopen", () => {
  store.close();
  const dbPath = join(project, "historical-sources.db");
  const redactor = buildRedactor({});
  const options = { redactString: (value: string): string => String(redactor(value)) };
  store = createNodeUiStore(dbPath, options);
  store.createProject(project);
  const chat = store.createChat(project, "Historical Jira sources", "model");
  const urls = [
    "https://10.1.2.3:8443/context/browse/SYN-1",
    "https://10.4.5.6:8443/context/browse/SYN-1",
  ] as const;
  historicalIssue(chat.id, FIRST, urls[0]);
  historicalIssue(chat.id, SECOND, urls[1]);
  const messages = store.listMessages(chat.id);
  expect(messages.map((message) => message.toolTranscript?.exchanges[0]?.result?.data)).toEqual(
    urls.map((browseUrl) => ({
      outcome: "succeeded",
      items: [{ id: "10001", key: "SYN-1", summary: "Synthetic", browseUrl }],
    })),
  );
  expect(store.findChatById(chat.id)?.jiraPodBinding).toMatchObject({
    podId: SECOND,
    bindingGeneration: 2,
  });
  store.close();
  store = createNodeUiStore(dbPath, options);
  expect(store.listMessages(chat.id)).toEqual(messages);
  expect(store.findChatById(chat.id)?.jiraPodBinding?.podId).toBe(SECOND);
});

describe("Chat Jira binding persistence", () => {
  it("revokes all matching bindings atomically, retaining association across credential changes", () => {
    const first = store.createChat(project, "First", "model");
    const second = store.createChat(project, "Second", "model");
    const other = store.createChat(project, "Other", "model");
    const bound = store.updateChat(first.id, { jiraPodId: FIRST }, target());
    store.updateChat(second.id, { jiraPodId: FIRST }, target());
    const unrelated = store.updateChat(other.id, { jiraPodId: SECOND }, target(SECOND));
    expect(store.invalidateJiraPod(FIRST, 2)).toHaveLength(2);
    const changed = store.findChatById(first.id);
    expect(changed?.jiraPodBinding).toEqual({
      ...bound.jiraPodBinding,
      authenticationGeneration: 2,
      bindingGeneration: 2,
    });
    expect(changed?.groundingScopeIdentity).not.toBe(bound.groundingScopeIdentity);
    expect(store.invalidateJiraPod(FIRST, 2)).toEqual([]);
    expect(store.invalidateJiraPod(FIRST, 1)).toEqual([]);
    expect(store.findChatById(other.id)).toEqual(unrelated);
    expect(store.invalidateJiraPod(FIRST, null)).toHaveLength(2);
    expect(store.findChatById(first.id)).toMatchObject({ jiraBindingGeneration: 3 });
    expect(store.findChatById(first.id)?.jiraPodBinding).toBeUndefined();
    expect(store.invalidateJiraPod(FIRST, null)).toEqual([]);
    expect(store.findChatById(other.id)).toEqual(unrelated);
  });

  it("invalidates valid bindings despite unrelated corrupt JSON without making the corrupt Chat readable", () => {
    store.close();
    const dbPath = join(project, "corrupt-lifecycle.db");
    store = createNodeUiStore(dbPath);
    store.createProject(project);
    const valid = store.updateChat(
      store.createChat(project, "Valid", "model").id,
      { jiraPodId: FIRST },
      target(),
    );
    const broken = store.createChat(project, "Corrupted", "model");
    const raw = new DatabaseSync(dbPath);
    try {
      raw.prepare("UPDATE chats SET jira_state_json = ? WHERE id = ?").run("{invalid", broken.id);
    } finally {
      raw.close();
    }
    expect(store.invalidateJiraPod(FIRST, null)).toHaveLength(1);
    expect(store.findChatById(valid.id)?.jiraPodBinding).toBeUndefined();
    expect(store.findChatById(valid.id)?.jiraBindingGeneration).toBe(2);
    expect(() => store.findChatById(broken.id)).toThrow("Stored Jira Chat state is invalid");
  });

  it("rolls back every matching Chat when one generation cannot advance", () => {
    store.close();
    const dbPath = join(project, "lifecycle.db");
    store = createNodeUiStore(dbPath);
    store.createProject(project);
    const first = store.updateChat(
      store.createChat(project, "First", "model").id,
      { jiraPodId: FIRST },
      target(),
    );
    const last = store.updateChat(
      store.createChat(project, "Last", "model").id,
      { jiraPodId: FIRST },
      target(),
    );
    const raw = new DatabaseSync(dbPath);
    try {
      raw.prepare("UPDATE chats SET jira_state_json = ? WHERE id = ?").run(
        JSON.stringify({
          schemaVersion: 1,
          generation: Number.MAX_SAFE_INTEGER,
          mode: "governed-assist",
          binding: { ...last.jiraPodBinding, bindingGeneration: Number.MAX_SAFE_INTEGER },
        }),
        last.id,
      );
    } finally {
      raw.close();
    }
    expect(() => store.invalidateJiraPod(FIRST, 2)).toThrow("generation is exhausted");
    expect(store.findChatById(first.id)).toEqual(first);
    expect(store.findChatById(last.id)?.jiraBindingGeneration).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects invalid lifecycle generations before altering any binding", () => {
    const chat = store.createChat(project, "First", "model");
    const bound = store.updateChat(chat.id, { jiraPodId: FIRST }, target());
    for (const generation of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => store.invalidateJiraPod(FIRST, generation)).toThrow();
      expect(store.findChatById(chat.id)).toEqual(bound);
    }
  });

  it("restores the saved selection and binding on reopen, and rejects corrupt persisted generations", () => {
    const dbPath = join(project, "ui.db");
    const disk = createNodeUiStore(dbPath);
    const saved = ((): Chat => {
      try {
        disk.createProject(project);
        const chat = disk.createChat(project, "Saved", "model");
        return disk.updateChat(
          chat.id,
          { jiraPodId: FIRST, toolMode: "autonomous-delivery" },
          target(),
        );
      } finally {
        disk.close();
      }
    })();
    const reopened = createNodeUiStore(dbPath);
    try {
      expect(reopened.findChatById(saved.id)).toEqual(saved);
    } finally {
      reopened.close();
    }
    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare("UPDATE chats SET jira_state_json = ? WHERE id = ?")
        .run('{"schemaVersion":1,"generation":-1,"mode":"autonomous-delivery"}', saved.id);
    } finally {
      raw.close();
    }
    const corrupted = createNodeUiStore(dbPath);
    try {
      expect(() => corrupted.findChatById(saved.id)).toThrow("Stored Jira Chat state is invalid");
    } finally {
      corrupted.close();
    }
  });
  it("defaults to Ask and preserves the legacy Data-Pod scope identity", () => {
    const chat = store.createChat(project, "Synthetic", "model");
    expect(chat.toolMode).toBe("governed-assist");
    expect(chat.jiraBindingGeneration).toBe(0);
    const { toolMode: _mode, jiraBindingGeneration: _generation, ...legacy } = chat;
    expect(chat.groundingScopeIdentity).toBe(deriveChatGroundingScopeIdentity(legacy));
  });

  it("rejects an unverified, mismatched or malformed target without changing the row", () => {
    const chat = store.createChat(project, "Synthetic", "model");
    for (const options of [undefined, target(SECOND), target(FIRST, 0)]) {
      expect(() => store.updateChat(chat.id, { jiraPodId: FIRST }, options)).toThrow();
      expect(store.findChatById(chat.id)).toEqual(chat);
    }
  });

  it("binds exactly one Pod and preserves monotonic generations across replacement and disconnect", () => {
    const chat = store.createChat(project, "Synthetic", "model");
    const first = store.updateChat(chat.id, { jiraPodId: FIRST }, target());
    expect(first.jiraPodBinding).toMatchObject({
      podId: FIRST,
      bindingGeneration: 1,
      authenticationGeneration: 1,
    });
    expect(first.groundingScopeIdentity).not.toBe(chat.groundingScopeIdentity);
    expect(store.updateChat(chat.id, { jiraPodId: FIRST }, target()).jiraPodBinding).toEqual(
      first.jiraPodBinding,
    );
    const second = store.updateChat(chat.id, { jiraPodId: SECOND }, target(SECOND));
    expect(second.jiraPodBinding).toMatchObject({ podId: SECOND, bindingGeneration: 2 });
    const detached = store.updateChat(chat.id, { jiraPodId: null });
    expect(detached.jiraPodBinding).toBeUndefined();
    expect(detached.jiraBindingGeneration).toBe(3);
    const rebound = store.updateChat(chat.id, { jiraPodId: FIRST }, target());
    expect(rebound.jiraPodBinding?.bindingGeneration).toBe(4);
    expect(rebound.groundingScopeIdentity).not.toBe(first.groundingScopeIdentity);
  });

  it("changes identity for mode or authentication-generation changes", () => {
    const chat = store.createChat(project, "Synthetic", "model");
    const first = store.updateChat(chat.id, { jiraPodId: FIRST }, target());
    const mode = store.updateChat(chat.id, { toolMode: "autonomous-delivery" });
    expect(mode.toolMode).toBe("autonomous-delivery");
    expect(mode.jiraPodBinding?.bindingGeneration).toBe(2);
    expect(mode.groundingScopeIdentity).not.toBe(first.groundingScopeIdentity);
    const rotated = store.updateChat(chat.id, { jiraPodId: FIRST }, target(FIRST, 2));
    expect(rotated.jiraPodBinding).toMatchObject({
      bindingGeneration: 3,
      authenticationGeneration: 2,
    });
    expect(rotated.groundingScopeIdentity).not.toBe(mode.groundingScopeIdentity);
    expect(store.findChatById(chat.id)).toEqual(rotated);
  });

  it("rechecks the expected scope inside the transaction and rolls back the complete patch", () => {
    const chat = store.createChat(project, "Synthetic", "model");
    const bound = store.updateChat(chat.id, { jiraPodId: FIRST }, target());
    expect(() =>
      store.updateChat(
        chat.id,
        {
          jiraPodId: SECOND,
          title: "Stale",
          expectedGroundingScopeIdentity: deriveChatGroundingScopeIdentity(chat),
        },
        target(SECOND),
      ),
    ).toThrow(expect.objectContaining({ code: "GROUNDING_SCOPE_CHANGED", status: 409 }));
    expect(store.findChatById(chat.id)).toEqual(bound);
  });

  it.each([
    '"private-corrupt-payload',
    "null",
    "{}",
    '{"schemaVersion":1,"generation":-1,"mode":"governed-assist"}',
    '{"schemaVersion":1,"generation":1,"mode":"full"}',
  ])("fails closed on corrupt stored authority state: %s", (json) => {
    expect(() => decodeJiraChatState(json)).toThrow("Stored Jira Chat state is invalid.");
  });

  it("persists body-free binding/mode evidence through the registered writer and reader", () => {
    const sink = createFileServerLogSink(project, { level: "debug" });
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    try {
      const chat = store.createChat(project, "Private title", "model");
      store.updateChat(
        chat.id,
        { jiraPodId: FIRST },
        { ...target(), correlationId: "jira-binding-proof" },
      );
      store.updateChat(chat.id, { toolMode: "supervised-coding" });
      store.updateChat(chat.id, { jiraPodId: null });
      sink.close?.();
      const text = readPersistedActivityLog(project);
      const lines = text
        .split("\n")
        .filter(Boolean)
        .filter((line) => (JSON.parse(line) as { op?: string }).op === "chat.scope.update")
        .map((line) => expectActivityLogProof("chat.scope.update.outcome", line));
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatchObject({
        correlationId: "jira-binding-proof",
        jiraSourceCount: 1,
        jiraBindingGeneration: 1,
        toolMode: "governed-assist",
      });
      expect(lines[2]).toMatchObject({
        jiraSourceCount: 0,
        jiraBindingGeneration: 3,
        toolMode: "supervised-coding",
      });
      expect(text).not.toContain(FIRST);
      expect(text).not.toContain("Private title");
    } finally {
      sink.close?.();
      resetServerLogger();
    }
  });

  it("computes the same admission preview and committed scope identity without granting consent", () => {
    const chat = store.createChat(project, "Synthetic", "model");
    const patch = { jiraPodId: FIRST, toolMode: "supervised-coding" } as const;
    const preview = previewChatScopeUpdate(chat, patch, target());
    const saved = store.updateChat(chat.id, patch, target());
    expect(deriveChatGroundingScopeIdentity(preview)).toBe(saved.groundingScopeIdentity);
    expect(saved.jiraBindingGeneration).toBe(1);
    const other = store.createChat(project, "Other", "model");
    expect(other.jiraPodBinding).toBeUndefined();
    expect(other.jiraBindingGeneration).toBe(0);
  });
});
