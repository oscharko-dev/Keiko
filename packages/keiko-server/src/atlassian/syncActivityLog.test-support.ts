import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../../tests/support/buffered-server-log.js";
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
