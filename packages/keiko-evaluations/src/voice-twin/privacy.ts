// Voice Digital Twin privacy / supply-chain audit (Epic #491, Issue #505; ADR-0068; AC5).
//
// Two pure auditors give AC5 its teeth:
//   (a) `auditVoiceEgress` — an egress ledger is approved iff NO destination is `unapproved-external`. A
//       voice cell may egress nowhere or only to the configured model endpoint (matrix §3 /
//       privacy-contract §1); any other destination flips approval to false.
//   (b) `scanManifestsForDeniedMediaPackages` — a pure scan over provided package manifests for the
//       denied runtime-media packages from `docs/voice/supply-chain-policy.md` §1. The real-repo scan
//       (reading the actual `packages/**/package.json`) runs in the .test.ts files (test files may do
//       fs); this function is pure over its inputs so pure negative fixtures can prove a denied package
//       flips `clean=false`.
//
// Both are pure (no IO, clock, randomness) and content-free.

import type {
  EgressDestinationClass,
  VoiceTwinEgressAudit,
  VoiceTwinEgressDestination,
  VoiceTwinManifestFixture,
  VoiceTwinManifestScan,
} from "./types.js";

// ─── Egress audit (AC5) ──────────────────────────────────────────────────────────────
export function auditVoiceEgress(
  destinations: readonly { readonly class: EgressDestinationClass }[],
): VoiceTwinEgressAudit {
  const unapprovedCount = destinations.filter((d) => d.class === "unapproved-external").length;
  return { approved: unapprovedCount === 0, unapprovedCount };
}

// ─── Supply-chain denylist (docs/voice/supply-chain-policy.md §1) ────────────────────
// Enumerates the known runtime-media package + scope variants of the policy §1 vendors (WebRTC wrapper /
// peer / SFU / media-server / SDK packages) the policy forbids adding by default — including the real
// client / SDK and scoped-vendor variants, not just the bare vendor id. This is a NAME-based scan
// (exact id OR `@scope/` prefix); the policy §1 catch-all cannot be enforced by an exact-name scan alone,
// so operators MUST keep this list current as new vendor packages appear. `ws` is the single allowed
// runtime media-adjacent package (already vetted, scoped). Grouped alphabetically by vendor.
export const DENIED_MEDIA_PACKAGES: readonly string[] = [
  // agora
  "agora",
  "agora-rtc-sdk-ng",
  "@agora-js",
  // daily
  "@daily-co",
  "@daily-co/daily-js",
  // jitsi
  "jitsi",
  "lib-jitsi-meet",
  "@jitsi",
  // janus
  "janus",
  "janus-gateway",
  // kurento
  "kurento",
  // livekit
  "livekit",
  "livekit-client",
  "livekit-server-sdk",
  "@livekit",
  // mediasoup
  "mediasoup",
  "mediasoup-client",
  // opentok
  "opentok",
  // peerjs
  "peerjs",
  "peerjs-server",
  // simple-peer
  "simple-peer",
  // sip
  "sip.js",
  "jssip",
  // socket.io
  "socket.io",
  "socket.io-client",
  "@socket.io",
  // twilio
  "twilio",
  "twilio-video",
  "@twilio",
  // webrtc native bindings
  "wrtc",
  "node-webrtc",
] as const;

export const ALLOWED_MEDIA_RUNTIME: readonly string[] = ["ws"] as const;

// A dependency name matches a denied package if it equals the denied id or is a scoped sub-package of a
// denied scope (e.g. `@daily-co/daily-js` matches the `@daily-co` scope). This catches the realistic
// monorepo shape where a forbidden vendor ships under a scope.
function dependencyMatchesDenied(dependencyName: string, denied: string): boolean {
  if (dependencyName === denied) {
    return true;
  }
  return denied.startsWith("@") && dependencyName.startsWith(`${denied}/`);
}

export function scanManifestsForDeniedMediaPackages(
  manifests: readonly VoiceTwinManifestFixture[],
): VoiceTwinManifestScan {
  const found: { readonly packageName: string; readonly deniedPackage: string }[] = [];
  for (const manifest of manifests) {
    for (const dependency of manifest.dependencyNames) {
      const denied = DENIED_MEDIA_PACKAGES.find((d) => dependencyMatchesDenied(dependency, d));
      if (denied !== undefined) {
        found.push({ packageName: manifest.packageName, deniedPackage: denied });
      }
    }
  }
  // Sort to a canonical order so the found list is stable regardless of manifest ordering.
  const sorted = found
    .slice()
    .sort((a, b) =>
      a.packageName === b.packageName
        ? a.deniedPackage.localeCompare(b.deniedPackage)
        : a.packageName.localeCompare(b.packageName),
    );
  return { clean: sorted.length === 0, found: sorted };
}

// Re-export the destination type so fixture / runner callers need not reach into types for it.
export type { VoiceTwinEgressDestination };
