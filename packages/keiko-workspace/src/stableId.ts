// Deterministic SHA-256 stable IDs for connected-context evidence atoms and packs
// (Epic #177, Issue #179). Inputs are the DTOs defined in keiko-contracts; the producer
// here owns the canonicalisation rules (key-sorted JSON, omit `undefined`, no whitespace,
// caller-sorted-or-here-sorted arrays) so every downstream package hashes the same shape.
// Prefixes `a-` / `p-` keep the two namespaces visually separable in logs.

import { createHash } from "node:crypto";
import type {
  ConnectedContextPackStableIdInput,
  EvidenceAtomStableIdInput,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { WorkspaceFs } from "./fs.js";

type JsonScalar = string | number | boolean | null;
type JsonValue = JsonScalar | JsonObject | readonly JsonValue[];
interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

function canonicalize(value: JsonValue | undefined): string {
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value as readonly JsonValue[];
    return `[${items.map((item) => canonicalize(item)).join(",")}]`;
  }
  const entries = Object.entries(value as JsonObject)
    .filter((pair): pair is [string, JsonValue] => pair[1] !== undefined)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const body = entries.map(([key, val]) => `${JSON.stringify(key)}:${canonicalize(val)}`).join(",");
  return `{${body}}`;
}

function sha256Hex(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex");
}

export function evidenceAtomStableId(input: EvidenceAtomStableIdInput): string {
  const shape: JsonObject = {
    scopeId: input.scopeId,
    scopePath: input.scopePath,
    lineRange:
      input.lineRange === undefined
        ? undefined
        : { startLine: input.lineRange.startLine, endLine: input.lineRange.endLine },
    provenanceKind: input.provenanceKind,
    provenanceTool: input.provenanceTool,
    queryFingerprint: input.queryFingerprint,
  };
  return `a-${sha256Hex(canonicalize(shape))}`;
}

export function connectedContextPackStableId(input: ConnectedContextPackStableIdInput): string {
  const sortedAtomIds = [...input.atomStableIds].sort((a, b) => (a < b ? -1 : 1));
  const shape: JsonObject = {
    scopeId: input.scopeId,
    queryKind: input.queryKind,
    queryText: input.queryText,
    atomStableIds: sortedAtomIds,
  };
  return `p-${sha256Hex(canonicalize(shape))}`;
}

// Coarse byte cap (128 KiB) for the file-level invalidation hash. Matches the exploration budget's
// `excerptBytesMax` default (connected-context.ts) so this reuses the same "excerpt budget" concept
// rather than introducing a fresh constant. See `fileContentHash` for the truncation semantics.
export const MAX_HASH_FILE_BYTES = 131_072;

// SHA-256 hex of the EXCERPT CONTENT itself (ContextRehydrationHandle.contentHash, ADR-0053 D2).
// Captured at compaction time over the exact preserved lines and recomputed on rehydration over the
// `readExcerpt` result, so a line-range change is detected precisely. Total: never throws — an empty
// string yields the well-defined SHA-256 of zero bytes. Hashing is byte-based (UTF-8), so multibyte
// content hashes consistently regardless of how the JS string was constructed.
export function hashExcerptContent(content: string): string {
  return sha256Hex(content);
}

// File-level coarse invalidation signal for ContextInvalidationKey (ADR-0053 D3).
//
// Returns `undefined` when the optional `readFileBytes` port is absent (legacy in-memory test fakes
// that implement only the synchronous surface) — callers omit the invalidation key in that case
// rather than recording a non-hash value. Otherwise it reads the file's bytes and hashes the FIRST
// `MAX_HASH_FILE_BYTES` (128 KiB), returning the lowercase hex digest.
//
// LIMITATION (a): only the first 128 KiB is hashed. A change confined to the TAIL of a file larger
// than 128 KiB is a FALSE NEGATIVE — this is an excerpt-range staleness signal, NOT a whole-file
// integrity guarantee. Accepted per ADR-0053 (the summary's source is the excerpt range, not the
// whole file).
//
// CALLER RESPONSIBILITY (b): the deny/containment gate (`isDenied` + `containedRealPathInfo`) MUST
// run BEFORE calling this function — it does NOT deny-gate. It receives an already-vetted
// `absolutePath` resolved by the caller (same boundary contract as `readExcerpt`).
//
// Total on an empty file (=> the hash of empty/truncated bytes). If `readFileBytes` rejects, the
// rejection propagates — the caller handles IO failure; this helper does NOT swallow it.
export async function fileContentHash(
  fs: WorkspaceFs,
  absolutePath: string,
): Promise<string | undefined> {
  const readFileBytes = fs.readFileBytes;
  if (readFileBytes === undefined) {
    return undefined;
  }
  const bytes = await readFileBytes(absolutePath, MAX_HASH_FILE_BYTES);
  return createHash("sha256").update(bytes).digest("hex");
}
