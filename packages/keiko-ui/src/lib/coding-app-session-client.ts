"use client";

/**
 * Browser half of the launcher-automatic app-session pairing flow (ADR-0141 D2, finalized by
 * #2478). The trusted launcher may open the app URL with a single-use pairing attestation in the
 * URL fragment; on boot the desktop shell redeems it against the pair endpoint — which answers with
 * a content-free acknowledgement and, on approval, sets the HttpOnly session cookie — and strips the
 * fragment from the address bar and history entry immediately, whether or not it was well-formed.
 * A launcher-authorized local BFF can also ensure that cookie for normal reloads and reused tabs,
 * so the Workbench does not depend on a fragile one-shot fragment after the desktop app is already
 * running.
 *
 * Redemption success is deliberately unobservable here (the acknowledgement never distinguishes
 * approval from denial, and page script cannot read the HttpOnly cookie); the questions surface
 * reports the honest paired/unpaired state through its channel payload instead.
 */

import { useSyncExternalStore } from "react";
import type { CodingAppSessionPairingAttestation } from "@oscharko-dev/keiko-contracts";
import {
  CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX,
  decodeCodingAppSessionPairingFragment,
} from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { newClientCorrelationId } from "./bff-correlation";
import type { ClientSessionRepairStream } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import type { ActivityLogErrorKind } from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  reportClientDiagnostic,
  type ClientDiagnosticSessionRepairReport,
} from "./client-diagnostics";
import { clientErrorSummary } from "./client-error-summary";
import { bffFetchJson, bffRequestErrorKind } from "./http";

const PAIR_PATH = "/api/coding-workbench/app-session/pair";
const LOCAL_SESSION_PATH = "/api/coding-workbench/app-session/local-session";
// The pairing requests are the repair: their denial is final and never starts another repair.
const WITHOUT_SESSION_REPAIR = { repairSession: false } as const;

/** Injectable browser seams so the redeem flow is unit-testable without a real window. */
export interface CodingAppSessionPairingSeams {
  readonly readFragment: () => string;
  readonly stripFragment: () => void;
  readonly postPairing: (attestation: CodingAppSessionPairingAttestation) => Promise<unknown>;
  // `correlationId` is the id the local-session request carries. The caller mints it, so a failure
  // that never reached the server still names its request.
  readonly postLocalSession?: (correlationId: string) => Promise<unknown>;
}

function defaultSeams(): CodingAppSessionPairingSeams | undefined {
  if (typeof window === "undefined") return undefined;
  return {
    readFragment: (): string => window.location.hash,
    stripFragment: (): void => {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    },
    postPairing: (attestation: CodingAppSessionPairingAttestation): Promise<unknown> =>
      bffFetchJson(
        PAIR_PATH,
        { method: "POST", cache: "no-store", body: JSON.stringify(attestation) },
        WITHOUT_SESSION_REPAIR,
      ),
    postLocalSession: (correlationId: string): Promise<unknown> =>
      bffFetchJson(
        LOCAL_SESSION_PATH,
        { method: "POST", cache: "no-store" },
        { ...WITHOUT_SESSION_REPAIR, correlationId },
      ),
  };
}

/**
 * Redeem a launcher pairing fragment if the current location carries one. Returns `true` when an
 * attestation was posted, `false` otherwise; never throws. The fragment is stripped as soon as its
 * prefix matches — a malformed payload is removed without being sent anywhere.
 */
export async function redeemCodingAppSessionPairingFragment(
  seams: CodingAppSessionPairingSeams | undefined = defaultSeams(),
): Promise<boolean> {
  if (seams === undefined) return false;
  const fragment = seams.readFragment();
  if (!fragment.startsWith(CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX)) return false;
  seams.stripFragment();
  const attestation = decodeCodingAppSessionPairingFragment(fragment);
  if (attestation === undefined) return false;
  try {
    await seams.postPairing(attestation);
    return true;
  } catch {
    // The pair endpoint acknowledges without distinguishing outcomes; a transport failure leaves
    // the window unpaired, which the questions surface reports honestly (#2478).
    return false;
  }
}

/**
 * Ask a launcher-authorized local BFF to ensure this browser has an app-session cookie. The endpoint
 * intentionally acknowledges without revealing whether a cookie was issued; subsequent channel reads
 * report the honest paired/unpaired state.
 */
type LocalSessionOutcome =
  | { readonly repaired: true }
  | { readonly repaired: false; readonly errorKind: ActivityLogErrorKind };

// The ensure request's outcome with the closed class of a failure, for the repair's evidence. The
// endpoint acknowledges whether or not it issued a cookie, so a thrown error is a real failure
// (transport, 5xx), recorded rather than swallowed: under the ensure request's own correlation id
// and with its closed failure class, also when `fetch` rejected before any response (#3557 review).
async function localSessionOutcome(
  seams: CodingAppSessionPairingSeams | undefined,
  correlationId: string,
): Promise<LocalSessionOutcome> {
  if (seams?.postLocalSession === undefined) return { repaired: false, errorKind: "unavailable" };
  try {
    await seams.postLocalSession(correlationId);
    return { repaired: true };
  } catch (error) {
    const errorKind = bffRequestErrorKind(error);
    // i18n-exempt: body-free diagnostic message for the activity log, never rendered
    reportClientDiagnostic(
      `[keiko] local app session ensure failed: ${clientErrorSummary(error)}`,
      {
        correlationId,
        errorKind,
      },
    );
    return { repaired: false, errorKind };
  }
}

export async function ensureLocalCodingAppSession(
  seams: CodingAppSessionPairingSeams | undefined = defaultSeams(),
): Promise<boolean> {
  return (await localSessionOutcome(seams, newClientCorrelationId())).repaired;
}

/** One shared repair attempt: whether it succeeded, and the id its local-session request carried. */
export interface LocalCodingAppSessionRepair {
  readonly repaired: boolean;
  readonly correlationId: string;
  // The closed class of the failed local-session request, when the repair failed.
  readonly errorKind?: ActivityLogErrorKind | undefined;
}

let localSessionRepair: Promise<LocalCodingAppSessionRepair> | undefined;

/**
 * Re-establishes the local app session a restarted BFF dropped (ADR-0141 D5). A restart denies every
 * open surface at once; they all join the one attempt in flight instead of each posting its own, and
 * the next denial after it settled starts a fresh one. Every joiner learns the repair request's
 * correlation id, so its own evidence can name the repair it waited for.
 */
export function repairLocalCodingAppSessionWithEvidence(): Promise<LocalCodingAppSessionRepair> {
  if (localSessionRepair === undefined) {
    const correlationId = newClientCorrelationId();
    localSessionRepair = localSessionOutcome(defaultSeams(), correlationId)
      .then((outcome): LocalCodingAppSessionRepair =>
        outcome.repaired
          ? { repaired: true, correlationId }
          : { repaired: false, correlationId, errorKind: outcome.errorKind },
      )
      .finally(() => {
        localSessionRepair = undefined;
      });
  }
  return localSessionRepair;
}

/** {@link repairLocalCodingAppSessionWithEvidence}, for callers that need only the verdict. */
export async function repairLocalCodingAppSession(): Promise<boolean> {
  return (await repairLocalCodingAppSessionWithEvidence()).repaired;
}

/** A stream's session repair: whether its local-session request was acknowledged, and its id. */
export interface StreamSessionRepair {
  readonly acknowledged: boolean;
  readonly repairCorrelationId: string;
}

// An EventSource exposes no request id, so a stream's repair is reported under its failure streak,
// the id its error diagnostics carry too (#3557 review).
function reportStreamSessionRepair(
  stream: ClientSessionRepairStream,
  streakCorrelationId: string,
  report: Omit<ClientDiagnosticSessionRepairReport, "stream">,
): void {
  // i18n-exempt: body-free diagnostic message for the activity log, never rendered
  reportClientDiagnostic(`[keiko] ${stream} stream session repair: ${report.outcome}`, {
    correlationId: streakCorrelationId,
    sessionRepairReport: { ...report, stream },
  });
}

/**
 * {@link repairLocalCodingAppSessionWithEvidence} for a stream whose reconnects a restarted BFF
 * denies (#3557 review). A failed repair is reported at once, with its closed failure class. An
 * acknowledged one is not yet a recovery: the endpoint acknowledges whether or not it issued a
 * cookie, so only the stream's next successful open reports it ({@link reportStreamSessionRecovered}).
 */
export async function repairLocalCodingAppSessionForStream(
  stream: ClientSessionRepairStream,
  streakCorrelationId: string,
): Promise<StreamSessionRepair> {
  const repair = await repairLocalCodingAppSessionWithEvidence();
  if (!repair.repaired) {
    reportStreamSessionRepair(stream, streakCorrelationId, {
      outcome: "repair-failed",
      repairCorrelationId: repair.correlationId,
      errorKind: repair.errorKind,
    });
  }
  return { acknowledged: repair.repaired, repairCorrelationId: repair.correlationId };
}

/** A stream opened again after an acknowledged repair in its failure streak: it recovered. */
export function reportStreamSessionRecovered(
  stream: ClientSessionRepairStream,
  streakCorrelationId: string,
  repairCorrelationId: string,
): void {
  reportStreamSessionRepair(stream, streakCorrelationId, {
    outcome: "stream-repaired",
    repairCorrelationId,
  });
}

async function bootCodingAppSession(): Promise<boolean> {
  const redeemed = await redeemCodingAppSessionPairingFragment();
  const ensured = await ensureLocalCodingAppSession();
  return redeemed || ensured;
}

let bootRedemption: Promise<boolean> | undefined;

/**
 * Desktop-boot entry: runs the app-session bootstrap exactly once per page load (StrictMode's
 * second invocation joins the same promise) and remembers it so data surfaces can order behind it.
 */
export function redeemCodingAppSessionPairingOnBoot(): Promise<boolean> {
  bootRedemption ??= bootCodingAppSession();
  return bootRedemption;
}

/**
 * Starts the shared boot pairing attempt when a child read effect reaches this before the desktop
 * parent's effect, then resolves once that same attempt has settled. Protected data surfaces await
 * this before their first read so a freshly opened window cannot race its own bootstrap into a stale
 * `unpaired` state; no timers, retries, or second session state are involved.
 */
export function codingAppSessionPairingSettled(): Promise<boolean> {
  return redeemCodingAppSessionPairingOnBoot();
}

// F65: a pairing can arrive without a page load (the launcher link opened in the tab that already
// shows the app, after a lane restart dropped its session), long after the boot attempt every
// protected read orders behind. Each such redemption that posted an attestation is counted here,
// and every read that depends on the session re-runs on the count, the app-session channel
// included. The boot redemption is not counted: every read already waits for it.
let navigationRedemptions = 0;
const redemptionListeners = new Set<() => void>();

function subscribeToRedemptions(listener: () => void): () => void {
  redemptionListeners.add(listener);
  return (): void => {
    redemptionListeners.delete(listener);
  };
}

function redemptionCount(): number {
  return navigationRedemptions;
}

function publishSessionRefresh(): void {
  navigationRedemptions += 1;
  for (const listener of redemptionListeners) listener();
}

/** Notify readers that the browser session was restored without a page load. */
export function notifyCodingAppSessionChanged(): void {
  publishSessionRefresh();
}

/** How many pairings or local restores this window completed after boot; session reads re-run on it. */
export function useCodingAppSessionRedemptions(): number {
  return useSyncExternalStore(subscribeToRedemptions, redemptionCount, () => 0);
}

/**
 * Redeems a pairing fragment that arrived by same-document navigation (`hashchange`). It waits for
 * a boot attempt already under way and never starts one, because a fragment present at boot
 * belongs to that attempt; an attestation it posts re-runs every read that depends on the session.
 */
export async function redeemCodingAppSessionPairingNavigation(
  seams: CodingAppSessionPairingSeams | undefined = defaultSeams(),
): Promise<boolean> {
  await bootRedemption;
  if (!(await redeemCodingAppSessionPairingFragment(seams))) return false;
  await ensureLocalCodingAppSession(seams);
  publishSessionRefresh();
  return true;
}
