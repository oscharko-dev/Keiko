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

const STORAGE_KEY = "keiko.connected-server-instance";

// Blocked tab storage is an ordinary state (a restricted profile), but never a silent one: it is
// reported once per page, body-free, and the ordinary wording shows instead of a restart claim.
let storageFailureReported = false;

function reportStorageFailure(error: unknown): void {
  if (storageFailureReported) return;
  storageFailureReported = true;
  reportClientDiagnostic("Tab storage for the server instance is unavailable.", {
    errorKind: bffRequestErrorKind(error),
  });
}

/** Test seam: the once-per-page report resets with the module state between cases. */
export function resetServerRestartStorageReport(): void {
  storageFailureReported = false;
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

/** Remember which server process this tab was connected to; call while the session is valid. */
export async function noteConnectedServerInstance(): Promise<void> {
  const instance = await currentInstance();
  if (instance === undefined) return;
  try {
    tabStorage()?.setItem(STORAGE_KEY, instance);
  } catch (error) {
    reportStorageFailure(error);
  }
}

/** True only when this tab saw a different server process while it was connected. */
export async function sessionEndedByRestart(): Promise<boolean> {
  let remembered: string | null | undefined;
  try {
    remembered = tabStorage()?.getItem(STORAGE_KEY);
  } catch (error) {
    reportStorageFailure(error);
    return false;
  }
  if (!isServerInstanceId(remembered)) return false;
  const current = await currentInstance();
  return current !== undefined && current !== remembered;
}
