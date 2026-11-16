import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";

/** Internal fixed native ExperimentalApi ports. Missing composition refuses priority operations
 * before any request. No model header, method, URL, token or experimental switch is accepted. */
export interface JiraProjectLifecyclePorts {
  readonly priority: {
    readonly read: (projectId: string) => Promise<AtlassianWriteHttpOutcome>;
    readonly assign: (projectId: string, schemeId: string) => Promise<AtlassianWriteHttpOutcome>;
    readonly remove: (projectId: string, schemeId: string) => Promise<AtlassianWriteHttpOutcome>;
  };
}
