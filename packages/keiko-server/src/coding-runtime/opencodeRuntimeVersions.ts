/**
 * The server's name for the one version boundary of the OpenCode integration (#3908). The pins
 * live in `@oscharko-dev/keiko-contracts` (`opencode-runtime-pins.json`); a routine upgrade adds
 * the new version's pin there, regenerates the producer-derived fixtures and, once the npm runtime
 * packages carrying it are published, retires the previous entry. No other module restates a
 * version-specific identity, which `opencodeRuntimeVersions.test.ts` enforces.
 */
export {
  OPENCODE_PINNED_VERSION,
  OPENCODE_RUNTIME_VERSION_PINS,
  isApprovedOpenCodeRuntimeVersion,
  openCodeRuntimeVersionPin,
  type OpenCodeRuntimeVersionPin,
} from "@oscharko-dev/keiko-contracts/runtime/opencode-runtime-pins";
