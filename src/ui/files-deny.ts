// Deny-list wiring for the Files BFF (`/api/files/*`). Reuses
// `src/workspace/ignore.ts` unchanged: `isDenied` is the always-on security
// gate that filters secret/dep/build/vcs/log entries from both tree listings
// and previews. See ADR-0016.

import { isDenied } from "../workspace/ignore.js";

// Generic, non-leaking deny message. NEVER include the requested path or the
// matched pattern: the deny list is treated as a server-side safety invariant
// the client must not be able to probe.
export const DENIED_MESSAGE = "The requested path is excluded from the read surface.";

export function pathIsDenied(relativePath: string): boolean {
  return isDenied(relativePath);
}
