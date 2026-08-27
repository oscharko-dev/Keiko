import type { UpdateMemoryAutonomyPolicyWire } from "@oscharko-dev/keiko-contracts";
import { parseUpdateMemoryAutonomyPolicyWire } from "@oscharko-dev/keiko-contracts/runtime/bff-wire";

/**
 * Decodes an autonomy-policy update body for the Coding Workbench runtime fixture.
 *
 * A malformed or unknown mode must never enter fixture state: the surface under test would then be
 * answered with an authority value the real server would have rejected, and a projection bug could
 * pass as a server-confirmed result. The fixture delegates the body shape to the production
 * contract parser and returns `null` for every input the server would refuse.
 */
export function parsedAutonomyPolicyUpdate(
  payload: string | null,
): UpdateMemoryAutonomyPolicyWire | null {
  if (payload === null) return null;
  let body: unknown;
  try {
    body = JSON.parse(payload);
  } catch {
    return null;
  }
  return parseUpdateMemoryAutonomyPolicyWire(body) ?? null;
}
