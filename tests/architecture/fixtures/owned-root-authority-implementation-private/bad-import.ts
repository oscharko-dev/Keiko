// Intentional violation: callers must use one of the separately governed capability facades and
// may never import the WeakMap implementation directly.
import { workspaceFsWithOwnedRootAuthority } from "../../../../packages/keiko-workspace/src/ownedRootAuthority.js";

export const unauthorizedOwnedRootImplementation = workspaceFsWithOwnedRootAuthority;
