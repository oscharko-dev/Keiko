"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import {
  redeemCodingAppSessionPairingNavigation,
  redeemCodingAppSessionPairingOnBoot,
} from "@/lib/coding-app-session-client";
import { AppShell } from "./AppShell";

function pairingFragmentPresent(): boolean {
  return window.location.hash.startsWith(CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX);
}

export function KeikoDesktop(): ReactNode {
  const router = useRouter();
  // Redeem a launcher pairing fragment before any surface needs the app session (#2478); the
  // boot entry is single-flight, so StrictMode's second invocation joins the same redemption.
  //
  // The redemption strips the fragment with the history API, but Next's app router captured the
  // initial location -- fragment included -- as its canonical URL at hydration and re-applies that
  // URL from its history updater on every later router state change, so the redeemed attestation
  // came back into the address bar within seconds (#3390, run-30). A same-path replace through the
  // router itself moves the canonical URL to the clean location for good; it is issued only when a
  // fragment was actually present, so an ordinary boot performs no navigation at all.
  useEffect(() => {
    const hadFragment = pairingFragmentPresent();
    void redeemCodingAppSessionPairingOnBoot().then(() => {
      if (!hadFragment) return;
      router.replace(window.location.pathname + window.location.search, { scroll: false });
    });
    // A pairing fragment can also arrive without a page load: opening the launcher URL in the tab
    // that already shows the app -- pasted into its address bar, or navigated by a driver -- is a
    // same-document fragment navigation. It fires `hashchange` and never re-runs the boot effect
    // above, so the attestation was neither redeemed nor stripped (#3390, real runs 30 and 32).
    // By hashchange time the router's mount effect has patched `history.replaceState` to sync
    // external calls into its canonical URL, so this strip lands there directly -- unlike boot,
    // whose child effect runs first and hits the still-native call, hence its explicit replace.
    const onHashChange = (): void => {
      if (!pairingFragmentPresent()) return;
      // A re-pair after a lane restart arrives this way; its redemption re-runs every read that
      // depends on the session, the app-session channel included (F65).
      void redeemCodingAppSessionPairingNavigation();
    };
    window.addEventListener("hashchange", onHashChange);
    return (): void => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [router]);
  return <AppShell />;
}
