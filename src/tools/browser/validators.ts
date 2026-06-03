// Re-export shim: CDP validators (loopback / port / navigate URL) live in
// @oscharko-dev/keiko-tools (issue #162, ADR-0019). All existing import sites
// (`from "../tools/browser/validators.js"`) keep resolving unchanged via this barrel.

export {
  isLoopbackHost,
  isLoopbackUrl,
  normalizeCdpPort,
  normalizeNavigateUrl,
} from "@oscharko-dev/keiko-tools";
