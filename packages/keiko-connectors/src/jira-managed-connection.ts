import type { AtlassianConnectorDeployment } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import type { JiraIssueTemplateSource } from "./jira-managed-template-gate.js";
import type { JiraAttachmentSource } from "./jira-attachments.js";

/** Resolved by the composing owner, never from model arguments. */
export interface JiraManagedConnection {
  readonly deployment: AtlassianConnectorDeployment;
  readonly baseUrl: string;
  /** Opaque, stable identity of the credential behind `http`; never a secret. */
  readonly identity?: string;
  readonly http: AtlassianHttpBodyPort;
  /** The active customer-defined issue templates; every create, edit and transition is checked. */
  readonly issueTemplates?: JiraIssueTemplateSource | undefined;
  /** Body-free facts about the applicable create-rule projection, through its composing owner. */
  readonly templateMetadataActivity?: (activity: {
    readonly matchedCount: number;
    readonly returnedCount: number;
    readonly omittedCount: number;
    readonly unreadableCount: number;
  }) => void;
  /** The only way `jira.attach` obtains bytes: a source the composing owner already governs. */
  readonly attachmentSource?: JiraAttachmentSource;
}
