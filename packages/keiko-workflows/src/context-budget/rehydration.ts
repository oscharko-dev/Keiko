// Bounded, deny-checked, observable rehydration of compacted provenance (ADR-0053 D5). The ONLY IO
// path in the context-budget module: every repo-file read goes through readExcerpt, which itself
// runs isDenied + containment + binary/size gates and throws on a denied/binary/too-large path. We
// CATCH those throws and degrade to {resolved:false, reason} so a stale or denied source never
// crashes the caller. The excerpt-content hash is recomputed on read so a line-range change is
// detected precisely against the handle's contentHash.

import type { ContextProvenanceRef, ContextRehydrationHandle } from "@oscharko-dev/keiko-contracts";
import {
  hashExcerptContent,
  readExcerpt,
  type SearchScope,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";

export interface RehydrationResult {
  readonly resolved: boolean;
  readonly invalidated?: boolean | undefined;
  readonly content?: string | undefined;
  readonly reason?: string | undefined;
}

// Independent of whatever the caller passes: rehydration is always bounded. 256 KiB is generous for
// a single excerpt window yet far under readExcerpt's 2 MiB file cap. A caller passing Infinity or
// an oversized value cannot widen this — Math.min clamps it.
const DEFAULT_REHYDRATION_MAX_BYTES = 262_144;
const MAX_REHYDRATION_MAX_BYTES = 2_097_152;

function boundMaxBytes(maxBytes: number | undefined): number {
  const requested =
    maxBytes !== undefined && Number.isFinite(maxBytes) && maxBytes >= 0
      ? Math.floor(maxBytes)
      : DEFAULT_REHYDRATION_MAX_BYTES;
  return Math.min(requested, MAX_REHYDRATION_MAX_BYTES);
}

function deferred(kind: string): RehydrationResult {
  return { resolved: false, reason: `kind ${kind} rehydration deferred (PR3/PR4)` };
}

interface RepoFileTarget {
  readonly scopePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly contentHash: string | undefined;
}

async function readRepoFile(
  target: RepoFileTarget,
  scope: SearchScope,
  fs: WorkspaceFs,
  maxBytes: number | undefined,
): Promise<RehydrationResult> {
  try {
    const result = await readExcerpt(
      scope,
      {
        scopePath: target.scopePath,
        startLine: target.startLine,
        endLine: target.endLine,
        maxBytes: boundMaxBytes(maxBytes),
      },
      { fs },
    );
    const newHash = hashExcerptContent(result.content);
    const invalidated = target.contentHash !== undefined && newHash !== target.contentHash;
    return { resolved: true, invalidated, content: result.content };
  } catch (error) {
    return { resolved: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

// Resolves a single ContextProvenanceRef. A notPersistedReason short-circuits WITHOUT any read.
// kind 'repo-file' with scopePath + lineRange reads via readExcerpt (deny/bounds gated). All other
// kinds are deferred to a later PR with no IO.
export async function rehydrateProvenanceRef(
  ref: ContextProvenanceRef,
  scope: SearchScope,
  fs: WorkspaceFs,
  maxBytes?: number,
): Promise<RehydrationResult> {
  if (ref.notPersistedReason !== undefined) {
    return { resolved: false, reason: ref.notPersistedReason };
  }
  if (ref.kind !== "repo-file") {
    return deferred(ref.kind);
  }
  const scopePath = ref.scopePath;
  const lineRange = ref.lineRange;
  if (scopePath === undefined || lineRange === undefined) {
    return { resolved: false, reason: "repo-file ref missing scopePath or lineRange" };
  }
  return readRepoFile(
    {
      scopePath,
      startLine: lineRange.startLine,
      endLine: lineRange.endLine,
      contentHash: ref.contentHash,
    },
    scope,
    fs,
    maxBytes,
  );
}

// Resolves a lane-level handle. A handle that carries kind + scopePath + lineRange is resolved by
// constructing the equivalent repo-file ref; otherwise it is lane-level (an opaque eviction-set
// pointer) and not directly rehydratable.
export async function rehydrateHandle(
  handle: ContextRehydrationHandle,
  scope: SearchScope,
  fs: WorkspaceFs,
  maxBytes?: number,
): Promise<RehydrationResult> {
  const { kind, scopePath, lineRange } = handle;
  if (kind === undefined || scopePath === undefined || lineRange === undefined) {
    return { resolved: false, reason: "handle not directly rehydratable (lane-level)" };
  }
  const ref: ContextProvenanceRef = {
    kind,
    stableId: handle.handleId,
    scopePath,
    lineRange,
    ...(handle.contentHash !== undefined ? { contentHash: handle.contentHash } : {}),
  };
  return rehydrateProvenanceRef(ref, scope, fs, maxBytes);
}
