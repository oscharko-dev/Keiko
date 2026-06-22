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
// NOTE (audit visibility): keiko-server has no global persistent QI audit ledger today — the
// user-initiated DELETE route "forwards" its receipt by returning it in the HTTP response to the
// caller. The bootstrap purge has no HTTP caller, so the default sink is a no-op: production startup
// purge receipts are currently DROPPED pending a future audit-ledger wiring (recorded in ADR-0048).
// The sink is injectable so tests assert forwarding and a future ledger can be wired in one place.

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

// Default sink: drop the event. keiko-server has no global persistent QI audit ledger today (see
// module note); production startup purge receipts are currently DROPPED pending a future ledger.
const noopAuditSink: QiRetentionAuditSink = (_event): void => {
  // Intentionally no-op until a persistent QI audit ledger seam exists (ADR-0048 follow-up).
};

export interface EnforceQiRetentionOptions {
  readonly evidenceDir: string;
  // Injectable clock for deterministic tests; defaults to wall-clock inside the evidence orchestrator.
  readonly now?: (() => number) | undefined;
  // Forwarding target for each deletion's audit event. Defaults to a no-op (see module note).
  readonly auditSink?: QiRetentionAuditSink | undefined;
}

/**
 * Run QI run-retention once at server startup. Best-effort: any fault is swallowed so it never
 * crashes bootstrap. Forwards each deletion receipt's audit event to `auditSink` exactly once.
 */
export function enforceQiRetentionAtStartup(options: EnforceQiRetentionOptions): void {
  const sink = options.auditSink ?? noopAuditSink;
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
