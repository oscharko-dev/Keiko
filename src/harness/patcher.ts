// Re-export shim: harness patch/verification/reporting handlers live in
// @oscharko-dev/keiko-harness (issue #164, ADR-0019). These are harness internals —
// kept on the package barrel only so this legacy shim resolves without
// subpath-importing into the package.

export {
  handlePatchProposal,
  handleReporting,
  handleVerification,
} from "@oscharko-dev/keiko-harness";
