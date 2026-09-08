"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { redeemCodingAppSessionPairingOnBoot } from "@/lib/coding-app-session-client";
import { AppShell } from "./AppShell";

export function KeikoDesktop(): ReactNode {
  const router = useRouter();
  // Redeem a launcher pairing fragment before any surface needs the app session (#2478); the
  // boot entry is single-flight, so StrictMode's second invocation joins the same redemption.
  //
  // The redemption strips the fragment with the history API, but Next's app router captured the
  // initial location -- fragment included -- as its canonical URL at hydration and re-applies that
  // URL from its history updater on every later router state change, so the redeemed attestation
  // came back into the address bar within seconds (#3390, rehearsal run-30). A same-path replace
  // through the router itself moves the canonical URL to the clean location for good; it is issued
  // only when a fragment was actually present, so an ordinary boot performs no navigation at all.
  useEffect(() => {
    const hadFragment = window.location.hash.startsWith(CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX);
    void redeemCodingAppSessionPairingOnBoot().then(() => {
      if (!hadFragment) return;
      router.replace(window.location.pathname + window.location.search, { scroll: false });
    });
  }, [router]);
  return <AppShell />;
}
