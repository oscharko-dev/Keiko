"use client";

/**
 * Browser half of the launcher-automatic app-session pairing flow (ADR-0141 D2, finalized by
 * #2478). The trusted launcher opens the app URL with a single-use pairing attestation in the URL
 * fragment; on boot the desktop shell redeems it against the pair endpoint — which answers with a
 * content-free acknowledgement and, on approval, sets the HttpOnly session cookie — and strips the
 * fragment from the address bar and history entry immediately, whether or not it was well-formed.
 *
 * Redemption success is deliberately unobservable here (the acknowledgement never distinguishes
 * approval from denial, and page script cannot read the HttpOnly cookie); the questions surface
 * reports the honest paired/unpaired state through its channel payload instead.
 */

import {
  CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX,
  decodeCodingAppSessionPairingFragment,
  type CodingAppSessionPairingAttestation,
} from "@oscharko-dev/keiko-contracts";
import { bffFetchJson } from "./http";

const PAIR_PATH = "/api/coding-workbench/app-session/pair";

/** Injectable browser seams so the redeem flow is unit-testable without a real window. */
export interface CodingAppSessionPairingSeams {
  readonly readFragment: () => string;
  readonly stripFragment: () => void;
  readonly postPairing: (attestation: CodingAppSessionPairingAttestation) => Promise<unknown>;
}

function defaultSeams(): CodingAppSessionPairingSeams | undefined {
  if (typeof window === "undefined") return undefined;
  return {
    readFragment: (): string => window.location.hash,
    stripFragment: (): void => {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    },
    postPairing: (attestation: CodingAppSessionPairingAttestation): Promise<unknown> =>
      bffFetchJson(PAIR_PATH, {
        method: "POST",
        cache: "no-store",
        body: JSON.stringify(attestation),
      }),
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

let bootRedemption: Promise<boolean> | undefined;

/**
 * Desktop-boot entry: runs the fragment redemption exactly once per page load (StrictMode's second
 * invocation joins the same promise) and remembers it so data surfaces can order behind it.
 */
export function redeemCodingAppSessionPairingOnBoot(): Promise<boolean> {
  bootRedemption ??= redeemCodingAppSessionPairingFragment();
  return bootRedemption;
}

/**
 * Starts the shared boot pairing attempt when a child read effect reaches this before the desktop
 * parent's effect, then resolves once that same attempt has settled. Protected data surfaces await
 * this before their first read so a freshly opened window cannot race its own redemption into a
 * stale `unpaired` state; no timers, retries, or second session state are involved.
 */
export function codingAppSessionPairingSettled(): Promise<boolean> {
  return redeemCodingAppSessionPairingOnBoot();
}
