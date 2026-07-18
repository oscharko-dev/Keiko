// The authenticated local app-session channel primitive (ADR-0141 D2, D3, D6).
//
// This is the runtime-neutral core the later waves build on: pairing issues a session through the
// pairing port; reads project a bounded content payload only for a valid session, and fail closed to
// the byte-identical content-free projection otherwise — never an error that reveals whether a session
// or protected content exists. The channel is pure logic and owns no transport; the routes handle
// HTTP, cookies, and streaming. A content source is injected (W1.6+ feeds transcript/plan/diffs); in
// this wave production leaves it absent, so even a paired session reads content-free until W1.5.

import {
  contentFreeCodingAppSessionChannelSnapshot,
  validateCodingAppSessionChannelContent,
  validateCodingAppSessionChannelSnapshot,
  type CodingAppSessionChannelContent,
  type CodingAppSessionChannelSnapshot,
} from "./channelContract.js";
import {
  isWellFormedSessionPairingAttestation,
  type SessionPairingPort,
} from "./sessionPairingPort.js";
import type { AppSession, SessionRegistry } from "./sessionRegistry.js";

/** Source of the bounded content a paired session may read. Absent means the channel is content-free. */
export interface CodingAppSessionContentSource {
  readonly contentFor: (session: AppSession) => CodingAppSessionChannelContent | null;
}

export type CodingAppSessionPairResult =
  { readonly paired: true; readonly cookieToken: string } | { readonly paired: false };

export type CodingAppSessionRotateResult =
  { readonly rotated: true; readonly cookieToken: string } | { readonly rotated: false };

export interface CodingAppSessionChannel {
  readonly pair: (attestation: unknown) => CodingAppSessionPairResult;
  readonly snapshot: (cookieToken: string | undefined) => CodingAppSessionChannelSnapshot;
  readonly rotate: (cookieToken: string | undefined) => CodingAppSessionRotateResult;
  readonly signOut: (cookieToken: string | undefined) => void;
  readonly sessionCount: () => number;
  /**
   * Verify a presented cookie token into its live session, or `undefined` for every invalid,
   * revoked, or expired presentation. This is the read-authority primitive the W1.5 route guard
   * (and the later W1.6–W1.9 content surfaces) enforce content-bearing reads with (#2478); a
   * successful verification refreshes the session's inactivity window.
   */
  readonly verifySession: (cookieToken: string | undefined) => AppSession | undefined;
}

export interface CodingAppSessionChannelDeps {
  readonly registry: SessionRegistry;
  /** Absent = fail-closed production posture: no session issuable, every read content-free. */
  readonly pairingPort?: SessionPairingPort | undefined;
  /** Absent = channel serves content-free even to a paired session (this wave's production posture). */
  readonly contentSource?: CodingAppSessionContentSource | undefined;
}

function projectContent(
  session: AppSession,
  contentSource: CodingAppSessionContentSource | undefined,
): CodingAppSessionChannelSnapshot {
  if (contentSource === undefined) return contentFreeCodingAppSessionChannelSnapshot();
  const content = contentSource.contentFor(session);
  if (content === null || !validateCodingAppSessionChannelContent(content).ok) {
    return contentFreeCodingAppSessionChannelSnapshot();
  }
  const snapshot: CodingAppSessionChannelSnapshot = {
    schemaVersion: contentFreeCodingAppSessionChannelSnapshot().schemaVersion,
    content,
  };
  // Never emit a snapshot that would breach the aggregate budget; fail closed to content-free.
  return validateCodingAppSessionChannelSnapshot(snapshot).ok
    ? snapshot
    : contentFreeCodingAppSessionChannelSnapshot();
}

export function createCodingAppSessionChannel(
  deps: CodingAppSessionChannelDeps,
): CodingAppSessionChannel {
  const { registry, pairingPort, contentSource } = deps;
  return {
    pair: (attestation: unknown): CodingAppSessionPairResult => {
      if (pairingPort === undefined) return { paired: false };
      if (!isWellFormedSessionPairingAttestation(attestation)) return { paired: false };
      const decision = pairingPort.attest(attestation);
      if (decision.outcome !== "approved") return { paired: false };
      const mint = registry.mint(decision.principalLabel);
      return { paired: true, cookieToken: mint.cookieToken };
    },
    snapshot: (cookieToken: string | undefined): CodingAppSessionChannelSnapshot => {
      const session = registry.verify(cookieToken);
      if (session === undefined) return contentFreeCodingAppSessionChannelSnapshot();
      return projectContent(session, contentSource);
    },
    rotate: (cookieToken: string | undefined): CodingAppSessionRotateResult => {
      const session = registry.verify(cookieToken);
      if (session === undefined) return { rotated: false };
      const mint = registry.rotate(session.sessionId);
      return mint === undefined
        ? { rotated: false }
        : { rotated: true, cookieToken: mint.cookieToken };
    },
    signOut: (cookieToken: string | undefined): void => {
      const session = registry.verify(cookieToken);
      if (session !== undefined) registry.revoke(session.sessionId);
    },
    sessionCount: (): number => registry.sessionCount(),
    verifySession: (cookieToken: string | undefined): AppSession | undefined =>
      registry.verify(cookieToken),
  };
}
