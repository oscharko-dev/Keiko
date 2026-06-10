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
