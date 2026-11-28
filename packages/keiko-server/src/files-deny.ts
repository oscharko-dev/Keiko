// Deny-list wiring for the Files BFF (`/api/files/*`). Reuses
// `src/workspace/ignore.ts` unchanged: `isDenied` is the always-on security
// gate for content, navigation, and mutations. The tree may show metadata-free,
// unavailable rows for known non-secret runtime directories from an authorized
// parent listing; secrets and their directory names remain excluded.

import { isDenied } from "@oscharko-dev/keiko-workspace";
import {
  recordWorkspaceRootDenied,
  type WorkspaceRootDenialReason,
} from "./workspace-root-denial-log.js";
import {
  installationDenialCause,
  installationDenialCauseAsync,
  type InstallationDenialCause,
} from "./launch-directory.js";

// Generic, non-leaking deny message. NEVER include the requested path or the
// matched pattern: the deny list is treated as a server-side safety invariant
// the client must not be able to probe.
export const DENIED_MESSAGE = "The requested path is excluded from the read surface.";

// A Keiko that runs inside its own program folder (the folder packages and the desktop
// installation, ADR-0121 D9) refuses that folder as a root in the same breath, and so is the program
// files of any other installation, which its layout names: they hold the program and, in a team
// package, the gateway configuration with its token. Only an absolute path can name them, so every
// root-relative check stays the deny list alone.
export function pathIsDenied(path: string): boolean {
  return pathDenialCause(path) !== undefined;
}

/** Why a path is refused, as a closed value that names no path, or undefined when it is not. */
export function pathDenialCause(path: string): "deny-list" | InstallationDenialCause | undefined {
  return isDenied(path) ? "deny-list" : installationDenialCause(path);
}

/** `pathDenialCause` for an asynchronous caller: the canonical-name check never blocks the event loop. */
export async function pathDenialCauseAsync(
  path: string,
): Promise<"deny-list" | InstallationDenialCause | undefined> {
  return isDenied(path) ? "deny-list" : await installationDenialCauseAsync(path);
}

export async function pathIsDeniedAsync(path: string): Promise<boolean> {
  return (await pathDenialCauseAsync(path)) !== undefined;
}

/** The closed workspace-root denial reason a path-denial cause is recorded under. */
export function pathDenialReason(
  cause: NonNullable<Awaited<ReturnType<typeof pathDenialCauseAsync>>>,
): WorkspaceRootDenialReason {
  if (cause === "installation-payload") return "installation-payload";
  return cause === "unresolvable-name" ? "installation-name-unresolvable" : "denied-locus";
}

/**
 * `pathIsDeniedAsync` that leaves the refusal on the registered body-free workspace-root denial line
 * (closed reason, no path) with the request's correlation id, exactly as the synchronous seed check
 * does. An asynchronous caller that answers 403 or filters a project calls this, never the bare
 * predicate, so the refusal is never silent.
 */
export async function pathDeniedAsyncRecorded(
  path: string,
  correlationId: string | undefined,
): Promise<boolean> {
  const cause = await pathDenialCauseAsync(path);
  if (cause === undefined) return false;
  recordWorkspaceRootDenied(
    { reason: pathDenialReason(cause), failureKind: "DENIED", errorKind: "authority-denied" },
    { correlationId },
  );
  return true;
}
