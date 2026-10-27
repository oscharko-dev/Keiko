import type { DatabaseSync } from "node:sqlite";
import { canonicalise } from "@oscharko-dev/keiko-security";
import {
  parseChatReadGrantEntry,
  type ChatReadGrantEntry,
  type ChatReadGrantStore,
} from "../atlassian/chatReadGrantState.js";
import {
  ATLASSIAN_ACTION_APPROVAL_MAX_PENDING,
  ATLASSIAN_ACTION_APPROVAL_TTL_MS,
} from "../atlassian/actionApprovalLimits.js";
import { withImmediateTransaction } from "./transaction.js";
import { UiStoreError } from "./errors.js";

function invalidRecord(): UiStoreError {
  return new UiStoreError("INTERNAL", "The retained Chat consent is unavailable.", 500);
}

function validated(value: unknown): ChatReadGrantEntry {
  const parsed = parseChatReadGrantEntry(value);
  if (
    parsed === undefined ||
    parsed.grant.expiresAt - parsed.grant.requestedAt > ATLASSIAN_ACTION_APPROVAL_TTL_MS
  )
    throw invalidRecord();
  return parsed;
}

function readGrants(db: DatabaseSync): readonly ChatReadGrantEntry[] {
  const rows = db
    .prepare(
      "SELECT grant_id, chat_id, entry_json FROM chat_tool_read_grants ORDER BY grant_id LIMIT ?",
    )
    .all(ATLASSIAN_ACTION_APPROVAL_MAX_PENDING + 1);
  if (rows.length > ATLASSIAN_ACTION_APPROVAL_MAX_PENDING) throw invalidRecord();
  return rows.map((row): ChatReadGrantEntry => {
    if (typeof row.entry_json !== "string") throw invalidRecord();
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.entry_json);
    } catch {
      throw invalidRecord();
    }
    const entry = validated(decoded);
    if (row.grant_id !== entry.grant.grantId || row.chat_id !== entry.grant.subject.chatId)
      throw invalidRecord();
    return entry;
  });
}

function saveGrant(
  db: DatabaseSync,
  entry: ChatReadGrantEntry,
  previous?: ChatReadGrantEntry,
): boolean {
  validated(entry);
  return withImmediateTransaction(db, (): boolean => {
    const encoded = canonicalise(entry);
    if (previous !== undefined) {
      validated(previous);
      if (!validTransition(previous, entry)) return false;
      return (
        db
          .prepare(
            "UPDATE chat_tool_read_grants SET entry_json = ? WHERE grant_id = ? AND entry_json = ?",
          )
          .run(encoded, entry.grant.grantId, canonicalise(previous)).changes === 1
      );
    }
    if (
      entry.grant.state !== "pending" ||
      readGrants(db).length >= ATLASSIAN_ACTION_APPROVAL_MAX_PENDING
    )
      return false;
    return (
      db
        .prepare(
          "INSERT OR IGNORE INTO chat_tool_read_grants(grant_id, chat_id, entry_json) VALUES (?, ?, ?)",
        )
        .run(entry.grant.grantId, entry.grant.subject.chatId, encoded).changes === 1
    );
  });
}

function validTransition(previous: ChatReadGrantEntry, next: ChatReadGrantEntry): boolean {
  const prior = previous.grant;
  const pinned = {
    ...next,
    grant: { ...next.grant, state: prior.state, consentProofDigest: prior.consentProofDigest },
  };
  if (canonicalise(previous) !== canonicalise(pinned)) return false;
  if (prior.state === "pending") return next.grant.state !== "pending";
  return (
    prior.state === "granted" &&
    (next.grant.state === "revoked" || next.grant.state === "expired") &&
    next.grant.consentProofDigest === prior.consentProofDigest
  );
}

/** The approval registry validates authority and logs each committed transition. */
export function createChatReadGrantStore(db: DatabaseSync): ChatReadGrantStore {
  return {
    list: (): readonly ChatReadGrantEntry[] => readGrants(db),
    save: (entry, previous): boolean => saveGrant(db, entry, previous),
    remove: (grantId): void => {
      db.prepare("DELETE FROM chat_tool_read_grants WHERE grant_id = ?").run(grantId);
    },
  };
}
