// Content-free fetch/pull sync EVIDENCE ledger (Issue #1573, Epic #1572).
//
// fetch/pull do NOT enter the #472 kernel / #474 mutation ledger (that taxonomy is frozen), so this is
// a dedicated SIBLING of mutationEvidenceLedger.ts that records the terminal outcome of every executed
// sync. Persistence shape mirrors the mutation ledger exactly: ONE document per UTC date bucket (runId
// `git-sync-evidence-YYYY-MM-DD`), serialized through `EvidenceStore.update ?? get+put`, redacted leaf
// by leaf with `deepRedactStrings`, bounded to the most recent N records, and best-effort — an audit
// write must NEVER break the user's sync. Corrupt buckets fail closed and are never overwritten.
//
// The repository is identified only by `sha256Hex(workspace.root).slice(0,24)` — a content-free hash,
// never the path itself. Records carry counts, the typed outcome, and branch/remote NAMES only; no
// URLs, secrets, or command output.

import type { GitSyncOperation, GitSyncOutcome } from "@oscharko-dev/keiko-contracts";
import { deepRedactStrings } from "@oscharko-dev/keiko-evidence";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { sha256Hex } from "@oscharko-dev/keiko-security";

export const GIT_SYNC_EVIDENCE_RUNID_PREFIX = "git-sync-evidence-" as const;

// Default bound on records retained per UTC date bucket. The most recent records are kept.
export const GIT_SYNC_EVIDENCE_DEFAULT_BUCKET_CAP = 500;

export const GIT_SYNC_EVIDENCE_SCHEMA_VERSION = "1" as const;

export interface GitSyncEvidenceRecord {
  readonly schemaVersion: typeof GIT_SYNC_EVIDENCE_SCHEMA_VERSION;
  readonly operation: GitSyncOperation;
  readonly outcome: GitSyncOutcome;
  // sha256Hex(workspace.root).slice(0, 24) — content-free repository identifier.
  readonly repoIdHash: string;
  readonly branch?: string | undefined;
  readonly remote?: string | undefined;
  readonly aheadBefore?: number | undefined;
  readonly behindBefore?: number | undefined;
  readonly aheadAfter?: number | undefined;
  readonly behindAfter?: number | undefined;
  readonly recordedAtMs: number;
}

export interface GitSyncEvidenceLedgerDoc {
  readonly schemaVersion: typeof GIT_SYNC_EVIDENCE_SCHEMA_VERSION;
  readonly records: readonly GitSyncEvidenceRecord[];
}

// Content-free repository identifier from the workspace root path. Never the path itself.
export function gitSyncRepoIdHash(workspaceRoot: string): string {
  return sha256Hex(workspaceRoot).slice(0, 24);
}

// UTC date-bucket runId. `git-sync-evidence-` (17) + `YYYY-MM-DD` (10) = 27, well under the
// evidence-store run-id length cap.
export function gitSyncEvidenceRunIdFor(nowMs: number): string {
  const iso = new Date(nowMs).toISOString();
  return `${GIT_SYNC_EVIDENCE_RUNID_PREFIX}${iso.slice(0, 10)}`;
}

export interface RecordGitSyncEvidenceOptions {
  readonly evidenceStore: EvidenceStore;
  // String-leaf redactor (deps.redactString / the audit redactor). Defence-in-depth over the
  // by-construction content-free record shape.
  readonly redactString: (input: string) => string;
  readonly maxRecordsPerBucket?: number | undefined;
  // Persistence-error sink; defaults to console.error. An audit-write failure never throws here.
  readonly onPersistError?: ((error: unknown) => void) | undefined;
}

function defaultOnPersistError(error: unknown): void {
  // eslint-disable-next-line no-console
  console.error("git-sync evidence ledger: persistence failed", error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Parses an existing bucket document. Returns the records faithfully (they were written valid).
// Throws on gross corruption so the caller fails closed and preserves the artifact.
function parseExistingRecords(json: string | undefined): readonly GitSyncEvidenceRecord[] {
  if (json === undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      "git-sync evidence ledger is corrupt; refusing to overwrite existing audit evidence",
      { cause: error },
    );
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.records)) {
    throw new Error(
      "git-sync evidence ledger has an unexpected shape; refusing to overwrite existing audit evidence",
    );
  }
  return parsed.records as readonly GitSyncEvidenceRecord[];
}

function boundedDoc(
  existing: readonly GitSyncEvidenceRecord[],
  record: GitSyncEvidenceRecord,
  cap: number,
): GitSyncEvidenceLedgerDoc {
  const records = [...existing, record];
  return {
    schemaVersion: GIT_SYNC_EVIDENCE_SCHEMA_VERSION,
    records: cap > 0 && records.length > cap ? records.slice(records.length - cap) : records,
  };
}

function appendRecord(
  store: EvidenceStore,
  runId: string,
  record: GitSyncEvidenceRecord,
  cap: number,
): void {
  const append = (existingJson: string | undefined): string =>
    JSON.stringify(boundedDoc(parseExistingRecords(existingJson), record, cap));
  if (store.update !== undefined) {
    store.update(runId, append);
    return;
  }
  store.put(runId, append(store.get(runId)));
}

/**
 * Appends one fetch/pull sync evidence record to its date-bucketed ledger. Redacts every string leaf,
 * bounds the bucket, and never throws into the caller's path. Returns nothing — audit recording is
 * best-effort and is reported (not propagated) on failure.
 */
export function recordGitSyncEvidence(
  options: RecordGitSyncEvidenceOptions,
  record: GitSyncEvidenceRecord,
): void {
  const onPersistError = options.onPersistError ?? defaultOnPersistError;
  const cap = options.maxRecordsPerBucket ?? GIT_SYNC_EVIDENCE_DEFAULT_BUCKET_CAP;
  const safe = deepRedactStrings(record, options.redactString) as GitSyncEvidenceRecord;
  const runId = gitSyncEvidenceRunIdFor(record.recordedAtMs);
  try {
    appendRecord(options.evidenceStore, runId, safe, cap);
  } catch (error) {
    onPersistError(error);
  }
}
