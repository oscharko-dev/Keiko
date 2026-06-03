// Re-export shim: workspace deny/ignore rules now live in @oscharko-dev/keiko-workspace (issue #161).
export {
  compileIgnore,
  DEFAULT_DENY_PATTERNS,
  isDenied,
  isIgnored,
} from "@oscharko-dev/keiko-workspace";
export type { IgnoreMatcher } from "@oscharko-dev/keiko-workspace";
