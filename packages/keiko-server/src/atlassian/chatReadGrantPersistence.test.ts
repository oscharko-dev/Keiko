import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { createNodeUiStore, type UiStore } from "../store/index.js";
import { AtlassianActionApprovalRegistry } from "./actionApprovals.js";
import type { ChatReadGrantEntry, ChatReadGrantStore } from "./chatReadGrantState.js";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const stores: UiStore[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(): {
  readonly path: string;
  readonly store: UiStore;
  readonly entry: ChatReadGrantEntry;
} {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "keiko-read-consent-"));
  directories.push(directory);
  const path = join(directory, "ui.db");
  const store = open(path);
  store.createProject(directory);
  const chat = store.createChat(directory, "Consent fixture", "synthetic-model");
  return {
    path,
    store,
    entry: {
      authority: { runId: "synthetic-turn", envelopeDigest: "a".repeat(64) },
      grant: {
        schemaVersion: "1",
        kind: "jira-chat-read-grant",
        grantId: "synthetic-read-consent",
        subject: {
          actorDigest: "b".repeat(64),
          chatId: chat.id,
          podId: "d5f5681e-ce98-4c3c-b27e-51d707c9d018",
          bindingGeneration: 1,
          authenticationGeneration: 1,
        },
        disclosureVersion: "jira-chat-read-v1",
        requestedAt: NOW,
        expiresAt: NOW + 60_000,
        state: "pending",
        consentProofDigest: null,
      },
    },
  };
}

function open(path: string): UiStore {
  const store = createNodeUiStore(path);
  stores.push(store);
  return store;
}

function persistence(store: UiStore): ChatReadGrantStore {
  if (store.chatToolReadGrants === undefined) throw new Error("Missing consent persistence");
  return store.chatToolReadGrants;
}

function accepted(f: ReturnType<typeof fixture>): AtlassianActionApprovalRegistry {
  const registry = new AtlassianActionApprovalRegistry(() => NOW, persistence(f.store));
  expect(registry.createChatReadGrant(f.entry).ok).toBe(true);
  expect(
    registry.acceptChatReadGrant(
      f.entry.grant.grantId,
      f.entry.grant.subject,
      f.entry.authority,
      "c".repeat(64),
    ).ok,
  ).toBe(true);
  return registry;
}

it("retains accepted private consent after closing and reopening its actual SQLite owner", () => {
  const f = fixture();
  const first = new AtlassianActionApprovalRegistry(() => NOW, f.store.chatToolReadGrants);
  expect(first.createChatReadGrant(f.entry)).toEqual({ ok: true });
  expect(
    first.acceptChatReadGrant(
      f.entry.grant.grantId,
      f.entry.grant.subject,
      f.entry.authority,
      "c".repeat(64),
    ).ok,
  ).toBe(true);
  f.store.close();
  stores.splice(stores.indexOf(f.store), 1);
  const reopened = open(f.path);
  const second = new AtlassianActionApprovalRegistry(() => NOW + 1, reopened.chatToolReadGrants);
  expect(second.findGrantedChatReadGrant(f.entry.grant.subject)).toEqual({
    ...f.entry.grant,
    state: "granted",
    consentProofDigest: "c".repeat(64),
  });
});

it("preserves granted consent but revokes pending decisions during clean shutdown", () => {
  const f = fixture();
  const first = accepted(f);
  const pending = { ...f.entry, grant: { ...f.entry.grant, grantId: "other-pending-consent" } };
  expect(first.createChatReadGrant(pending).ok).toBe(true);
  first.dispose();
  const second = new AtlassianActionApprovalRegistry(() => NOW + 1, persistence(f.store));
  expect(second.getChatReadGrant(f.entry.grant.grantId)?.grant.state).toBe("granted");
  expect(second.getChatReadGrant(pending.grant.grantId)?.grant.state).toBe("revoked");
});

it.each(["chat-revocation", "reset", "expiry"] as const)(
  "does not resurrect consent after %s",
  (change) => {
    const f = fixture();
    const first = accepted(f);
    const second = new AtlassianActionApprovalRegistry(() => NOW, persistence(f.store));
    expect(second.findGrantedChatReadGrant(f.entry.grant.subject)).toBeDefined();
    if (change === "reset") first.reset();
    if (change === "chat-revocation") first.revokeChatApprovals(f.entry.grant.subject.chatId);
    const current =
      change === "expiry"
        ? new AtlassianActionApprovalRegistry(() => f.entry.grant.expiresAt, persistence(f.store))
        : second;
    expect(current.findGrantedChatReadGrant(f.entry.grant.subject)).toBeUndefined();
  },
);

it("persists a decision before publishing it and refuses stale decisions or identity changes", () => {
  const f = fixture();
  const port = persistence(f.store);
  expect(port.save(f.entry)).toBe(true);
  const grant = { ...f.entry.grant, state: "granted", consentProofDigest: "c".repeat(64) } as const;
  if (grant.subject.kind === "configured-mcp") throw new Error("Expected Jira fixture");
  expect(
    port.save(
      { ...f.entry, grant: { ...grant, subject: { ...grant.subject, bindingGeneration: 2 } } },
      f.entry,
    ),
  ).toBe(false);
  expect(port.save({ ...f.entry, grant }, f.entry)).toBe(true);
  expect(
    port.save(
      { ...f.entry, grant: { ...f.entry.grant, state: "rejected", consentProofDigest: null } },
      f.entry,
    ),
  ).toBe(false);
  const acceptedEntry = port.list()[0];
  expect(acceptedEntry?.grant.state).toBe("granted");
  expect(port.save(f.entry, acceptedEntry)).toBe(false);
});

it.each(["invalid-json", "unknown-disclosure", "forged-subject"] as const)(
  "fails closed on %s persisted consent",
  (change) => {
    const f = fixture();
    accepted(f);
    const connection = new DatabaseSync(f.path);
    const entry = persistence(f.store).list()[0];
    if (entry === undefined) throw new Error("Missing accepted entry");
    const altered =
      change === "invalid-json"
        ? "{"
        : JSON.stringify({
            ...entry,
            grant: {
              ...entry.grant,
              ...(change === "unknown-disclosure"
                ? { disclosureVersion: "unknown" }
                : { subject: { ...entry.grant.subject, chatId: "another-chat" } }),
            },
          });
    try {
      connection.prepare("UPDATE chat_tool_read_grants SET entry_json = ?").run(altered);
    } finally {
      connection.close();
    }
    expect(() => persistence(f.store).list()).toThrow("retained Chat consent is unavailable");
  },
);

it("removes retained consent when its Chat is deleted", () => {
  const f = fixture();
  accepted(f);
  f.store.deleteChat(f.entry.grant.subject.chatId);
  expect(persistence(f.store).list()).toEqual([]);
});

it("drains shutdown waiters when another registry has already accepted the durable consent", async () => {
  const f = fixture();
  const first = new AtlassianActionApprovalRegistry(() => NOW, persistence(f.store));
  expect(first.createChatReadGrant(f.entry).ok).toBe(true);
  const controller = new AbortController();
  let finished = false;
  const pending = first.waitForChatReadGrant(f.entry.grant.grantId, controller.signal).then(() => {
    finished = true;
  });
  try {
    const second = new AtlassianActionApprovalRegistry(() => NOW, persistence(f.store));
    expect(
      second.acceptChatReadGrant(
        f.entry.grant.grantId,
        f.entry.grant.subject,
        f.entry.authority,
        "c".repeat(64),
      ).ok,
    ).toBe(true);
    first.dispose();
    await Promise.resolve();
    expect(finished).toBe(true);
    expect(second.getChatReadGrant(f.entry.grant.grantId)?.grant.state).toBe("granted");
  } finally {
    controller.abort();
    await pending;
  }
});
