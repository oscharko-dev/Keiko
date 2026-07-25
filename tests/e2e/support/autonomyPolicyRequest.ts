import { isCodingWorkbenchMode, type CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";

/**
 * Decodes an autonomy-policy update body for the Coding Workbench runtime fixture.
 *
 * A malformed or unknown mode must never enter fixture state: the surface under test would then be
 * answered with an authority value the real server would have rejected, and a projection bug could
 * pass as a server-confirmed result. Returns `null` for every input the server would refuse, so the
 * caller can fail closed instead of persisting it.
 */
export function parsedRequestedMode(payload: string | null): CodingWorkbenchMode | null {
  if (payload === null) return null;
  let body: unknown;
  try {
    body = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const requested = (body as Record<string, unknown>).requestedMode;
  return isCodingWorkbenchMode(requested) ? requested : null;
}
