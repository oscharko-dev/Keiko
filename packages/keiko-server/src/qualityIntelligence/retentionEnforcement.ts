// QI retention-enforcement bootstrap seam (Issue #1323 AC4 — make retention policy ids operational).
//
// keiko-evidence ships the pure decision + hardened deletion + the `enforceQualityIntelligenceRetentionPolicy`
// orchestrator, but it is a LEAF: it never touches the audit ledger (ADR-0019 trust-rule 6). This
// module is the server-owned wrapper that (a) passes the SAME server-owned companion suffixes + figma
// snapshot side-file root the user-initiated DELETE route uses (single source of truth in
// retentionRoutes.ts), and (b) forwards every deletion receipt's audit event to an injectable sink.
//
// It is called ONCE per server instance from `buildUiHandlerDeps` (lazy, no timer — a setInterval
// would race the filesystem-backed store). It is best-effort and CRASH-AWARE: it never throws into
// bootstrap (mirrors migrateLocalConfigCredentials), so a transient fs fault simply re-runs next start.
//
// NOTE (audit visibility): keiko-server has no global persistent QI audit ledger today. Until that
// exists, startup purge receipts are durably appended to a small JSONL receipt file under the QI
// evidence directory. The sink is still injectable so tests and a future ledger can wire a stronger
// target in one place.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  enforceQualityIntelligenceRetentionPolicy,
  type QualityIntelligenceRunDeletedEvent,
} from "@oscharko-dev/keiko-evidence";
import {
  QI_SNAPSHOT_SIDE_FILE_ROOT_SUBDIR,
  QI_SUBDIR,
  SERVER_OWNED_COMPANION_SUFFIXES,
} from "./retentionRoutes.js";

export type QiRetentionAuditSink = (event: QualityIntelligenceRunDeletedEvent) => void;

export const QI_RETENTION_DELETION_AUDIT_LEDGER = "retention-deletion-audit.jsonl";

export const qiRetentionDeletionAuditLedgerPath = (evidenceDir: string): string =>
  join(evidenceDir, QI_SUBDIR, QI_RETENTION_DELETION_AUDIT_LEDGER);

const createJsonlAuditSink = (evidenceDir: string): QiRetentionAuditSink => {
  const qiDir = join(evidenceDir, QI_SUBDIR);
  const ledgerPath = qiRetentionDeletionAuditLedgerPath(evidenceDir);
  return (event): void => {
    mkdirSync(qiDir, { recursive: true, mode: 0o700 });
    appendFileSync(ledgerPath, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  };
};

export interface EnforceQiRetentionOptions {
  readonly evidenceDir: string;
  // Injectable clock for deterministic tests; defaults to wall-clock inside the evidence orchestrator.
  readonly now?: (() => number) | undefined;
  // Forwarding target for each deletion's audit event. Defaults to a durable local JSONL receipt log.
  readonly auditSink?: QiRetentionAuditSink | undefined;
}

/**
 * Run QI run-retention once at server startup. Best-effort: any fault is swallowed so it never
 * crashes bootstrap. Forwards each deletion receipt's audit event to `auditSink` exactly once.
 */
export function enforceQiRetentionAtStartup(options: EnforceQiRetentionOptions): void {
  const sink = options.auditSink ?? createJsonlAuditSink(options.evidenceDir);
  try {
    const { receipts } = enforceQualityIntelligenceRetentionPolicy({
      evidenceDir: options.evidenceDir,
      now: options.now,
      companionSuffixes: SERVER_OWNED_COMPANION_SUFFIXES,
      sideFileRoot: join(options.evidenceDir, QI_SUBDIR, QI_SNAPSHOT_SIDE_FILE_ROOT_SUBDIR),
    });
    for (const receipt of receipts) {
      sink(receipt.auditEvent);
    }
  } catch {
    // Best-effort bootstrap side-effect: a transient fs fault leaves the store untouched and the
    // next startup retries. Never propagates into server construction.
  }
}
