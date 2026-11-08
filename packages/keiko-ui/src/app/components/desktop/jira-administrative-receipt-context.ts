import type { JiraPresentationSource } from "./jira-presentation-values";

const CONTEXT = [
  "schemeId",
  "schemePresent",
  "associationChange",
  "projectIds",
  "projectKeys",
  "draftSchemeId",
  "workflowSchemeScope",
  "workflowName",
  "mappingPresent",
  "issueTypeId",
  "propertyKey",
  "valueDigest",
  "columnIds",
  "baseUrlDigest",
  "readOnlyEnabled",
  "emailTemplateAction",
  "uploadSha256",
  "uploadBytes",
  "priorManifestSha256",
  "observedManifestSha256",
] as const;

/** A saved administrative receipt cannot borrow context from another operation in this wave. */
export function jiraAdministrativeReceiptContext(
  source: JiraPresentationSource,
  fields: readonly string[],
): boolean {
  return CONTEXT.every((key) => !Object.hasOwn(source, key) || fields.includes(key));
}
