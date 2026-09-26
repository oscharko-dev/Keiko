// Intentional violation: capability lookup is private to the shared realpath admission boundary.
import { ownedWorkspaceRootAuthority } from "../../../../packages/keiko-workspace/src/ownedRootLookup.js";

export const unauthorizedOwnedRootLookup = ownedWorkspaceRootAuthority;
