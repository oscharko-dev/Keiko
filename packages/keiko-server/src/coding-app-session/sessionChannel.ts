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
import { contentFreeErrorClass, type ServerDiagnosticSink } from "../diagnostics-log.js";

export const CODING_APP_SESSION_MAX_LIVE_STREAMS = 32;

/** Source of the bounded content a paired session may read. Absent means the channel is content-free. */
export interface CodingAppSessionContentSource {
  readonly contentFor: (session: AppSession) => CodingAppSessionChannelContent | null;
  readonly subscribeContent?:
    | ((listener: (content: CodingAppSessionChannelContent | null) => void) => {
        readonly admitted: boolean;
        readonly detach: () => void;
      })
    | undefined;
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
  readonly subscribe: (
    cookieToken: string | undefined,
    listener: (snapshot: CodingAppSessionChannelSnapshot) => boolean,
  ) => {
    readonly snapshot: CodingAppSessionChannelSnapshot;
    readonly live: boolean;
    readonly detach: () => void;
  };
}

export interface CodingAppSessionChannelDeps {
  readonly registry: SessionRegistry;
  /** Absent = fail-closed production posture: no session issuable, every read content-free. */
  readonly pairingPort?: SessionPairingPort | undefined;
  /** Absent = channel serves content-free even to a paired session (this wave's production posture). */
  readonly contentSource?: CodingAppSessionContentSource | undefined;
  /**
   * When present, mid-stream listener failures (a `false` return or a throw from the SSE writer)
   * are recorded as one redacted operator record per subscriber. Previously the failure was
   * silently swallowed and the wire detached — the operator saw a dropped stream with nothing to
   * diagnose. KEIKO-0225.
   */
  readonly diagnostics?: ServerDiagnosticSink | undefined;
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

function snapshotForContent(
  content: CodingAppSessionChannelContent | null,
): CodingAppSessionChannelSnapshot {
  if (content === null || !validateCodingAppSessionChannelContent(content).ok) {
    return contentFreeCodingAppSessionChannelSnapshot();
  }
  const snapshot: CodingAppSessionChannelSnapshot = {
    schemaVersion: contentFreeCodingAppSessionChannelSnapshot().schemaVersion,
    content,
  };
  return validateCodingAppSessionChannelSnapshot(snapshot).ok
    ? snapshot
    : contentFreeCodingAppSessionChannelSnapshot();
}

function subscribeToContent(
  registry: SessionRegistry,
  contentSource: CodingAppSessionContentSource | undefined,
  cookieToken: string | undefined,
  listener: (snapshot: CodingAppSessionChannelSnapshot) => boolean,
  admission: LiveSubscriptionAdmission,
  diagnostics: ServerDiagnosticSink | undefined,
): ReturnType<CodingAppSessionChannel["subscribe"]> {
  const session = registry.verify(cookieToken);
  const snapshot =
    session === undefined
      ? contentFreeCodingAppSessionChannelSnapshot()
      : projectContent(session, contentSource);
  if (session === undefined || contentSource?.subscribeContent === undefined) {
    return { snapshot, live: false, detach: (): void => undefined };
  }
  return liveSubscription(
    registry,
    contentSource,
    cookieToken,
    snapshot,
    listener,
    admission,
    diagnostics,
  );
}

function recordSseFailure(
  diagnostics: ServerDiagnosticSink | undefined,
  message: string,
  errorClass: string,
): void {
  if (diagnostics === undefined) return;
  try {
    diagnostics.record({
      correlationId: "coding-app-session",
      timestamp: new Date().toISOString(),
      operation: "coding-app-session.channel.subscribe",
      source: "coding-app-session.session-channel.publish",
      errorClass,
      message,
    });
  } catch {
    // Diagnostic sink misbehaviour must not corrupt fan-out.
  }
}

interface LiveSubscriptionAdmission {
  readonly acquire: () => boolean;
  readonly release: () => void;
}

function rejectedSourceSubscription(
  source: ReturnType<NonNullable<CodingAppSessionContentSource["subscribeContent"]>> | undefined,
  detach: () => void,
  snapshot: CodingAppSessionChannelSnapshot,
): ReturnType<CodingAppSessionChannel["subscribe"]> {
  source?.detach();
  detach();
  return { snapshot, live: false, detach: (): void => undefined };
}

interface LiveLifecycle {
  active: boolean;
  sourceDetach: () => void;
  expiryTimer?: ReturnType<typeof setInterval>;
}

function makeDetach(lifecycle: LiveLifecycle, admission: LiveSubscriptionAdmission): () => void {
  return (): void => {
    if (!lifecycle.active) return;
    lifecycle.active = false;
    if (lifecycle.expiryTimer !== undefined) clearInterval(lifecycle.expiryTimer);
    lifecycle.sourceDetach();
    admission.release();
  };
}

function makePublish(
  lifecycle: LiveLifecycle,
  validity: () => boolean,
  listener: (snapshot: CodingAppSessionChannelSnapshot) => boolean,
  detach: () => void,
  diagnostics: ServerDiagnosticSink | undefined,
): (content: CodingAppSessionChannelContent | null) => void {
  return (content: CodingAppSessionChannelContent | null): void => {
    if (!lifecycle.active) return;
    const valid = validity();
    try {
      const accepted = listener(
        valid ? snapshotForContent(content) : contentFreeCodingAppSessionChannelSnapshot(),
      );
      if (!valid || !accepted) {
        // KEIKO-0225: previously a listener returning `false` silently detached with nothing to
        // diagnose. Report backpressure once so operators can see a stream that dropped.
        if (valid && !accepted) recordSseFailure(diagnostics, "backpressure", "Error");
        detach();
      }
    } catch (error) {
      recordSseFailure(diagnostics, "listener-threw", contentFreeErrorClass(error));
      detach();
    }
  };
}

function liveSubscription(
  registry: SessionRegistry,
  contentSource: CodingAppSessionContentSource,
  cookieToken: string | undefined,
  snapshot: CodingAppSessionChannelSnapshot,
  listener: (snapshot: CodingAppSessionChannelSnapshot) => boolean,
  admission: LiveSubscriptionAdmission,
  diagnostics: ServerDiagnosticSink | undefined,
): ReturnType<CodingAppSessionChannel["subscribe"]> {
  if (!admission.acquire()) return { snapshot, live: false, detach: (): void => undefined };
  const lifecycle: LiveLifecycle = { active: true, sourceDetach: (): void => undefined };
  const detach = makeDetach(lifecycle, admission);
  const validity = (): boolean => registry.inspect(cookieToken) !== undefined;
  const publish = makePublish(lifecycle, validity, listener, detach, diagnostics);
  const sourceSubscription = contentSource.subscribeContent?.(publish);
  if (!sourceSubscription?.admitted)
    return rejectedSourceSubscription(sourceSubscription, detach, snapshot);
  if (!lifecycle.active) {
    sourceSubscription.detach();
    return { snapshot, live: false, detach: (): void => undefined };
  }
  lifecycle.sourceDetach = sourceSubscription.detach;
  lifecycle.expiryTimer = setInterval(() => {
    if (!validity()) publish(null);
  }, 1_000);
  lifecycle.expiryTimer.unref();
  return { snapshot, live: true, detach };
}

function makeLiveSubscriptionAdmission(): LiveSubscriptionAdmission {
  let liveSubscriptions = 0;
  return {
    acquire: (): boolean => {
      if (liveSubscriptions >= CODING_APP_SESSION_MAX_LIVE_STREAMS) return false;
      liveSubscriptions += 1;
      return true;
    },
    release: (): void => {
      liveSubscriptions = Math.max(0, liveSubscriptions - 1);
    },
  };
}

export function createCodingAppSessionChannel(
  deps: CodingAppSessionChannelDeps,
): CodingAppSessionChannel {
  const { registry, pairingPort, contentSource, diagnostics } = deps;
  const admission = makeLiveSubscriptionAdmission();
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
    subscribe: (cookieToken, listener) =>
      subscribeToContent(registry, contentSource, cookieToken, listener, admission, diagnostics),
  };
}
