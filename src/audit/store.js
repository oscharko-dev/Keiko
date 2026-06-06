// Re-export shim: the EvidenceStore port + node adapter live in @oscharko-dev/keiko-evidence
// (issue #163, ADR-0019).
export { createInMemoryEvidenceStore, createNodeEvidenceStore, DEFAULT_EVIDENCE_DIR, resolveEvidenceDir, } from "@oscharko-dev/keiko-evidence";
