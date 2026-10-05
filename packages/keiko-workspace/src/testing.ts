// Sanctioned test-only entrypoint for the keiko-workspace in-memory `WorkspaceFs` fake. Mirrors
// the `@oscharko-dev/keiko-local-knowledge/testing` subpath so downstream packages import a
// supported helper instead of reaching into private `src/_memfs.js` deep paths (GEN-DUP-NEAR-010).
// This module is build-included and shipped as `./testing`; production code must never import it.

import * as repoSearchScan from "./repoSearchScan.js";

export { memFs } from "./_memfs.js";

// Downstream producer tests measure the real safe-classification phase through this sanctioned
// test boundary. This is the existing implementation, not a replacement classifier or raw read.
export const fileListingClassifierForTests: Pick<
  typeof repoSearchScan,
  "fileListingTextIsReadable"
> = repoSearchScan;
