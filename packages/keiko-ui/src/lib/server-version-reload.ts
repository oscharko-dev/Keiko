// Reloading a tab that re-paired with a newer server build (#4103 F1).
//
// A server upgrade restarts the process, which ends every app session (ADR-0141 D5), so the person
// re-pairs. When that pairing arrives as a same-document fragment navigation in the tab that already
// shows Keiko, the tab keeps the bundle it loaded from the previous build: its next lazily loaded
// chunk no longer exists and its requests speak the previous build's contract. The page therefore
// remembers the first server version health reported, and after such a re-pair it compares; a
// different version reloads the page, which keeps the session cookie the pairing just set and
// restores every window. An unknown or unreadable version never reloads.

import { fetchHealth } from "./api";
import { reportClientDiagnostic } from "./client-diagnostics";
import { clientErrorEvidence } from "./client-error-evidence";
import { bffRequestErrorKind } from "./http";

let pageServerVersion: string | undefined;

function knownVersion(version: unknown): string | undefined {
  return typeof version === "string" && version !== "" ? version : undefined;
}

/** Remember the server version this page loaded with; the first known version is kept for good. */
export function notePageServerVersion(version: unknown): void {
  pageServerVersion ??= knownVersion(version);
}

/** Test seam: each case starts from a page that has not seen a server version yet. */
export function resetPageServerVersionForTests(): void {
  pageServerVersion = undefined;
}

async function currentServerVersion(): Promise<string | undefined> {
  try {
    return knownVersion((await fetchHealth()).version);
  } catch (error) {
    reportClientDiagnostic("Server version could not be read after a re-pair.", {
      errorKind: bffRequestErrorKind(error),
      errorEvidence: clientErrorEvidence(error),
    });
    return undefined;
  }
}

function reloadPage(): void {
  window.location.reload();
}

/** After a same-document re-pair: reload when the server now runs a different version. */
export async function reloadIfServerVersionChanged(
  reload: () => void = reloadPage,
): Promise<boolean> {
  const loaded = pageServerVersion;
  if (loaded === undefined) return false;
  const current = await currentServerVersion();
  if (current === undefined || current === loaded) return false;
  reportClientDiagnostic("The server version changed since this page loaded; reloading the page.");
  reload();
  return true;
}
