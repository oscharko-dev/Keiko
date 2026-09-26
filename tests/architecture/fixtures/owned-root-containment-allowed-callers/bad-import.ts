// Intentional violation: only reviewed lifecycle owners may bypass ordinary workspace-root
// admission after independently proving ownership and containment.
import { assertContainedRealPathWithinOwnedRoot } from "@oscharko-dev/keiko-workspace/internal/owned-root";

export const unauthorizedOwnedRootContainment = assertContainedRealPathWithinOwnedRoot;
