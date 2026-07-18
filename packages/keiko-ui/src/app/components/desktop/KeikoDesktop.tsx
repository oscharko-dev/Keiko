"use client";

import { useEffect, type ReactNode } from "react";
import { redeemCodingAppSessionPairingOnBoot } from "@/lib/coding-app-session-client";
import { AppShell } from "./AppShell";

export function KeikoDesktop(): ReactNode {
  // Redeem a launcher pairing fragment before any surface needs the app session (#2478); the
  // boot entry is single-flight, so StrictMode's second invocation joins the same redemption.
  useEffect(() => {
    void redeemCodingAppSessionPairingOnBoot();
  }, []);
  return <AppShell />;
}
