import type { AtlassianConnectorDeployment } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";

/** Resolved by the composing owner, never from model arguments. */
export interface JiraManagedConnection {
  readonly deployment: AtlassianConnectorDeployment;
  readonly baseUrl: string;
  readonly http: AtlassianHttpBodyPort;
}
