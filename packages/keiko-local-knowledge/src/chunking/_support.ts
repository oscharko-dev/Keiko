// Test-only seeding helpers shared by chunking/*.test.ts files. Not part of the published
// surface; the filename underscore + trust-8 dep-cruise rule keep production source from
// importing it. Direct INSERTs are acceptable here because the runner under test does not
// own the parsed_units table — it consumes rows seeded by #194's extract pipeline. We
// reuse #194's prepared-statement wrappers where they exist to keep schema knowledge in
// one place.

import type {
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  ParsedUnit,
} from "@oscharko-dev/keiko-contracts";

import { addSourceToCapsule } from "../source-lifecycle.js";
import { createCapsule } from "../capsule-lifecycle.js";
import { insertDocumentRow, insertParsedUnitRow } from "../discovery/persist.js";
import { sampleCapsuleInput, sampleSourceInput } from "../_support.js";
import type { KnowledgeStore } from "../store.js";

export interface SeededFixture {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
}

export function seedCapsuleSourceAndDocument(
  store: KnowledgeStore,
  options: {
    readonly capsuleId?: string;
    readonly sourceId?: string;
    readonly documentId?: string;
  } = {},
): SeededFixture {
  const capsuleIdRaw = options.capsuleId ?? "cap-1";
  const sourceIdRaw = options.sourceId ?? "src-1";
  const documentIdRaw = options.documentId ?? "doc-1";

  createCapsule(store, sampleCapsuleInput({ id: capsuleIdRaw as KnowledgeCapsuleId }));
  addSourceToCapsule(store, capsuleIdRaw as KnowledgeCapsuleId, sampleSourceInput(sourceIdRaw));

  insertDocumentRow(store._internal.db, {
    id: documentIdRaw as DocumentId,
    capsuleId: capsuleIdRaw as KnowledgeCapsuleId,
    sourceId: sourceIdRaw,
    documentPath: "docs/sample.txt",
    sizeBytes: 1024,
    mediaType: "text/plain",
    contentHash: "a".repeat(64),
    parserId: "text",
    parserVersion: "1",
    lastExtractedAt: 1_700_000_000_000,
    status: "extracted",
    safeDisplayName: "sample.txt",
  });

  return {
    capsuleId: capsuleIdRaw as KnowledgeCapsuleId,
    sourceId: sourceIdRaw as KnowledgeSourceId,
    documentId: documentIdRaw as DocumentId,
  };
}

export function seedParsedUnit(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  unitId: string,
  unit: ParsedUnit,
): void {
  insertParsedUnitRow(store._internal.db, capsuleId, unitId, unit);
}

// Seeds a `pages` row directly. Used by the citation-mapper test to verify the
// chunk → parsed_unit → page hop. Mirrors the discovery/persist.ts INSERT statement.
export function seedPage(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
  options: {
    readonly pageNumber: number;
    readonly pageLabel?: string;
    readonly characterStart: number;
    readonly characterEnd: number;
  },
): void {
  store._internal.db
    .prepare(
      "INSERT INTO pages (capsule_id, document_id, page_number, page_label, character_start, character_end, bbox_x, bbox_y, bbox_w, bbox_h) VALUES (:c, :d, :n, :l, :s, :e, NULL, NULL, NULL, NULL)",
    )
    .run({
      c: capsuleId,
      d: documentId,
      n: options.pageNumber,
      l: options.pageLabel ?? null,
      s: options.characterStart,
      e: options.characterEnd,
    });
}

// Seeds a `sections` row directly. Used by the citation-mapper test for sectionPath hops.
export function seedSection(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
  options: {
    readonly sectionPath: readonly string[];
    readonly characterStart: number;
    readonly characterEnd: number;
  },
): void {
  store._internal.db
    .prepare(
      "INSERT INTO sections (capsule_id, document_id, section_path_json, character_start, character_end) VALUES (:c, :d, :sp, :s, :e)",
    )
    .run({
      c: capsuleId,
      d: documentId,
      sp: JSON.stringify(options.sectionPath),
      s: options.characterStart,
      e: options.characterEnd,
    });
}
