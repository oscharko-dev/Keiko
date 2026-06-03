// Re-export shim: the patch workflow lives in @oscharko-dev/keiko-tools (issue #162, ADR-0019).
// All existing import sites (`from "../tools/patch.js"`) keep resolving unchanged via this barrel.

export {
  applyPatch,
  renderDryRun,
  validatePatch,
  type ApplyDeps,
  type ValidateDeps,
} from "@oscharko-dev/keiko-tools";
