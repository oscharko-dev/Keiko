import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  BROWSER_APPROVAL_MAX_RECORDS,
  BROWSER_APPROVAL_REMEMBER_TTL_MS,
  isBrowserApprovalId,
  isBrowserApprovalOrigin,
  isBrowserApprovalPublicKey,
  type BrowserApprovalPublicKey,
} from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { withImmediateTransaction } from "./transaction.js";

/** Public identity only: never a cookie, private key, proof, or reusable bearer. */
export interface StoredBrowserApproval {
  readonly approvalId: string;
  readonly publicKey: BrowserApprovalPublicKey;
  readonly origin: string;
  readonly approvedAtMs: number;
  readonly expiresAtMs: number;
  readonly lastUsedAtMs: number;
}

export interface BrowserApprovalStore {
  readonly installationId: () => string;
  readonly observeTime: (nowMs: number) => boolean;
  readonly list: () => readonly StoredBrowserApproval[];
  readonly insert: (approval: StoredBrowserApproval) => boolean;
  readonly touch: (approvalId: string, nowMs: number) => boolean;
  readonly remove: (approvalId: string) => boolean;
}

interface ApprovalRow {
  readonly approval_id: string;
  readonly public_x: string;
  readonly public_y: string;
  readonly origin: string;
  readonly approved_at: number;
  readonly expires_at: number;
  readonly last_used_at: number;
}

function assertApproval(approval: StoredBrowserApproval): void {
  const times = [approval.approvedAtMs, approval.expiresAtMs, approval.lastUsedAtMs];
  if (
    !isBrowserApprovalId(approval.approvalId) ||
    !isBrowserApprovalPublicKey(approval.publicKey) ||
    !isBrowserApprovalOrigin(approval.origin) ||
    !times.every((time) => Number.isSafeInteger(time) && time >= 0) ||
    approval.lastUsedAtMs < approval.approvedAtMs ||
    approval.lastUsedAtMs >= approval.expiresAtMs ||
    approval.expiresAtMs - approval.approvedAtMs > BROWSER_APPROVAL_REMEMBER_TTL_MS
  ) {
    throw new TypeError("Invalid stored browser approval");
  }
}

function readApprovals(db: DatabaseSync): readonly StoredBrowserApproval[] {
  const rows = db
    .prepare("SELECT * FROM browser_approvals ORDER BY approved_at, approval_id LIMIT ?")
    .all(BROWSER_APPROVAL_MAX_RECORDS + 1) as unknown as readonly ApprovalRow[];
  if (rows.length > BROWSER_APPROVAL_MAX_RECORDS)
    throw new TypeError("Browser approval capacity exceeded");
  return rows.map((row): StoredBrowserApproval => {
    const approval = {
      approvalId: row.approval_id,
      publicKey: { x: row.public_x, y: row.public_y },
      origin: row.origin,
      approvedAtMs: row.approved_at,
      expiresAtMs: row.expires_at,
      lastUsedAtMs: row.last_used_at,
    };
    assertApproval(approval);
    return approval;
  });
}

function installationId(db: DatabaseSync): string {
  return withImmediateTransaction(db, (): string => {
    db.prepare(
      "INSERT OR IGNORE INTO browser_approval_installation (singleton, installation_id) VALUES (1, ?)",
    ).run(randomBytes(16).toString("hex"));
    const row = db
      .prepare("SELECT installation_id FROM browser_approval_installation WHERE singleton = 1")
      .get() as { installation_id: string };
    if (!/^[a-f0-9]{32}$/u.test(row.installation_id))
      throw new TypeError("Invalid browser approval installation identity");
    return row.installation_id;
  });
}

function insertApproval(db: DatabaseSync, approval: StoredBrowserApproval): boolean {
  assertApproval(approval);
  return withImmediateTransaction(db, (): boolean => {
    db.prepare("DELETE FROM browser_approvals WHERE expires_at <= ?").run(approval.approvedAtMs);
    if (readApprovals(db).length >= BROWSER_APPROVAL_MAX_RECORDS) return false;
    return (
      db
        .prepare(
          `INSERT OR IGNORE INTO browser_approvals
          (approval_id, public_x, public_y, origin, approved_at, expires_at, last_used_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          approval.approvalId,
          approval.publicKey.x,
          approval.publicKey.y,
          approval.origin,
          approval.approvedAtMs,
          approval.expiresAtMs,
          approval.lastUsedAtMs,
        ).changes === 1
    );
  });
}

export function createBrowserApprovalStore(db: DatabaseSync): BrowserApprovalStore {
  return {
    installationId: (): string => installationId(db),
    observeTime: (nowMs): boolean =>
      Number.isSafeInteger(nowMs) &&
      nowMs >= 0 &&
      db
        .prepare(
          "UPDATE browser_approval_installation SET observed_at = ? WHERE singleton = 1 AND observed_at <= ?",
        )
        .run(nowMs, nowMs).changes === 1,
    list: (): readonly StoredBrowserApproval[] => readApprovals(db),
    insert: (approval): boolean => insertApproval(db, approval),
    touch: (approvalId, nowMs): boolean =>
      Number.isSafeInteger(nowMs) &&
      db
        .prepare(
          `UPDATE browser_approvals SET last_used_at = ?
          WHERE approval_id = ? AND last_used_at <= ? AND expires_at > ?`,
        )
        .run(nowMs, approvalId, nowMs, nowMs).changes === 1,
    remove: (approvalId): boolean =>
      db.prepare("DELETE FROM browser_approvals WHERE approval_id = ?").run(approvalId).changes ===
      1,
  };
}
