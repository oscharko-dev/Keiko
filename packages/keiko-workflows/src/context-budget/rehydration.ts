// Bounded, deny-checked, observable rehydration of compacted provenance (ADR-0053 D5). Repo-file
// reads go through readExcerpt, which itself runs isDenied + containment + binary/size gates and
// throws on a denied/binary/too-large path. Message, evidence-atom, and tool-result reads resolve
// only through caller-injected, policy-gated readers. We catch failures and degrade to
// {resolved:false, reason} so stale or denied sources never crash the caller. The excerpt-content
// hash is recomputed on repo-file reads so a line-range change is detected precisely against the
// handle's contentHash.

import type {
  ContextProvenanceRef,
  ContextRehydrationHandle,
  ContextToolRehydrationHandle,
} from "@oscharko-dev/keiko-contracts";
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

export interface ToolResultArtifactReader {
  readonly read: (artifactId: string) => string | undefined;
}

export interface MessageReader {
  readonly read: (messageId: string) => string | undefined;
}

export interface EvidenceAtomReader {
  readonly read: (atomId: string) => string | undefined;
}

export interface RehydrationDeps {
  readonly toolArtifacts?: ToolResultArtifactReader | undefined;
  readonly messages?: MessageReader | undefined;
  readonly evidenceAtoms?: EvidenceAtomReader | undefined;
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

function clampToBytes(text: string, maxBytes: number): { content: string; truncated: boolean } {
  if (maxBytes <= 0) {
    return { content: "", truncated: text.length > 0 };
  }
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) {
    return { content: text, truncated: false };
  }
  const buffer = encoded.subarray(0, maxBytes);
  return {
    content: new TextDecoder("utf-8", { fatal: false }).decode(buffer).replace(/�+$/u, ""),
    truncated: true,
  };
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

function readToolResultArtifact(
  artifactId: string,
  deps: RehydrationDeps | undefined,
  maxBytes: number | undefined,
): RehydrationResult {
  const reader = deps?.toolArtifacts;
  if (reader === undefined) {
    return { resolved: false, reason: "tool-result artifact reader unavailable" };
  }
  let raw: string | undefined;
  try {
    raw = reader.read(artifactId);
  } catch (error) {
    return { resolved: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (raw === undefined) {
    return { resolved: false, reason: `tool-result artifact not found: ${artifactId}` };
  }
  const bounded = clampToBytes(raw, boundMaxBytes(maxBytes));
  return {
    resolved: true,
    content: bounded.content,
    ...(bounded.truncated
      ? { reason: "tool-result artifact truncated to rehydration budget" }
      : {}),
  };
}

function readOpaqueSource(input: {
  readonly kind: "message" | "evidence-atom";
  readonly id: string;
  readonly reader: { readonly read: (id: string) => string | undefined } | undefined;
  readonly readerLabel: string;
  readonly maxBytes: number | undefined;
}): RehydrationResult {
  if (input.reader === undefined) {
    return { resolved: false, reason: `${input.readerLabel} reader unavailable` };
  }
  let raw: string | undefined;
  try {
    raw = input.reader.read(input.id);
  } catch (error) {
    return { resolved: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (raw === undefined) {
    return { resolved: false, reason: `${input.kind} not found: ${input.id}` };
  }
  const bounded = clampToBytes(raw, boundMaxBytes(input.maxBytes));
  return {
    resolved: true,
    content: bounded.content,
    ...(bounded.truncated ? { reason: `${input.kind} truncated to rehydration budget` } : {}),
  };
}

function readMessage(
  stableId: string,
  deps: RehydrationDeps | undefined,
  maxBytes: number | undefined,
): RehydrationResult {
  return readOpaqueSource({
    kind: "message",
    id: stableId,
    reader: deps?.messages,
    readerLabel: "message",
    maxBytes,
  });
}

function readEvidenceAtom(
  atomId: string,
  deps: RehydrationDeps | undefined,
  maxBytes: number | undefined,
): RehydrationResult {
  return readOpaqueSource({
    kind: "evidence-atom",
    id: atomId,
    reader: deps?.evidenceAtoms,
    readerLabel: "evidence-atom",
    maxBytes,
  });
}

// Resolves a single ContextProvenanceRef. A notPersistedReason short-circuits WITHOUT any read.
// kind 'repo-file' with scopePath + lineRange reads via readExcerpt (deny/bounds gated). Message
// and evidence-atom refs resolve only through caller-injected, policy-gated readers.
export async function rehydrateProvenanceRef(
  ref: ContextProvenanceRef,
  scope: SearchScope,
  fs: WorkspaceFs,
  maxBytes?: number,
  deps?: RehydrationDeps,
): Promise<RehydrationResult> {
  if (ref.notPersistedReason !== undefined) {
    return { resolved: false, reason: ref.notPersistedReason };
  }
  if (ref.kind === "tool-result") {
    return readToolResultArtifact(ref.stableId, deps, maxBytes);
  }
  if (ref.kind === "message") {
    return readMessage(ref.stableId, deps, maxBytes);
  }
  if (ref.kind === "evidence-atom") {
    return readEvidenceAtom(ref.evidenceAtomId ?? ref.stableId, deps, maxBytes);
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

function rehydrateSpecialHandle(
  handle: ContextRehydrationHandle,
  deps: RehydrationDeps | undefined,
  maxBytes: number | undefined,
): RehydrationResult | undefined {
  if (handle.kind === "tool-result") {
    return handle.artifactId === undefined
      ? { resolved: false, reason: "tool-result handle missing artifactId" }
      : readToolResultArtifact(handle.artifactId, deps, maxBytes);
  }
  if (handle.kind === "evidence-atom") {
    return handle.evidenceAtomId === undefined
      ? { resolved: false, reason: "evidence-atom handle missing evidenceAtomId" }
      : readEvidenceAtom(handle.evidenceAtomId, deps, maxBytes);
  }
  if (handle.kind === "message") {
    return { resolved: false, reason: "message handle missing direct message id" };
  }
  return undefined;
}

// Resolves a lane-level handle. A handle that carries kind + scopePath + lineRange is resolved by
// constructing the equivalent repo-file ref; otherwise it is lane-level (an opaque eviction-set
// pointer) and not directly rehydratable.
export async function rehydrateHandle(
  handle: ContextRehydrationHandle,
  scope: SearchScope,
  fs: WorkspaceFs,
  maxBytes?: number,
  deps?: RehydrationDeps,
): Promise<RehydrationResult> {
  if (handle.notPersistedReason !== undefined) {
    return { resolved: false, reason: handle.notPersistedReason };
  }
  const special = rehydrateSpecialHandle(handle, deps, maxBytes);
  if (special !== undefined) {
    return special;
  }
  const { kind, scopePath, lineRange } = handle;
  if (kind !== "repo-file" || scopePath === undefined || lineRange === undefined) {
    return { resolved: false, reason: "handle not directly rehydratable (lane-level)" };
  }
  const ref: ContextProvenanceRef = {
    kind,
    stableId: handle.handleId,
    scopePath,
    lineRange,
    ...(handle.contentHash !== undefined ? { contentHash: handle.contentHash } : {}),
  };
  return rehydrateProvenanceRef(ref, scope, fs, maxBytes, deps);
}

export function rehydrateToolResultHandle(
  handle: ContextToolRehydrationHandle,
  deps: RehydrationDeps,
  maxBytes?: number,
): RehydrationResult {
  if (handle.notPersistedReason !== undefined) {
    return { resolved: false, reason: handle.notPersistedReason };
  }
  return readToolResultArtifact(handle.artifactId, deps, maxBytes);
}
