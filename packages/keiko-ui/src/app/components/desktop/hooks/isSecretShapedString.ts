// KEIKO-0628: extracted leaf module for isSecretShapedString and its independent-of-keiko-ui
// helpers. Split out of workspace-persistence.ts so tests/qa/secret-shape-detector-parity.test.ts
// can import this file (a leaf that only depends on keiko-contracts) without pulling in
// workspace-persistence.ts's WIN_TYPES/WIN_META imports — which use keiko-ui's own bundler
// module-resolution conventions (no `.js` extensions) and don't type-check under the root
// suite's stricter node16 tsconfig.
//
// The three cross-package secret-shape detectors (keiko-contracts' looksLikeSecretShape,
// keiko-security's containsCredentialShape/redact, and this file's isSecretShapedString) cannot
// share one implementation — keiko-contracts is the leaf per ADR-0019 direction 1. The parity
// test at tests/qa/secret-shape-detector-parity.test.ts is the mechanical guard against them
// drifting apart silently.

import { looksLikeSecretShape } from "@oscharko-dev/keiko-contracts";

const CREDENTIAL_ASSIGNMENT_MARKERS = [
  "api_key=",
  "apikey=",
  "client_secret=",
  "clientsecret=",
  "credential=",
  "authorization:",
  "password=",
  "secret=",
  "token=",
] as const;

const ENV_CREDENTIAL_FILENAMES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.test",
  ".env.production",
] as const;

function containsBearerSecret(value: string): boolean {
  const marker = "bearer ";
  const at = value.toLowerCase().indexOf(marker);
  if (at === -1) return false;
  let length = 0;
  for (let idx = at + marker.length; idx < value.length; idx += 1) {
    const char = value[idx] ?? "";
    if (char.trim().length === 0) break;
    length += 1;
  }
  return length >= 8;
}

function containsUrlCredentials(value: string): boolean {
  if (!value.includes("://")) return false;
  try {
    const parsed = new URL(value);
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    return false;
  }
}

function segmentIsCredentialPath(segment: string, next: string): boolean {
  if (ENV_CREDENTIAL_FILENAMES.includes(segment as (typeof ENV_CREDENTIAL_FILENAMES)[number])) {
    return true;
  }
  if (segment === ".npmrc" || segment === "credentials.json") return true;
  if (segment === ".aws" && next === "credentials") return true;
  if (segment === ".ssh" && next.startsWith("id_")) return true;
  return false;
}

function containsCredentialPath(value: string): boolean {
  const segments = value.toLowerCase().replaceAll("\\", "/").split("/");
  for (let idx = 0; idx < segments.length; idx += 1) {
    if (segmentIsCredentialPath(segments[idx] ?? "", segments[idx + 1] ?? "")) return true;
  }
  return false;
}

export function isSecretShapedString(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();
  return (
    looksLikeSecretShape(trimmed) ||
    containsBearerSecret(trimmed) ||
    containsUrlCredentials(trimmed) ||
    CREDENTIAL_ASSIGNMENT_MARKERS.some((marker) => lower.includes(marker)) ||
    containsCredentialPath(trimmed)
  );
}
