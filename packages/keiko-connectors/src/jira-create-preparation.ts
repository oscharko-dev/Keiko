import type { JiraFieldMetadata, JiraMutationAttempt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraIssueLinkPlan } from "./jira-issue-links.js";
import type { JiraValidatedMutationFields } from "./jira-mutation-confirmation.js";
import type { JiraTraceRequest } from "./jira-requirement-trace.js";

/** Read-only output of the existing create owner. Preparation performs metadata, field, trace,
 * duplicate and saved-rule admission; this interface is not a second admission implementation. */
export interface PreparedJiraCreate {
  readonly ok: true;
  readonly projectId: string;
  readonly issueTypeId: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly metadata: readonly JiraFieldMetadata[];
  readonly values: JiraValidatedMutationFields;
  readonly plan: JiraIssueLinkPlan;
  readonly draftIdentity?: string;
  readonly descriptionConvertedHeadingCount?: number;
  readonly descriptionProjection?: "supported-markdown";
}
export type JiraCreatePreparation = PreparedJiraCreate | Extract<JiraMutationAttempt, { ok: false }>;
/** Supplied by the existing create owner with the same request/template authority as the bulk.
 * A trace is already validated by the current server-owned requirement resolver. */
export type JiraPrepareCreate = (args: CatalogJsonObject, trace: JiraTraceRequest | undefined) => Promise<JiraCreatePreparation>;
