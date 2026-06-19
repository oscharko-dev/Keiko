// Content-free audit linkage for governed coding-context retrieval (Issue #1211, AC: retrieved
// context carries content-free provenance/citations suitable for evidence and audit linkage, and the
// recorded citations are content-free and identify the source tier so cross-tier/cross-tenant flow is
// auditable). The persisted record carries ONLY the content-free wire pack (citations + tier + counts
// + omissions) — never excerpt text, raw queries, prompts, workspace roots, or secrets. It uses its
// own `codingContextSchemaVersion` key and deliberately omits `evidenceSchemaVersion`, so the grounded
// / QI evidence reader (`listEvidence`) skips it instead of attempting to parse it as a connected-
// context manifest. Persistence failure never fails the request (mirrors the memory-audit handler).

import { createHash } from "node:crypto";
import type { CodingContextWirePack, CodingContextSourceTier } from "@oscharko-dev/keiko-contracts";
import { CODING_CONTEXT_SOURCE_TIERS } from "@oscharko-dev/keiko-contracts";
import type { EvidenceStore } from "@oscharko-dev/keiko-contracts";
import type { Redactor } from "../deps.js";

export const CODING_CONTEXT_EVIDENCE_SCHEMA_VERSION = "1" as const;

function countByTier(
  wirePack: CodingContextWirePack,
): Readonly<Record<CodingContextSourceTier, number>> {
  const counts = Object.fromEntries(CODING_CONTEXT_SOURCE_TIERS.map((tier) => [tier, 0])) as Record<
    CodingContextSourceTier,
    number
  >;
  for (const entry of wirePack.entries) {
    counts[entry.sourceTier] += 1;
  }
  return counts;
}

// Deterministic, content-free run id. Derived from purpose + the (content-free) citation ids +
// emission time, so the same retrieval at the same instant links to the same audit record.
export function codingContextEvidenceRunId(
  wirePack: CodingContextWirePack,
  emittedAtMs: number,
): string {
  const material = [
    wirePack.purpose,
    String(emittedAtMs),
    ...wirePack.entries.map((entry) => `${entry.sourceKind}:${entry.id}`),
  ].join("\n");
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 16);
  return `coding-context-${digest}`;
}

export function recordCodingContextEvidence(
  store: EvidenceStore,
  redactor: Redactor,
  wirePack: CodingContextWirePack,
  emittedAtMs: number,
): string {
  const runId = codingContextEvidenceRunId(wirePack, emittedAtMs);
  const manifest = {
    codingContextSchemaVersion: CODING_CONTEXT_EVIDENCE_SCHEMA_VERSION,
    runId,
    purpose: wirePack.purpose,
    emittedAtMs,
    usedBytes: wirePack.usedBytes,
    budgetBytes: wirePack.budgetBytes,
    droppedForBudget: wirePack.droppedForBudget,
    citationCount: wirePack.entries.length,
    tierCounts: countByTier(wirePack),
    citations: wirePack.entries,
    omissions: wirePack.omissions,
  };
  try {
    store.put(runId, JSON.stringify(redactor(manifest)));
  } catch {
    // Audit persistence is best-effort; a write failure must never fail the user's request.
  }
  return runId;
}
