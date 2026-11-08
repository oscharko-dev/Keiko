import type { JiraPrivateIdentityPorts } from "./jira-private-identity-ports.js";
import type { AtlassianConnectorDeployment } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import type { JiraIssueTemplateSource } from "./jira-managed-template-gate.js";
import type { JiraAttachmentSource } from "./jira-attachments.js";
import type { JiraEmailTemplatePorts } from "./jira-email-template-values.js";
import type { JiraAvatarPorts } from "./jira-avatar-mutation-values.js";

/** Resolved by the composing owner, never from model arguments. */
export interface JiraManagedConnection {
  readonly deployment: AtlassianConnectorDeployment;
  readonly baseUrl: string;
  /** Opaque, stable identity of the credential behind `http`; never a secret. */
  readonly identity?: string;
  readonly http: AtlassianHttpBodyPort;
  readonly privateIdentity?: JiraPrivateIdentityPorts | undefined;
  /** Private receipt observer, called after a valid Jira create acknowledgement and before read-back. */
  readonly onCreatedIssueAcknowledged?: ((issueKey: string) => void) | undefined;
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
  /** Private archive admission. `check` is the executor's phase, never a tool argument. */
  readonly emailTemplates?: {
    readonly inspect: JiraEmailTemplatePorts["inspect"];
    readonly sourceFor?: (check: boolean) => JiraAttachmentSource;
  };
  readonly avatars?: {
    readonly inspectImage?: JiraAvatarPorts["inspectImage"];
    readonly sourceFor?: (check: boolean) => JiraAttachmentSource | undefined;
    readonly withSession?: JiraAvatarPorts["withSession"];
    readonly legacyTemporaryRelease?: JiraAvatarPorts["legacyTemporaryRelease"];
  };
}
