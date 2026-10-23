// The sensitive path-name patterns `isDenied` reads. The one list lives in keiko-contracts (the leaf
// that the native sandbox profile reads too); this sibling module re-exports it so `ignore.ts` imports
// it by a relative path. The OpenCode service host ships `ignore.js` as a self-contained bundle and
// stages the compiled contracts module under this file name beside it (#3897), so the bundle needs no
// package resolution and still reads the identical list.
export {
  CREDENTIAL_PATH_DENY_PATTERNS,
  ENV_EXAMPLE_BASENAME,
  TOOL_STATE_PATH_DENY_PATTERNS,
} from "@oscharko-dev/keiko-contracts/sensitive-path-patterns";
