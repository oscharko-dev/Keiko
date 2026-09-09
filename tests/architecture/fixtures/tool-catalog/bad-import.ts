// Intentional ADR-0175 violation: catalog descriptors cannot import server-owned handlers.
// arch:check:negative requires the catalog direction rule to fire exactly once for this fixture.
import { violationTarget } from "../../../../packages/keiko-server/src/index.js";
export const violation = violationTarget;
