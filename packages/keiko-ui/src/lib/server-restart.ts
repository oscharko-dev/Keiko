// Recognizing that the server restarted while this tab held a connected session (#4370).
//
// A restart empties the server's session registry by design (ADR-0141 D5), so the next protected
// read is refused exactly like an expiry. The page can still say why: while connected it remembers
// the random server instance identity health reports, and when the session is gone it compares. The
// value lives only in this tab's session storage; it is not a credential and grants nothing. When it
// is absent, unreadable or not the closed shape, no restart is claimed and the ordinary wording shows.

import { isServerInstanceId } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { fetchHealth } from "./api";
import { reportClientDiagnostic } from "./client-diagnostics";
import { bffRequestErrorKind } from "./http";

/** The tab-storage key of the remembered server instance; exported so tests wait on its write. */
export const CONNECTED_SERVER_INSTANCE_STORAGE_KEY = "keiko.connected-server-instance";

// Blocked tab storage is an ordinary state (a restricted profile), but never a silent one: it is
// reported once per page, body-free, and the ordinary wording shows instead of a restart claim.
let storageFailureReported = false;
// An unreadable confirmation is reported once per outage: the refresh timer ticks every 30 s, and a
// server that stays unreachable must not become a report per tick. The next confirmation that works
// ends the outage, so a later failure is reported again.
let confirmationFailureReported = false;

function reportStorageFailure(error: unknown): void {
  if (storageFailureReported) return;
  storageFailureReported = true;
  reportClientDiagnostic("Tab storage for the server instance is unavailable.", {
    errorKind: bffRequestErrorKind(error),
  });
}

/** Test seam: the once-per-page and once-per-outage reports reset between cases. */
export function resetServerRestartReports(): void {
  storageFailureReported = false;
  confirmationFailureReported = false;
}

function tabStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch (error) {
    reportStorageFailure(error);
    return undefined;
  }
}

async function currentInstance(): Promise<string | undefined> {
  try {
    const { instanceId } = await fetchHealth();
    return isServerInstanceId(instanceId) ? instanceId : undefined;
  } catch (error) {
    reportClientDiagnostic("Server instance could not be read.", {
      errorKind: bffRequestErrorKind(error),
    });
    return undefined;
  }
}

/**
 * Remember which server process this tab was connected to. The identity is read first, then, when the
 * caller cannot vouch that the session was just observed active (a refresh timer, which can fire after
 * a restart nothing has inspected yet), `confirmActive` is asked and the identity is kept only when the
 * session is still valid. Recording the new process while the session is gone would erase the
 * evidence of the restart (#4370). A confirmation that cannot be read keeps the previous identity.
 */
export async function noteConnectedServerInstance(
  confirmActive?: () => Promise<boolean>,
): Promise<void> {
  const instance = await currentInstance();
  if (instance === undefined) return;
  if (confirmActive !== undefined) {
    try {
      const active = await confirmActive();
      confirmationFailureReported = false;
      if (!active) return;
    } catch (error) {
      if (!confirmationFailureReported) {
        confirmationFailureReported = true;
        reportClientDiagnostic("The connected session could not be confirmed.", {
          errorKind: bffRequestErrorKind(error),
        });
      }
      return;
    }
  }
  try {
    tabStorage()?.setItem(CONNECTED_SERVER_INSTANCE_STORAGE_KEY, instance);
  } catch (error) {
    reportStorageFailure(error);
  }
}

/** True only when this tab saw a different server process while it was connected. */
export async function sessionEndedByRestart(): Promise<boolean> {
  let remembered: string | null | undefined;
  try {
    remembered = tabStorage()?.getItem(CONNECTED_SERVER_INSTANCE_STORAGE_KEY);
  } catch (error) {
    reportStorageFailure(error);
    return false;
  }
  if (!isServerInstanceId(remembered)) return false;
  const current = await currentInstance();
  return current !== undefined && current !== remembered;
}
