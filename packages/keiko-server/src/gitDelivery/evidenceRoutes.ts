// Governed Git mutation EVIDENCE export route (Issue #474, Epic #470).
//
// Single additive, READ-ONLY HTTP handler:
//   * GET /api/git-delivery/evidence
//
// It returns the exportable GitDeliveryAuditPacket — the redacted records, per-class and
// per-disposition counts, and the honest known-limitations list — that compliance and support
// workflows inspect without replaying raw logs or shell transcripts. It mutates nothing and reads
// only the bounded, date-bucketed evidence ledger written by mutationEvidenceLedger.ts.
//
// ACCESS (AC: the authority is the deployment's): the surface is gated by the SAME default-false
// deployment env flag as the rest of the #470 surface (isGitDeliveryTrusted). A GET is not
// state-changing, so the central CSRF guard does not cover it — gating is the env flag, and an
// untrusted deployment gets a content-free 404 (the audit surface is simply absent), never an empty
// payload that would imply the surface exists.
//
// DEFENCE IN DEPTH: every record is re-validated through the contract guard and the whole packet is
// re-run through deps.redactor before it leaves the server, so a record that somehow escaped
// build-time or persist-time redaction is scrubbed on the way out, and a tampered/malformed record is
// dropped rather than served.

import {
  buildGitDeliveryAuditPacket,
  isGitDeliveryEvidenceRecord,
  type GitDeliveryEvidenceRecord,
} from "@oscharko-dev/keiko-contracts";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { isGitDeliveryTrusted } from "./capability.js";
import { GIT_DELIVERY_EVIDENCE_RUNID_PREFIX } from "./mutationEvidenceLedger.js";

// ─── Error envelope (typed, content-free) ────────────────────────────────────────────────

export type GitDeliveryEvidenceErrorCode = "GIT_DELIVERY_EVIDENCE_NOT_ENABLED";

const SAFE_MESSAGES: Readonly<Record<GitDeliveryEvidenceErrorCode, string>> = {
  GIT_DELIVERY_EVIDENCE_NOT_ENABLED: "The governed Git delivery evidence surface is not enabled.",
};

const errResult = (status: number, code: GitDeliveryEvidenceErrorCode): RouteResult => ({
  status,
  body: { error: { code, message: SAFE_MESSAGES[code] } },
});

// ─── Read-window bounds ──────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const DEFAULT_BUCKET_DAYS = 7;
const MAX_BUCKET_DAYS = 30;
const DEFAULT_EXPORT_RECORDS = 200;
const MAX_EXPORT_RECORDS = 500;

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

// Date-bucket run ids for the most recent `days` UTC days, OLDEST first so concatenated records stay
// chronological and the tail slice keeps the most recent.
function recentRunIds(nowMs: number, days: number): readonly string[] {
  const ids: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const iso = new Date(nowMs - offset * DAY_MS).toISOString();
    ids.push(`${GIT_DELIVERY_EVIDENCE_RUNID_PREFIX}${iso.slice(0, 10)}`);
  }
  return ids;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Reads a single bucket, dropping a corrupt/unparseable document rather than failing the whole export,
// and re-validating each record through the contract guard (tamper/malformation rejection on read).
function readBucket(store: EvidenceStore, runId: string): readonly GitDeliveryEvidenceRecord[] {
  const json = store.get(runId);
  if (json === undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.records)) {
    return [];
  }
  return parsed.records.filter(isGitDeliveryEvidenceRecord);
}

function collectRecords(
  store: EvidenceStore,
  runIds: readonly string[],
): readonly GitDeliveryEvidenceRecord[] {
  const out: GitDeliveryEvidenceRecord[] = [];
  for (const runId of runIds) {
    out.push(...readBucket(store, runId));
  }
  return out;
}

// ─── Handler ───────────────────────────────────────────────────────────────────────────

export interface GitDeliveryEvidenceRouteOptions {
  // Server clock (epoch ms). Injectable for deterministic tests; defaults to Date.now.
  readonly now?: (() => number) | undefined;
}

export const createHandleGitDeliveryEvidenceExport = (
  options: GitDeliveryEvidenceRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => RouteResult) => {
  const now = options.now ?? ((): number => Date.now());
  return (ctx, deps): RouteResult => {
    if (!isGitDeliveryTrusted(deps)) {
      return errResult(404, "GIT_DELIVERY_EVIDENCE_NOT_ENABLED");
    }
    const days = clampInt(
      ctx.url.searchParams.get("days"),
      DEFAULT_BUCKET_DAYS,
      1,
      MAX_BUCKET_DAYS,
    );
    const limit = clampInt(
      ctx.url.searchParams.get("limit"),
      DEFAULT_EXPORT_RECORDS,
      1,
      MAX_EXPORT_RECORDS,
    );
    const nowMs = now();
    const all = collectRecords(deps.evidenceStore, recentRunIds(nowMs, days));
    const truncated = all.length > limit;
    const records = truncated ? all.slice(all.length - limit) : all;
    const windowNote =
      `This export is a bounded window: the most recent ${String(records.length)} record(s) ` +
      `across the last ${String(days)} day(s)` +
      (truncated ? `, truncated to the ${String(limit)}-record limit.` : ".");
    const packet = buildGitDeliveryAuditPacket(records, nowMs, [windowNote]);
    return { status: 200, body: deps.redactor(packet) };
  };
};

export const handleGitDeliveryEvidenceExport = createHandleGitDeliveryEvidenceExport();

// Mechanically-mergeable route group. routes.ts spreads this into API_ROUTES alongside
// GIT_DELIVERY_ACTION_SHEET_ROUTE_GROUP so concurrent #470 epic merges stay merge-safe.
export const GIT_DELIVERY_EVIDENCE_ROUTE_GROUP: readonly RouteDefinition[] = [
  {
    method: "GET",
    pattern: "/api/git-delivery/evidence",
    handler: handleGitDeliveryEvidenceExport,
  },
];
