import { pathToFileURL } from "node:url";
import type {
  DocumentId,
  HtmlManualSource,
  HtmlManualSourceKind,
  KnowledgeCapsuleId,
  KnowledgeSource,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import { isSafeStorageReference } from "@oscharko-dev/keiko-contracts";

import { listCapsuleSources } from "./source-lifecycle.js";
import type { KnowledgeStore } from "./store.js";

interface HtmlManualSourceMetadataRow {
  readonly capsule_id: string;
  readonly source_id: string;
  readonly source_kind: HtmlManualSourceKind;
  readonly source_fingerprint: string;
  readonly root_path: string | null;
  readonly entry_path: string | null;
  readonly origin: string | null;
  readonly path_prefix: string | null;
}

interface DocumentTargetRow {
  readonly document_path: string;
  readonly safe_display_name: string;
}

export interface HtmlManualSourceMetadata {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly sourceKind: HtmlManualSourceKind;
  readonly sourceFingerprint: string;
  readonly rootPath?: string;
  readonly entryPath?: string;
  readonly origin?: string;
  readonly pathPrefix?: string | null;
}

export type HtmlManualCitationTargetFailureReason =
  | "source-metadata-unavailable"
  | "citation-lineage-mismatch"
  | "target-outside-approved-scope"
  | "target-unsupported";

export type HtmlManualCitationTargetResolution =
  | {
      readonly ok: true;
      readonly target: string;
      readonly sourceKind: HtmlManualSourceKind;
      readonly pageTitle: string;
      readonly safePageId: string;
      readonly relativePath: string;
    }
  | { readonly ok: false; readonly reason: HtmlManualCitationTargetFailureReason };

type TargetForMetadataResolution =
  | { readonly ok: true; readonly target: string }
  | {
      readonly ok: false;
      readonly reason: Extract<
        HtmlManualCitationTargetFailureReason,
        "target-outside-approved-scope" | "target-unsupported"
      >;
    };

export interface ResolveHtmlManualCitationTargetInput {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly anchorId?: string;
}

export function persistHtmlManualSourceMetadata(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
  source: HtmlManualSource,
): void {
  const scope = source.scope;
  store._internal.db
    .prepare(
      [
        "INSERT OR REPLACE INTO html_manual_sources (",
        "  capsule_id, source_id, source_kind, source_fingerprint, root_path, entry_path,",
        "  origin, path_prefix, created_at",
        ") VALUES (:capsule_id, :source_id, :source_kind, :source_fingerprint, :root_path,",
        "  :entry_path, :origin, :path_prefix, :created_at)",
      ].join(" "),
    )
    .run({
      capsule_id: capsuleId,
      source_id: sourceId,
      source_kind: scope.kind,
      source_fingerprint: source.sourceFingerprint,
      root_path: scope.kind === "html-manual-local" ? scope.rootPath : null,
      entry_path: scope.kind === "html-manual-local" ? (scope.entryPath ?? null) : null,
      origin: scope.kind === "html-manual-http" ? scope.origin : null,
      path_prefix: scope.kind === "html-manual-http" ? scope.pathPrefix : null,
      created_at: store._internal.now(),
    });
}

export function readHtmlManualSourceMetadata(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
): HtmlManualSourceMetadata | undefined {
  const row = store._internal.db
    .prepare(
      "SELECT * FROM html_manual_sources WHERE capsule_id = :capsuleId AND source_id = :sourceId",
    )
    .get({ capsuleId, sourceId }) as HtmlManualSourceMetadataRow | undefined;
  return row === undefined ? undefined : rowToMetadata(row);
}

function rowToMetadata(row: HtmlManualSourceMetadataRow): HtmlManualSourceMetadata {
  return {
    capsuleId: row.capsule_id as KnowledgeCapsuleId,
    sourceId: row.source_id as KnowledgeSourceId,
    sourceKind: row.source_kind,
    sourceFingerprint: row.source_fingerprint,
    ...(row.root_path !== null ? { rootPath: row.root_path } : {}),
    ...(row.entry_path !== null ? { entryPath: row.entry_path } : {}),
    ...(row.origin !== null ? { origin: row.origin } : {}),
    ...(row.path_prefix !== null ? { pathPrefix: row.path_prefix } : {}),
  };
}

export function resolveHtmlManualCitationTarget(
  store: KnowledgeStore,
  input: ResolveHtmlManualCitationTargetInput,
): HtmlManualCitationTargetResolution {
  const metadata = readHtmlManualSourceMetadata(store, input.capsuleId, input.sourceId);
  if (metadata === undefined) return { ok: false, reason: "source-metadata-unavailable" };
  const document = readDocumentTarget(store, input);
  if (document === undefined) return { ok: false, reason: "citation-lineage-mismatch" };
  const relativePath = documentRelativePath(store, input, document.document_path);
  if (relativePath === undefined) return { ok: false, reason: "target-outside-approved-scope" };
  const target = targetForMetadata(metadata, relativePath, input.anchorId);
  if (!target.ok) return target;
  return {
    ok: true,
    target: target.target,
    sourceKind: metadata.sourceKind,
    pageTitle: document.safe_display_name,
    safePageId: String(input.documentId),
    relativePath,
  };
}

function readDocumentTarget(
  store: KnowledgeStore,
  input: ResolveHtmlManualCitationTargetInput,
): DocumentTargetRow | undefined {
  return store._internal.db
    .prepare(
      [
        "SELECT document_path, safe_display_name FROM documents",
        "WHERE capsule_id = :capsuleId AND source_id = :sourceId AND id = :documentId",
      ].join(" "),
    )
    .get({
      capsuleId: input.capsuleId,
      sourceId: input.sourceId,
      documentId: input.documentId,
    }) as DocumentTargetRow | undefined;
}

function documentRelativePath(
  store: KnowledgeStore,
  input: ResolveHtmlManualCitationTargetInput,
  documentPath: string,
): string | undefined {
  const source = listCapsuleSources(store, input.capsuleId).find(
    (candidate) => candidate.id === input.sourceId,
  );
  if (source === undefined) return undefined;
  const relative = relativePathForSource(source, documentPath);
  return relative !== undefined && isSafeStorageReference(relative) ? relative : undefined;
}

function relativePathForSource(source: KnowledgeSource, documentPath: string): string | undefined {
  const scope = source.scope;
  if (scope.kind !== "files" && scope.kind !== "folder") return undefined;
  const root = scope.rootPath.replace(/\/+$/u, "");
  const prefix = `${root}/`;
  if (documentPath.startsWith(prefix)) return documentPath.slice(prefix.length);
  return isSafeStorageReference(documentPath) ? documentPath : undefined;
}

function targetForMetadata(
  metadata: HtmlManualSourceMetadata,
  relativePath: string,
  anchorId: string | undefined,
): TargetForMetadataResolution {
  const target =
    metadata.sourceKind === "html-manual-http"
      ? httpTarget(metadata, relativePath)
      : localTarget(metadata, relativePath);
  if (!target.ok || anchorId === undefined) return target;
  const url = new URL(target.target);
  url.hash = anchorId;
  return { ok: true, target: url.href };
}

function httpTarget(
  metadata: HtmlManualSourceMetadata,
  relativePath: string,
): TargetForMetadataResolution {
  if (metadata.origin === undefined) return { ok: false, reason: "target-unsupported" };
  const url = new URL(relativePath, `${metadata.origin}/`);
  if (!isWithinApprovedHttpPath(url.pathname, metadata.pathPrefix)) {
    return { ok: false, reason: "target-outside-approved-scope" };
  }
  return { ok: true, target: url.href };
}

function isWithinApprovedHttpPath(pathname: string, prefix: string | null | undefined): boolean {
  if (prefix === undefined || prefix === null || prefix.length === 0 || prefix === "/") return true;
  const withoutTrailingSlash = prefix.replace(/\/+$/u, "");
  const normalized = withoutTrailingSlash.startsWith("/")
    ? withoutTrailingSlash
    : `/${withoutTrailingSlash}`;
  return pathname === normalized || pathname.startsWith(`${normalized}/`);
}

function localTarget(
  metadata: HtmlManualSourceMetadata,
  relativePath: string,
): TargetForMetadataResolution {
  if (metadata.rootPath?.startsWith("/") !== true) {
    return { ok: false, reason: "target-unsupported" };
  }
  return {
    ok: true,
    target: pathToFileURL(`${metadata.rootPath.replace(/\/+$/u, "")}/${relativePath}`).href,
  };
}
