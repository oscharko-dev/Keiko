// Pure assembly of the QI hub's connected sources into a multi-source run request (Epic #729 N+1).
//
// A QI hub can have several Files windows and Connector windows connected at once. This module folds
// ALL of them — a single focused file, every connected folder root, every capsule, and every
// capsule-set — into ONE deduped, MAX_SCOPES-capped sources[] so a Generate run draws from every
// connected source simultaneously (the epic's headline: a file + a folder + a capsule together,
// attributable per source). It is the ADDITIVE replacement for the former file-exclusive precedence
// that silently suppressed connected folders + capsules whenever a single file was focused.
//
// Pure + framework-free so the dedupe / cap / file-supersedes-its-own-folder logic is unit-testable
// without rendering React (Epic #729 #731 — closes the untested-builders gap).

import type {
  QualityIntelligenceCapsuleSetSource,
  QualityIntelligenceCapsuleSource,
  QualityIntelligenceFigmaSnapshotSource,
  QualityIntelligenceFileSource,
  QualityIntelligenceWorkspaceSource,
} from "@oscharko-dev/keiko-contracts";
import { MAX_SCOPES } from "../../hooks/workspaceActions";

/** One connected (non-manual) run source — folder, single file, capsule, capsule-set, or figma snapshot. */
export type ConnectedRunSource =
  | QualityIntelligenceFileSource
  | QualityIntelligenceWorkspaceSource
  | QualityIntelligenceCapsuleSource
  | QualityIntelligenceCapsuleSetSource
  | QualityIntelligenceFigmaSnapshotSource;

export interface ConnectedSourceProps {
  /** Folder root of the FIRST connected Files window (Epic #270 Slice 1). */
  readonly connectedRoot?: string | null;
  /** Focused single file in the FIRST connected Files window (Epic #709). */
  readonly connectedFilePath?: string | null;
  /** All connected Files window roots (Epic #729 N+1), including the focused file's own root. */
  readonly connectedRoots?: readonly string[] | undefined;
  /** Capsule ids from connected Connector windows (Epic #710 #718). */
  readonly connectedCapsuleIds?: readonly string[] | undefined;
  /** Capsule-set ids from connected Connector windows (Epic #710 #718). */
  readonly connectedCapsuleSetIds?: readonly string[] | undefined;
  /** Figma Snapshot run ids from connected Figma Snapshot windows (Epic #750 #756). */
  readonly connectedFigmaSnapshotRunIds?: readonly string[] | undefined;
}

export function baseName(p: string): string {
  const parts = p.split(/[\\/]/u).filter((s) => s.length > 0);
  return parts.length > 0 ? (parts[parts.length - 1] ?? p) : p;
}

function isAbsoluteBrowserPath(path: string): boolean {
  return (
    path.startsWith("/") ||
    /^[A-Za-z]:[/\\]/u.test(path) ||
    path.startsWith("\\\\") ||
    path.startsWith("//")
  );
}

function toPortablePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function trimTrailingSeparators(path: string): string {
  if (/^[A-Za-z]:[/\\]?$/u.test(path)) return path.replaceAll("\\", "/");
  if (/^\/\/[^/]+\/[^/]+$/u.test(toPortablePath(path))) return toPortablePath(path);
  return toPortablePath(path).replace(/\/+$/u, "");
}

/**
 * Resolve a connected Files window's focused file to an absolute path. An already-absolute
 * activeFilePath is used as-is; a relative one is joined onto the connected folder root. Returns null
 * when there is no focused file (so the Files window contributes its folder root instead).
 */
export function resolveConnectedFilePath(
  connectedRoot: string | null,
  connectedFilePath: string | null,
): string | null {
  const candidate = connectedFilePath?.trim() ?? "";
  if (candidate.length === 0) return null;
  if (isAbsoluteBrowserPath(candidate)) return candidate;

  const root = connectedRoot?.trim() ?? "";
  if (root.length === 0) return null;
  const joinedRoot = trimTrailingSeparators(root);
  const relativePath = toPortablePath(candidate).replace(/^\/+/u, "");
  return `${joinedRoot}/${relativePath}`;
}

function sourceKey(source: ConnectedRunSource): string {
  switch (source.kind) {
    case "file":
    case "workspace":
      return `${source.kind}:${source.path}`;
    case "capsule":
      return `capsule:${source.capsuleId}`;
    case "capsule-set":
      return `capsule-set:${source.capsuleSetId}`;
    case "figma-snapshot":
      return `figma-snapshot:${source.snapshotRunId}`;
  }
}

/**
 * Fold every connected source into one deduped, MAX_SCOPES-capped list — the additive N+1 assembly
 * (Epic #729). A focused single file supersedes its OWN Files window folder root (so the same content
 * is never ingested twice — as a file AND as its parent folder), while EVERY other connected folder,
 * capsule, and capsule-set is still included. A lone focused file therefore stays a one-element file
 * request (Epic #709 unchanged); a file + other folder + capsule becomes a three-element request.
 *
 * Precedence when the global cap is hit: file → folders → capsules → capsule-sets → figma snapshots.
 * The combined list is capped ONCE across all kinds, mirroring the server's single 16-source cap.
 */
export function buildConnectedRunSources(
  props: ConnectedSourceProps,
): readonly ConnectedRunSource[] {
  const connectedRootRaw = props.connectedRoot ?? null;
  // resolveConnectedFilePath canonicalises the root internally, so it receives the RAW value.
  const connectedFile = resolveConnectedFilePath(connectedRootRaw, props.connectedFilePath ?? null);
  // Canonicalise every folder root (strip trailing separators, normalise slashes) BEFORE the
  // file-supersedes-own-folder filter and the dedupe below. Two Files windows whose roots differ
  // only by a trailing separator (".../spec" vs ".../spec/") would otherwise survive as two
  // workspace sources and the same folder would be ingested twice; likewise a focused file whose own
  // folder root carried a trailing slash would not be superseded. Canonicalising collapses both
  // (Epic #729 N+1 dedup robustness; keeps the lone-file #709 path one element).
  const connectedRoot = connectedRootRaw !== null ? trimTrailingSeparators(connectedRootRaw) : null;

  const rawRoots =
    props.connectedRoots !== undefined &&
    props.connectedRoots !== null &&
    props.connectedRoots.length > 0
      ? props.connectedRoots
      : connectedRootRaw !== null
        ? [connectedRootRaw]
        : [];
  const allRoots = rawRoots.map(trimTrailingSeparators);
  // The focused file supersedes its own (canonicalised) folder root; other connected folders remain.
  const folderRoots =
    connectedFile !== null ? allRoots.filter((r) => r !== connectedRoot) : allRoots;

  const ordered: ConnectedRunSource[] = [];
  if (connectedFile !== null) {
    ordered.push({ kind: "file", label: baseName(connectedFile), path: connectedFile });
  }
  for (const root of folderRoots) {
    ordered.push({ kind: "workspace", label: baseName(root), path: root });
  }
  for (const id of props.connectedCapsuleIds ?? []) {
    ordered.push({ kind: "capsule", label: id, capsuleId: id });
  }
  for (const id of props.connectedCapsuleSetIds ?? []) {
    ordered.push({ kind: "capsule-set", label: id, capsuleSetId: id });
  }
  for (const id of props.connectedFigmaSnapshotRunIds ?? []) {
    ordered.push({ kind: "figma-snapshot", label: id, snapshotRunId: id });
  }

  const seen = new Set<string>();
  const result: ConnectedRunSource[] = [];
  for (const source of ordered) {
    if (result.length >= MAX_SCOPES) break;
    const key = sourceKey(source);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(source);
  }
  return result;
}
