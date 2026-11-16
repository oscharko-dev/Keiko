import type { AtlassianAuthenticationFailure } from "@oscharko-dev/keiko-connectors";

/**
 * Who authored a 401, as a closed fact (ADR-0128). Observed on Jira Data Center 10.3 for a missing
 * or unknown bearer token (an expired or revoked personal access token is unknown to Jira and
 * answers the same way): `X-AREQUESTID` (Jira's request id), `X-AUSERNAME: anonymous`, a JSON
 * body with `status-code` 401, and no `X-Authentication-Denied-Reason`. Jira adds that last header
 * to refuse a login for a reason other than a bad credential (a captcha challenge, a lock), so
 * such a 401 never proves a rejected token. A 401 without Jira's markers came from something in
 * front of Jira. Only header presence and the anonymous marker are read; no value leaves here.
 */
export function classifyAuthenticationFailure(
  status: number,
  headers: Headers,
): AtlassianAuthenticationFailure | undefined {
  if (status !== 401) return undefined;
  if (headers.has("x-authentication-denied-reason")) return "denied";
  const authoredByJira =
    headers.has("x-arequestid") && headers.get("x-ausername")?.trim().toLowerCase() === "anonymous";
  return authoredByJira ? "jira" : "foreign";
}

/** Keeps the three markers when an anonymous success is rewritten into the 401 it stands for. */
export function authenticationMarkerHeaders(headers: Headers): Headers {
  const kept = new Headers();
  for (const name of ["x-arequestid", "x-ausername", "x-authentication-denied-reason"]) {
    const value = headers.get(name);
    if (value !== null) kept.set(name, value);
  }
  return kept;
}
