// Re-export shim: the evidence report payload + renderer live in @oscharko-dev/keiko-evidence
// (issue #163, ADR-0019).

export {
  buildEvidenceReport,
  renderEvidenceReport,
  type EvidenceReport,
} from "@oscharko-dev/keiko-evidence";
