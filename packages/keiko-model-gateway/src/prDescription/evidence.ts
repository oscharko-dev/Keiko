import { canonicalise, redact, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  gitChangeSnapshotDigestFields,
  validateGitChangeSnapshotResult,
} from "@oscharko-dev/keiko-contracts/runtime/git-change-snapshot";
import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts/runtime/text-safety";
import type { PrDescriptionEvidence, PrDescriptionResolvedSnapshot } from "./types.js";

export function validPrDescriptionSnapshot(
  resolved: PrDescriptionResolvedSnapshot,
  nowMs: number,
): boolean {
  const validation = validateGitChangeSnapshotResult(resolved.snapshot);
  if (!validation.ok) return false;
  if (validation.value.outcome !== "complete" && validation.value.outcome !== "partial")
    return false;
  const snapshot = resolved.snapshot;
  if (Date.parse(snapshot.expiresAt) <= nowMs || Date.parse(snapshot.capturedAt) > nowMs)
    return false;
  if (sha256Hex(canonicalise(gitChangeSnapshotDigestFields(snapshot))) !== snapshot.snapshotDigest)
    return false;
  return validEvidence(
    resolved.evidence,
    snapshot.entries.map((entry) => entry.evidenceId),
  );
}

function validEvidence(evidence: unknown, evidenceIds: readonly string[]): boolean {
  if (!Array.isArray(evidence)) return false;
  const known = new Set(evidenceIds);
  const seen = new Set<string>();
  for (const item of evidence as readonly unknown[]) {
    if (!isEvidenceItem(item) || !known.has(item.evidenceId) || seen.has(item.evidenceId))
      return false;
    seen.add(item.evidenceId);
  }
  return true;
}

function isEvidenceItem(value: unknown): value is PrDescriptionEvidence {
  return (
    typeof value === "object" &&
    value !== null &&
    "evidenceId" in value &&
    typeof value.evidenceId === "string" &&
    "text" in value &&
    typeof value.text === "string"
  );
}

export function sanitizePrDescriptionEvidence(text: string): string {
  return redact(stripUnsafeFormatChars(text.normalize("NFKC")));
}

export function prDescriptionChunks(
  evidence: readonly PrDescriptionEvidence[],
  maxBytes: number,
): readonly (readonly PrDescriptionEvidence[])[] {
  const chunks: PrDescriptionEvidence[][] = [];
  let chunk: PrDescriptionEvidence[] = [];
  let bytes = 2;
  for (const item of [...evidence].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId))) {
    if (Buffer.byteLength(item.text, "utf8") > maxBytes) continue;
    const safe = { evidenceId: item.evidenceId, text: sanitizePrDescriptionEvidence(item.text) };
    const size = Buffer.byteLength(JSON.stringify(safe), "utf8") + 1;
    if (size + 2 > maxBytes) continue;
    if (bytes + size > maxBytes) {
      chunks.push(chunk);
      chunk = [];
      bytes = 2;
    }
    chunk.push(safe);
    bytes += size;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}
