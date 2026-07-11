// Per-item content fingerprints for connector-backed Knowledge Pods (Epic #2238, Issue #2242,
// ADR-0128 D5).
//
// The Epic #1856 fingerprint model generalized to stable provider item identities: one opaque
// content hash per synced item (keyed by `confluence:<connectorId>:<pageId>`-style keys, not by
// crawled paths), replaced atomically per applied sync run. Per-item hashing REUSES
// `computeManualPageFingerprint` (sha256 over the normalized content bytes) and the run-set
// digest reuses the same canonical construction as `computeManualCrawlRunFingerprint`, emitted as
// hex to satisfy the #2240 wire contract — one fingerprinting scheme across both lanes.
// `relative_path` records the id-derived mount path of the
// item's document; `webui_path` records the provider's own link path for citation click-through.
// Identifiers, hashes, and link paths only — never a body.

import { createHash } from "node:crypto";
import type { KnowledgeCapsuleId, KnowledgeSourceId } from "@oscharko-dev/keiko-contracts";

import { computeManualPageFingerprint } from "./manual-page-fingerprints.js";
import type { KnowledgeStore } from "./store.js";

export interface ConnectorItemFingerprint {
  readonly itemKey: string;
  readonly contentFingerprint: string;
  readonly byteLength: number;
  readonly relativePath: string;
  readonly webuiPath?: string | undefined;
  // Provider-structured citation metadata (#2243): a bounded, adapter-validated JSON projection
  // of display-safe field values (status, type, labels, estimates, relationship KEYS) — never a
  // body or comment text. Confluence items leave it absent.
  readonly citationMetadataJson?: string | undefined;
}

// Opaque content fingerprint of one normalized connector item. Reuses the #1856 sha256 primitive.
export function computeConnectorItemFingerprint(bytes: Uint8Array): string {
  return computeManualPageFingerprint(bytes);
}

// Order-independent digest of an entire applied sync run's item set — the D5
// `fingerprintSetDigest`. Same canonical construction as the #1856 crawl-run fingerprint (key +
// non-printable `\u0001` separator + content fingerprint, sorted), emitted as 64-character
// lowercase sha256 hex because that is the wire format the #2240 change-summary contract pins.
export function computeConnectorRunFingerprint(items: readonly ConnectorItemFingerprint[]): string {
  const FIELD_SEPARATOR = "\u0001";
  const canonical = [...items]
    .map((item) => `${item.itemKey}${FIELD_SEPARATOR}${item.contentFingerprint}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

interface ConnectorItemFingerprintRow {
  readonly item_key: string;
  readonly content_fingerprint: string;
  readonly byte_length: number;
  readonly relative_path: string;
  readonly webui_path: string | null;
  readonly citation_metadata_json: string | null;
}

// Read the previous applied sync run's fingerprints for a connector source, keyed by item key.
export function readConnectorItemFingerprints(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
): ReadonlyMap<string, ConnectorItemFingerprint> {
  const rows = store._internal.db
    .prepare(
      [
        "SELECT item_key, content_fingerprint, byte_length, relative_path, webui_path,",
        "citation_metadata_json",
        "FROM connector_item_fingerprints",
        "WHERE capsule_id = :capsuleId AND source_id = :sourceId",
      ].join(" "),
    )
    .all({ capsuleId, sourceId }) as unknown as ConnectorItemFingerprintRow[];
  const map = new Map<string, ConnectorItemFingerprint>();
  for (const row of rows) {
    map.set(row.item_key, {
      itemKey: row.item_key,
      contentFingerprint: row.content_fingerprint,
      byteLength: row.byte_length,
      relativePath: row.relative_path,
      ...(row.webui_path !== null ? { webuiPath: row.webui_path } : {}),
      ...(row.citation_metadata_json !== null
        ? { citationMetadataJson: row.citation_metadata_json }
        : {}),
    });
  }
  return map;
}

// Replace the persisted fingerprint set for a connector source with the items from the latest
// applied sync run, atomically (one transaction — the on-disk set always reflects exactly one
// run, mirroring `replaceManualPageFingerprints`). A removed item simply drops out of the set.
export function replaceConnectorItemFingerprints(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
  items: readonly ConnectorItemFingerprint[],
  syncRunId: string,
): void {
  const db = store._internal.db;
  const now = store._internal.now();
  const del = db.prepare(
    "DELETE FROM connector_item_fingerprints WHERE capsule_id = :capsuleId AND source_id = :sourceId",
  );
  const ins = db.prepare(
    [
      "INSERT OR REPLACE INTO connector_item_fingerprints (",
      "  capsule_id, source_id, item_key, content_fingerprint, byte_length, relative_path,",
      "  webui_path, citation_metadata_json, sync_run_id, updated_at",
      ") VALUES (:capsule_id, :source_id, :item_key, :content_fingerprint, :byte_length,",
      "  :relative_path, :webui_path, :citation_metadata_json, :sync_run_id, :updated_at)",
    ].join(" "),
  );
  db.exec("BEGIN");
  try {
    del.run({ capsuleId, sourceId });
    for (const item of items) {
      ins.run({
        capsule_id: capsuleId,
        source_id: sourceId,
        item_key: item.itemKey,
        content_fingerprint: item.contentFingerprint,
        byte_length: item.byteLength,
        relative_path: item.relativePath,
        webui_path: item.webuiPath ?? null,
        citation_metadata_json: item.citationMetadataJson ?? null,
        sync_run_id: syncRunId,
        updated_at: now,
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
