// Content-free audit linkage for editor-driven test generation (Issue #1202, ADR-0042 D7). The
// persisted record carries ONLY the content-free outcome — status, assurance, the assured pre-filter
// funnel (counts + per-gate state), and the candidate file count plus model-provenance ids/hashes. It
// NEVER carries the candidate patch text (`newText`), a prompt, a workspace root, or a secret. It uses
// its own `editorTestGenerationSchemaVersion` key and omits `evidenceSchemaVersion`, so the grounded /
// QI evidence reader skips it. Persistence failure never fails the request (mirrors the coding-context
// and memory-audit handlers).

import { createHash } from "node:crypto";
import type {
  CodingContextSourceKind,
  CodingContextWirePack,
  EditorTestGenerationWireResponse,
  EvidenceStore,
} from "@oscharko-dev/keiko-contracts";
import { CODING_CONTEXT_SOURCE_KINDS } from "@oscharko-dev/keiko-contracts";
import type { Redactor } from "../deps.js";

export const TEST_GENERATION_EVIDENCE_SCHEMA_VERSION = "1" as const;

// The content-free count of governed coding-context citations that contributed to the generated-test
// context, keyed by source class — repository search, Local Knowledge, memory, Quality Intelligence,
// connected/workflow/files context (Issue #1203 AC6). Counts only; never citation text or ids.
function countBySourceKind(
  context: CodingContextWirePack,
): Readonly<Record<CodingContextSourceKind, number>> {
  const counts = Object.fromEntries(CODING_CONTEXT_SOURCE_KINDS.map((kind) => [kind, 0])) as Record<
    CodingContextSourceKind,
    number
  >;
  for (const entry of context.entries) {
    counts[entry.sourceKind] += 1;
  }
  return counts;
}

// The content-free evidence-source provenance for a response: the contributing source-class counts and
// the total citation count, present only when governed discovery ran (deferred/generated). AC6.
function contextSourceFields(response: EditorTestGenerationWireResponse): Record<string, unknown> {
  if (response.context === undefined) {
    return {};
  }
  return {
    contextCitationCount: response.context.entries.length,
    contextSourceKinds: countBySourceKind(response.context),
  };
}

// Deterministic, content-free run id derived from status + emission time + candidate count.
export function testGenerationEvidenceRunId(
  response: EditorTestGenerationWireResponse,
  emittedAtMs: number,
): string {
  const material = [
    response.status,
    String(emittedAtMs),
    String(response.funnel.candidatesGenerated),
  ].join("\n");
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 16);
  return `editor-test-generation-${digest}`;
}

function provenanceFields(response: EditorTestGenerationWireResponse): Record<string, string> {
  if (response.provenance === undefined) {
    return {};
  }
  return {
    modelId: response.provenance.modelId,
    gatewayPolicyVersion: response.provenance.gatewayPolicyVersion,
    promptHash: response.provenance.promptHash,
  };
}

export function recordTestGenerationEvidence(
  store: EvidenceStore,
  redactor: Redactor,
  response: EditorTestGenerationWireResponse,
  emittedAtMs: number,
): string {
  const runId = testGenerationEvidenceRunId(response, emittedAtMs);
  const manifest = {
    editorTestGenerationSchemaVersion: TEST_GENERATION_EVIDENCE_SCHEMA_VERSION,
    runId,
    status: response.status,
    emittedAtMs,
    ...(response.assurance === undefined ? {} : { assurance: response.assurance }),
    funnel: response.funnel,
    fileCount: response.patch?.files.length ?? 0,
    ...contextSourceFields(response),
    ...provenanceFields(response),
  };
  try {
    store.put(runId, JSON.stringify(redactor(manifest)));
  } catch {
    // Audit persistence is best-effort; a write failure must never fail the user's request.
  }
  return runId;
}
