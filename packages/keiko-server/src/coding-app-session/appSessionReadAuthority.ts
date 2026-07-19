// Read-authority guard for content-bearing Code routes (ADR-0141 D2, #2478 W1.5).
//
// A route handler that serves (or mutates) content calls this before ANY runId or runtime
// resolution. No authority means the caller must return its constant content-free projection —
// for reads — or the existence-concealing not-found result — for question mutations — without
// touching run-derived state, so an unpaired probe can never distinguish "not paired" from "does
// not exist" (ADR-0141 D6). The W1.6–W1.9 content surfaces (transcript, plan, tool activity,
// diffs) join by calling this same guard; no re-plumbing is required.

import type { IncomingMessage } from "node:http";
import type { UiHandlerDeps } from "../deps.js";
import { readSessionCookie } from "./sessionCookie.js";
import type { AppSession } from "./sessionRegistry.js";

/**
 * Resolve the request's app-session read authority, or `undefined` for every request that does not
 * present a valid session cookie. Fail-closed by construction: an absent channel (no composition)
 * grants nothing, exactly like an absent pairing port grants no session (ADR-0141 D2).
 */
export function resolveAppSessionReadAuthority(
  deps: Pick<UiHandlerDeps, "codingAppSessionChannel">,
  req: IncomingMessage,
): AppSession | undefined {
  return deps.codingAppSessionChannel?.verifySession(readSessionCookie(req));
}
