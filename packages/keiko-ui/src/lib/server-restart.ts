// Recognizing that the server restarted while this tab held a connected session (#4370).
//
// A restart empties the server's session registry by design (ADR-0141 D5), so the next protected
// read is refused exactly like an expiry. The page can still say why: while connected it remembers
// the random server instance identity health reports, and when the session is gone it compares. The
// value lives only in this tab's session storage; it is not a credential and grants nothing. When it
// is absent, unreadable or not the closed shape, no restart is claimed and the ordinary wording shows.

import { fetchHealth } from "./api";
import { reportClientDiagnostic } from "./client-diagnostics";
import { bffRequestErrorKind } from "./http";

const STORAGE_KEY = "keiko.connected-server-instance";
const INSTANCE_ID = /^[a-f0-9]{32}$/u;

function tabStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

async function currentInstance(): Promise<string | undefined> {
  try {
    const { instanceId } = await fetchHealth();
    return instanceId !== undefined && INSTANCE_ID.test(instanceId) ? instanceId : undefined;
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
  } catch {
    // Storage is a convenience: without it the ordinary wording shows instead of a restart claim.
  }
}

/** True only when this tab saw a different server process while it was connected. */
export async function sessionEndedByRestart(): Promise<boolean> {
  let remembered: string | null | undefined;
  try {
    remembered = tabStorage()?.getItem(STORAGE_KEY);
  } catch {
    return false;
  }
  if (remembered === null || remembered === undefined || !INSTANCE_ID.test(remembered))
    return false;
  const current = await currentInstance();
  return current !== undefined && current !== remembered;
}
