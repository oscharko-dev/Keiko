// Deny-list wiring for the Files BFF (`/api/files/*`). Reuses
// `src/workspace/ignore.ts` unchanged: `isDenied` is the always-on security
// gate for content, navigation, and mutations. The tree may show metadata-free,
// unavailable rows for known non-secret runtime directories from an authorized
// parent listing; secrets and their directory names remain excluded.

import { isDenied } from "@oscharko-dev/keiko-workspace";
import { insideProgramFolder } from "./launch-directory.js";

// Generic, non-leaking deny message. NEVER include the requested path or the
// matched pattern: the deny list is treated as a server-side safety invariant
// the client must not be able to probe.
export const DENIED_MESSAGE = "The requested path is excluded from the read surface.";

// A Keiko that runs inside its own program folder (the folder packages and the desktop
// installation, ADR-0121 D9) refuses that folder as a root in the same breath: it holds the program
// files and, in a team package, the gateway configuration with its token. Only an absolute path can
// name it, so every root-relative check stays the deny list alone.
export function pathIsDenied(path: string): boolean {
  return isDenied(path) || insideProgramFolder(path);
}
