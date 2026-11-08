import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraHumanInputPurpose } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraHumanInputSelection } from "./jira-human-input-preparation.js";

/** Private request metadata only. Secret body bytes are materialized after transport admission. */
export interface JiraHumanInputHttpRequest {
  readonly selection: JiraHumanInputSelection;
  readonly fields: CatalogJsonObject;
}

/** Per-invocation server composition binds the input selection and actual private session.
 * Nonsecret native fields only; no passwords, license text, cookies, URLs or header options. */
export interface JiraPrivateIdentityPorts {
  readonly perform: (purpose: JiraHumanInputPurpose, fields: CatalogJsonObject) => Promise<AtlassianWriteHttpOutcome>;
  readonly session: (action: "logout" | "release-websudo", expectedActorKey: string) => Promise<AtlassianWriteHttpOutcome>;
  readonly unlock: (expectedActorKey: string) => Promise<AtlassianWriteHttpOutcome>;
}
