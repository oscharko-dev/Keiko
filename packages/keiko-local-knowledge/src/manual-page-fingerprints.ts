// Per-page content fingerprints for HTML Manual Knowledge Pods (Epic #1856, Issue #1890).
//
// One opaque content hash per reachable page from the most recent crawl, keyed by the page's
// scope-relative path. This lets an explicit refresh classify pages as added / changed / removed /
// unchanged by comparing the previous crawl's fingerprints against the new crawl — WITHOUT storing
// or exposing any page body. Hashing happens here because the leaf contracts package cannot hash
// (ADR-0019 direction 1); keiko-local-knowledge is still egress-free (node:crypto only).

import { createHash } from "node:crypto";
import type { KnowledgeCapsuleId, KnowledgeSourceId } from "@oscharko-dev/keiko-contracts";

import type { KnowledgeStore } from "./store.js";

// Opaque content fingerprint of a crawled page's raw bytes. `sha256:<base64url>` mirrors the
// section-path-hash idiom; it is a one-way digest — content-free and redaction-safe.
export function computeManualPageFingerprint(bytes: Uint8Array): string {
  const digest = createHash("sha256").update(bytes).digest("base64url");
  return `sha256:${digest}`;
}

export interface ManualPageFingerprint {
  readonly relativePath: string;
  readonly contentFingerprint: string;
  readonly byteLength: number;
}

// Opaque, order-independent fingerprint of an entire crawl run's page set. Two runs that captured
// the identical set of pages (same paths + same content) share this fingerprint, letting an operator
// tell refresh outcomes apart without any path or body. Redaction-safe (`sha256:<base64url>`).
export function computeManualCrawlRunFingerprint(pages: readonly ManualPageFingerprint[]): string {
  // Explicit non-printable delimiter (not a plain space): guarantees the pair cannot collide
  // with a relativePath or fingerprint that legitimately contains a space. Written as an escape
  // so it stays visible in source and diffs (a raw embedded control byte here would be
  // indistinguishable from a space in most editors and could be silently "normalized" away).
  const FIELD_SEPARATOR = "\u0001";
  const canonical = [...pages]
    .map((page) => `${page.relativePath}${FIELD_SEPARATOR}${page.contentFingerprint}`)
    .sort((left, right) => left.localeCompare(right))
    .join("\n");
  return computeManualPageFingerprint(new TextEncoder().encode(canonical));
}

interface ManualPageFingerprintRow {
  readonly relative_path: string;
  readonly content_fingerprint: string;
  readonly byte_length: number;
}

// Read the previous crawl run's fingerprints for a source, keyed by scope-relative path.
export function readManualPageFingerprints(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
): ReadonlyMap<string, ManualPageFingerprint> {
  const rows = store._internal.db
    .prepare(
      [
        "SELECT relative_path, content_fingerprint, byte_length FROM html_manual_page_fingerprints",
        "WHERE capsule_id = :capsuleId AND source_id = :sourceId",
      ].join(" "),
    )
    .all({ capsuleId, sourceId }) as unknown as ManualPageFingerprintRow[];
  const map = new Map<string, ManualPageFingerprint>();
  for (const row of rows) {
    map.set(row.relative_path, {
      relativePath: row.relative_path,
      contentFingerprint: row.content_fingerprint,
      byteLength: row.byte_length,
    });
  }
  return map;
}

// Replace the persisted fingerprint set for a source with the pages from the latest crawl run,
// atomically. A removed page simply drops out of the new set. Runs in one transaction so the
// on-disk set always reflects exactly one crawl run.
export function replaceManualPageFingerprints(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
  pages: readonly ManualPageFingerprint[],
  crawlRunId: string,
): void {
  const db = store._internal.db;
  const now = store._internal.now();
  const del = db.prepare(
    "DELETE FROM html_manual_page_fingerprints WHERE capsule_id = :capsuleId AND source_id = :sourceId",
  );
  const ins = db.prepare(
    [
      "INSERT OR REPLACE INTO html_manual_page_fingerprints (",
      "  capsule_id, source_id, relative_path, content_fingerprint, byte_length, crawl_run_id,",
      "  updated_at",
      ") VALUES (:capsule_id, :source_id, :relative_path, :content_fingerprint, :byte_length,",
      "  :crawl_run_id, :updated_at)",
    ].join(" "),
  );
  db.exec("BEGIN");
  try {
    del.run({ capsuleId, sourceId });
    for (const page of pages) {
      ins.run({
        capsule_id: capsuleId,
        source_id: sourceId,
        relative_path: page.relativePath,
        content_fingerprint: page.contentFingerprint,
        byte_length: page.byteLength,
        crawl_run_id: crawlRunId,
        updated_at: now,
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
