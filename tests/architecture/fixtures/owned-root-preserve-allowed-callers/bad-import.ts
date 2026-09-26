// Intentional violation: only reviewed filesystem wrappers may propagate an already-minted exact
// owned-root capability.
import { preserveOwnedRootAuthority } from "@oscharko-dev/keiko-workspace/internal/owned-root-preserve";

export const unauthorizedOwnedRootPreserver = preserveOwnedRootAuthority;
