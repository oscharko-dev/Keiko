import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import { buildUiStoreOverDatabase } from "./index.js";
import { runMigrations } from "./schema.js";
import { AtlassianActionApprovalRegistry } from "../atlassian/actionApprovals.js";
import { projectChatReadGrant, type ChatReadGrantEntry } from "../atlassian/chatReadGrantState.js";
import { processServerLogSink } from "../process-log-sink.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.restoreAllMocks();
});

function fixture(): {
  readonly db: DatabaseSync;
  readonly store: ReturnType<typeof buildUiStoreOverDatabase>;
  readonly messageId: string;
  readonly entry: ChatReadGrantEntry;
  readonly registry: AtlassianActionApprovalRegistry;
  readonly logs: ReturnType<typeof createBufferedServerLogSink>;
} {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  const store = buildUiStoreOverDatabase(db);
  disposals.push(() => {
    store.close();
  });
  const logs = createBufferedServerLogSink();
  vi.spyOn(processServerLogSink(), "write").mockImplementation((event) => {
    logs.write(event);
  });
  const project = store.createProject(process.cwd());
  const chat = store.createChat(project.path, "Synthetic consent", "synthetic");
  const turn = store.admitChatTurn("consent-projection-turn", {
    chatId: chat.id,
    role: "user",
    content: "Read Jira",
    timestamp: Date.now() - 1000,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  if (turn.kind !== "admitted") throw new Error("Expected canonical turn");
  const messageId = turn.userMessage.id;
  const entry: ChatReadGrantEntry = {
    authority: {
      runId: `chat-${sha256Hex(canonicalise({ chatId: chat.id, userMessageId: messageId }))}`,
      envelopeDigest: "a".repeat(64),
    },
    grant: {
      schemaVersion: "1",
      kind: "jira-chat-read-grant",
      grantId: "synthetic-consent",
      subject: {
        actorDigest: "b".repeat(64),
        chatId: chat.id,
        podId: "d5f5681e-ce98-4c3c-b27e-51d707c9d018",
        bindingGeneration: 1,
        authenticationGeneration: 1,
      },
      disclosureVersion: "jira-chat-read-v1",
      requestedAt: Date.now() - 500,
      expiresAt: Date.now() + 60_000,
      state: "pending",
      consentProofDigest: null,
    },
  };
  const registry = new AtlassianActionApprovalRegistry(Date.now, store.chatToolReadGrants);
  expect(registry.createChatReadGrant(entry).ok).toBe(true);
  store.updateChatToolTranscript(
    messageId,
    {
      kind: "read-consent",
      grant: projectChatReadGrant(entry.grant),
    },
    "consent-history-proof",
  );
  expect(
    registry.acceptChatReadGrant(
      entry.grant.grantId,
      entry.grant.subject,
      entry.authority,
      "c".repeat(64),
    ).ok,
  ).toBe(true);
  return { db, store, messageId, entry, registry, logs };
}

it("recovers the exact accepted consent after a crash before transcript acknowledgement, read only", () => {
  const f = fixture();
  const stored = f.db
    .prepare("SELECT tool_transcript_json FROM chat_messages WHERE id = ?")
    .get(f.messageId);
  expect(f.store.findMessageById(f.messageId)?.toolTranscript?.readGrant?.state).toBe("granted");
  expect(f.store.findMessageById(f.messageId)?.turnState).toBe("pending");
  expect(
    f.db.prepare("SELECT tool_transcript_json FROM chat_messages WHERE id = ?").get(f.messageId),
  ).toEqual(stored);
  const event = f.logs.events.find(
    (candidate) =>
      candidate.op === "chat.tool-authority.operation" &&
      candidate.correlationId === sha256Hex(f.messageId),
  );
  const line = formatActivityLogProofLine(event ?? {});
  expectActivityLogProof("chat.tool-authority.operation.read-grant-admission", line);
  expect(analyzeLogText(line).timelines).toMatchObject([
    { correlationId: sha256Hex(f.messageId), lines: [{ op: "chat.tool-authority.operation" }] },
  ]);
  expect(line).not.toContain(f.messageId);
  expect(line).not.toContain(f.entry.grant.grantId);
});

it.each(["origin", "pod", "binding", "credentials", "requested-at", "expiry"] as const)(
  "does not recover a decision with mismatched %s provenance",
  (change) => {
    const f = fixture();
    const entry = f.registry.getChatReadGrant(f.entry.grant.grantId);
    if (entry === undefined) throw new Error("Missing retained decision");
    const altered = mismatchedEntry(entry, change);
    f.db
      .prepare("UPDATE chat_tool_read_grants SET entry_json = ? WHERE grant_id = ?")
      .run(canonicalise(altered), entry.grant.grantId);
    expect(f.store.findMessageById(f.messageId)?.toolTranscript?.readGrant?.state).toBe("pending");
  },
);

function mismatchedEntry(entry: ChatReadGrantEntry, change: string): ChatReadGrantEntry {
  const subject = entry.grant.subject;
  if (subject.kind === "configured-mcp") throw new Error("Expected Jira fixture");
  const changes: Readonly<Record<string, Partial<typeof entry.grant>>> = {
    pod: { subject: { ...subject, podId: "d5f5681e-ce98-4c3c-b27e-51d707c9d019" } },
    binding: { subject: { ...subject, bindingGeneration: subject.bindingGeneration + 1 } },
    credentials: {
      subject: { ...subject, authenticationGeneration: subject.authenticationGeneration + 1 },
    },
    "requested-at": { requestedAt: entry.grant.requestedAt + 1 },
    expiry: { expiresAt: entry.grant.expiresAt + 1 },
  };
  return {
    ...entry,
    authority: change === "origin" ? { ...entry.authority, runId: "other-turn" } : entry.authority,
    grant: { ...entry.grant, ...changes[change] } as ChatReadGrantEntry["grant"],
  };
}

it("does not attach another message's consent even inside the same Chat", () => {
  const f = fixture();
  const turn = f.store.admitChatTurn("different-canonical-turn", {
    chatId: f.entry.grant.subject.chatId,
    role: "user",
    content: "Read Jira again",
    timestamp: Date.now(),
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  if (turn.kind !== "admitted") throw new Error("Expected another canonical turn");
  f.store.updateChatToolTranscript(
    turn.userMessage.id,
    {
      kind: "read-consent",
      grant: projectChatReadGrant(f.entry.grant),
    },
    "consent-history-proof",
  );
  expect(f.store.findMessageById(turn.userMessage.id)?.toolTranscript?.readGrant?.state).toBe(
    "pending",
  );
  expect(f.store.findMessageById(f.messageId)?.toolTranscript?.readGrant?.state).toBe("granted");
});

it("projects expiry without reviving consent or changing its durable decision", () => {
  const f = fixture();
  vi.spyOn(Date, "now").mockReturnValue(f.entry.grant.expiresAt);
  expect(f.store.findMessageById(f.messageId)?.toolTranscript?.readGrant?.state).toBe("expired");
  expect(f.store.chatToolReadGrants?.list()[0]?.grant.state).toBe("granted");
});

it("does not replace a terminal historical rejection with a granted projection", () => {
  const f = fixture();
  f.store.updateChatToolTranscript(
    f.messageId,
    {
      kind: "read-consent",
      grant: { ...projectChatReadGrant(f.entry.grant), state: "rejected" },
    },
    "consent-history-proof",
  );
  expect(f.store.findMessageById(f.messageId)?.toolTranscript?.readGrant?.state).toBe("rejected");
});
