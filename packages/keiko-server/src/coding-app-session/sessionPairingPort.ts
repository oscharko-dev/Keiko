// Server-private pairing authority seam for the authenticated local app-session channel
// (ADR-0141 D2). Given a launcher-attested pairing request, the port decides whether the request
// proves the trusted local app session. The production implementation (launcherSessionPairingPort.ts)
// binds to a trusted launcher/OS authority; a deterministic fake (sessionPairingPort.testsupport.ts)
// exists only for CI. Absence of a port is an intentional fail-closed production posture: no session
// is issued and every content read stays content-free.
//
// This seam mints read authority, so — exactly like the runtime start-confirmation consumer
// (codingRuntimeStartConfirmation.ts) — production composition must never construct or fall back to
// the fake. The bounds here are the outer envelope the launcher attestation must satisfy before the
// port even evaluates it.

import type { CodingAppSessionPairingAttestation } from "@oscharko-dev/keiko-contracts";

// The attestation WIRE shape, its bounds, and its structural gate were promoted to
// `keiko-contracts` in W1.5 (#2478) so the browser client and the launcher share one definition;
// this module re-exports them under the established server-local names, and the authority seam
// below (port, decision, denial) stays server-private.
export {
  CODING_APP_SESSION_PAIRING_REQUEST_ID_MAX_CHARS as SESSION_PAIRING_REQUEST_ID_MAX_CHARS,
  CODING_APP_SESSION_PAIRING_CLAIM_MAX_CHARS as SESSION_PAIRING_CLAIM_MAX_CHARS,
  CODING_APP_SESSION_PAIRING_PRINCIPAL_LABEL_MAX_CHARS as SESSION_PAIRING_PRINCIPAL_LABEL_MAX_CHARS,
  isWellFormedCodingAppSessionPairingAttestation as isWellFormedSessionPairingAttestation,
} from "@oscharko-dev/keiko-contracts";

/** A launcher-minted, single-use, process-bound pairing attestation presented at the pair endpoint. */
export type SessionPairingAttestation = CodingAppSessionPairingAttestation;

/** The port's decision. `denied` never distinguishes why, so a probe learns nothing from it. */
export type SessionPairingDecision =
  | { readonly outcome: "approved"; readonly principalLabel: string }
  | { readonly outcome: "denied" };

/** The pairing authority seam. Synchronous, in-memory, and fail-closed by default. */
export interface SessionPairingPort {
  readonly attest: (attestation: SessionPairingAttestation) => SessionPairingDecision;
}

/** A single denied decision reused everywhere so no call site invents a divergent shape. */
export const SESSION_PAIRING_DENIED: SessionPairingDecision = { outcome: "denied" };
