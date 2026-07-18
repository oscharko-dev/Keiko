"use client";

import { useEffect, type ReactNode } from "react";
import { redeemCodingAppSessionPairingFragment } from "@/lib/coding-app-session-client";
import { AppShell } from "./AppShell";

export function KeikoDesktop(): ReactNode {
  // Redeem a launcher pairing fragment before any surface needs the app session (#2478). The
  // second StrictMode invocation is a no-op because the first redemption strips the fragment.
  useEffect(() => {
    void redeemCodingAppSessionPairingFragment();
  }, []);
  return <AppShell />;
}
