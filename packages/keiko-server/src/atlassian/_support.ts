import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../../tests/support/buffered-server-log.js";
import type {
  AtlassianCredentialCustody,
  AtlassianCredentialMetadata,
} from "@oscharko-dev/keiko-connectors";
import type { UiHandlerDeps } from "../deps.js";

/** The fixture dependencies with the Atlassian credential port writing to a captured log. */
export function withSyncActivityLog(deps: UiHandlerDeps): {
  readonly deps: UiHandlerDeps;
  readonly logs: BufferedServerLogSink;
} {
  const logs = createBufferedServerLogSink();
  const credentials = deps.atlassianConnectorCredentials;
  if (credentials === undefined) throw new Error("Missing fixture credentials");
  return {
    deps: { ...deps, atlassianConnectorCredentials: { ...credentials, activityLog: logs } },
    logs,
  };
}

/**
 * A credential custody that only reads: `getMetadata` answers lookups, `listed` is the listing, and
 * every write either refuses or throws because no route under test may perform it.
 */
export function readOnlyCredentialCustody(
  getMetadata: AtlassianCredentialCustody["getMetadata"],
  listed: readonly AtlassianCredentialMetadata[],
): AtlassianCredentialCustody {
  return {
    updateLivePod: (): never => {
      throw new Error("Unexpected Live Pod update");
    },
    beginVerification: (): undefined => undefined,
    finishVerification: (): boolean => false,
    observeAuthenticationFailure: (): boolean => false,
    create: (): never => {
      throw new Error("create not exercised");
    },
    getMetadata,
    list: (): readonly AtlassianCredentialMetadata[] => listed,
    delete: (): boolean => false,
  };
}
