import type { EvidenceStore, ManagedLspEvidence } from "@oscharko-dev/keiko-contracts";

const LEDGER_SCHEMA_VERSION = "1" as const;
const MAX_EVIDENCE_RECORDS = 128;

export type ManagedLspEvidenceProjection = "projected" | "canonicalOnly";

export type ManagedLspEvidenceProjector = (
  workspaceFingerprint: string,
  evidence: readonly ManagedLspEvidence[],
) => ManagedLspEvidenceProjection;

interface ManagedLspEvidenceLedger {
  readonly schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  readonly kind: "managedLspActivationLedger";
  readonly records: readonly ManagedLspEvidence[];
}

function ledgerJson(evidence: readonly ManagedLspEvidence[]): string {
  const ledger: ManagedLspEvidenceLedger = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    kind: "managedLspActivationLedger",
    records: evidence.slice(-MAX_EVIDENCE_RECORDS),
  };
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

export function createManagedLspEvidenceProjector(
  store: EvidenceStore,
  onFailure: ((error: unknown) => void) | undefined,
): ManagedLspEvidenceProjector {
  return (workspaceFingerprint, evidence): ManagedLspEvidenceProjection => {
    const runId = `managed-lsp-${workspaceFingerprint}`;
    try {
      if (store.update !== undefined) {
        store.update(runId, () => ledgerJson(evidence));
      } else {
        store.put(runId, ledgerJson(evidence));
      }
      return "projected";
    } catch (error: unknown) {
      onFailure?.(error);
      return "canonicalOnly";
    }
  };
}
