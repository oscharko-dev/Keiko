// Re-export shim: harness fingerprinting + ID sources live in @oscharko-dev/keiko-harness
// (issue #164, ADR-0019). `canonicalise` itself originates in @oscharko-dev/keiko-security
// and is re-exported from the harness barrel for one-import-source.

export {
  canonicalise,
  configFingerprint,
  counterIdSource,
  defaultFingerprinter,
  defaultIdSource,
} from "@oscharko-dev/keiko-harness";
