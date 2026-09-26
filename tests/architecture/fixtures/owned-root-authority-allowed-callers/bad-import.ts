// Intentional violation: only lifecycle owners and the central per-operation authority resolver
// may acquire an exact-root capability for a globally denied Keiko-owned workspace root.
import { workspaceFsWithOwnedRootAuthority } from "@oscharko-dev/keiko-workspace/internal/owned-root-mint";

export const unauthorizedOwnedRootBinder = workspaceFsWithOwnedRootAuthority;
