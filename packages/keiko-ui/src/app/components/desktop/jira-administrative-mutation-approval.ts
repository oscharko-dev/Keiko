import type { OptionalWidgetTranslate, WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraDraftField, JiraDraftValue } from "./jiraDraftTree";
import {
  jiraPresentationRecord as record,
  jiraPresentationLiteral as literal,
  jiraSelectedMutationTool,
} from "./jira-presentation-values";
import { jiraReviewedMutationScalar as scalar } from "./jira-structural-mutation-approval";
import {
  JIRA_SCHEME_ADMINISTRATION_TOOLS,
  JIRA_WORKFLOW_SCHEME_WRITE_TOOLS,
  jiraSchemeConfirmationUnavailable,
} from "./jira-scheme-administration-presentation";
import {
  JIRA_INSTANCE_ADMINISTRATION_WRITE_TOOLS,
  JIRA_EMAIL_TEMPLATE_WRITE_TOOLS,
  jiraInstanceConfirmationUnavailable,
} from "./jira-instance-administration-presentation";

const LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  expectedActorKey: "chat.jira.savedConfiguration.reviewedActor",
  expectedScheme: "chat.jira.schemeWrite.reviewedScheme",
  expectedDraft: "chat.jira.schemeWrite.reviewedDraft",
  name: "chat.jira.structural.nativeName",
  description: "chat.jira.structural.nativeDescription",
  issueTypeIds: "chat.jira.schemeWrite.issueTypeOrder",
  defaultIssueTypeId: "chat.jira.schemeWrite.defaultIssueType",
  optionIds: "chat.jira.schemeWrite.priorityOrder",
  defaultOptionId: "chat.jira.association.defaultPriorityId",
  expectedProjects: "chat.jira.schemeWrite.reviewedProjects",
  projects: "chat.jira.schemeWrite.requestedProjects",
  confirmUnverifiedConsequences: "chat.jira.categoryWrite.acceptUnconfirmed",
  confirmUnverifiedDeletion: "chat.jira.categoryWrite.acceptUnconfirmed",
  defaultWorkflow: "chat.jira.schemeWrite.configuredDefault",
  mappings: "chat.jira.schemeWrite.mappings",
  workflowName: "chat.jira.fact.workflow",
  issueTypeId: "chat.jira.fact.issueTypeId",
  defaultMapping: "chat.jira.schemeWrite.requestedDefaultMapping",
  propertyKey: "chat.jira.instanceWrite.propertyKey",
  expectedValue: "chat.jira.instanceWrite.reviewedValue",
  value: "chat.jira.instanceWrite.requestedValue",
  expectedColumns: "chat.jira.instanceWrite.reviewedColumns",
  columns: "chat.jira.instanceWrite.requestedColumns",
  expectedBaseUrl: "chat.jira.instanceWrite.reviewedBaseUrl",
  configuredBaseUrl: "chat.jira.instanceWrite.requestedBaseUrl",
  confirmInstanceWide: "chat.jira.adminReview.instanceWide",
  expectedEnabled: "chat.jira.instanceWrite.reviewedReadOnly",
  enabled: "chat.jira.instanceWrite.requestedReadOnly",
  source: "chat.jira.emailPack.connectedSource",
  expectedFile: "chat.jira.emailPack.reviewedFile",
  acceptStagedTemplateReplacement: "chat.jira.emailPack.acceptStaged",
  expectedActiveManifestSha256: "chat.jira.emailPack.priorManifest",
  acceptGlobalTemplateChange: "chat.jira.emailPack.acceptGlobal",
  acceptUnverifiedStagedPack: "chat.jira.emailPack.acceptUnverifiedStaged",
};
const MEMBER_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  ...LABELS,
  id: "chat.jira.planning.nativeId",
  key: "chat.jira.fact.projectKey",
  draft: "chat.jira.schemeWrite.draftFlag",
  defaultScheme: "chat.jira.schemeWrite.defaultScheme",
  workflow: "chat.jira.fact.workflow",
  originalDefaultWorkflow: "chat.jira.fact.originalDefaultWorkflow",
  originalMappings: "chat.jira.schemeWrite.originalMappings",
  path: "chat.jira.emailPack.connectedPath",
  kind: "chat.jira.emailPack.sourceKind",
  sizeBytes: "chat.jira.emailPack.byteCount",
  sha256: "chat.jira.emailPack.rawDigest",
};
const selected = (operation: string | undefined): string | undefined =>
  jiraSelectedMutationTool(
    operation,
    JIRA_SCHEME_ADMINISTRATION_TOOLS,
    JIRA_INSTANCE_ADMINISTRATION_WRITE_TOOLS,
  );
function memberLabel(
  key: string,
  t: OptionalWidgetTranslate,
  labels: Readonly<Record<string, WidgetMessageKey>>,
): string {
  let label: WidgetMessageKey | undefined;
  if (Object.hasOwn(labels, key)) label = labels[key];
  else if (Object.hasOwn(MEMBER_LABELS, key)) label = MEMBER_LABELS[key];
  return label === undefined ? key : t(label);
}
export function jiraAdministrativeReviewedValue(
  key: string,
  value: unknown,
  t: OptionalWidgetTranslate,
  reviewed: boolean,
  labels: Readonly<Record<string, WidgetMessageKey>> = MEMBER_LABELS,
): JiraDraftValue {
  if (Array.isArray(value)) {
    if (value.length === 0) return literal(t("chat.jira.adminReview.emptyList"));
    return {
      kind: "list",
      items: value.map((item: unknown, index) => ({
        position: index + 1,
        value: jiraAdministrativeReviewedValue(key, item, t, reviewed, labels),
      })),
    };
  }
  const source = record(value);
  if (source !== undefined)
    return {
      kind: "group",
      members: Object.entries(source).map(([field, item]) => ({
        name: memberLabel(field, t, labels),
        value: jiraAdministrativeReviewedValue(field, item, t, reviewed, labels),
      })),
    };
  if (key === "defaultWorkflow" && value === null && !reviewed)
    return literal(t("chat.jira.schemeWrite.removeConfiguredDefault"));
  return scalar(value, t);
}
export function jiraAdministrativeMutationFacts(
  operation: string | undefined,
  key: string,
  value: unknown,
  t: OptionalWidgetTranslate,
): readonly JiraDraftField[] | undefined {
  const label = Object.hasOwn(LABELS, key) ? LABELS[key] : undefined;
  if (selected(operation) === undefined || label === undefined) return undefined;
  return [
    {
      id: t(label),
      value: jiraAdministrativeReviewedValue(key, value, t, key.startsWith("expected")),
    },
  ];
}
function schemeLabels(tool: string, args: unknown): WidgetMessageKey[] {
  const labels: WidgetMessageKey[] = ["chat.jira.schemeWrite.configurationOnly"];
  if (JIRA_WORKFLOW_SCHEME_WRITE_TOOLS.has(tool))
    labels.push(
      tool.includes("_draft")
        ? "chat.jira.schemeWrite.draftOnly"
        : "chat.jira.schemeWrite.baseOnly",
      "chat.jira.schemeWrite.configuredNotEffective",
    );
  const source = record(args) ?? {};
  if (Object.hasOwn(source, "mappings")) labels.push("chat.jira.schemeWrite.replaceMappings");
  if (
    tool === "jira_set_issue_type_scheme_projects" ||
    tool === "jira_clear_issue_type_scheme_projects"
  )
    labels.push("chat.jira.schemeWrite.replaceProjects");
  if (jiraSchemeConfirmationUnavailable(tool, args))
    labels.push("chat.jira.schemeWrite.consequencesUnconfirmed");
  return labels;
}
function instanceLabels(tool: string): WidgetMessageKey[] {
  if (JIRA_EMAIL_TEMPLATE_WRITE_TOOLS.has(tool))
    return [
      "chat.jira.emailPack.integrityNotAuthority",
      "chat.jira.emailPack.noDelivery",
      "chat.jira.emailPack.unconfirmed",
    ];
  if (tool === "jira_set_instance_base_url")
    return ["chat.jira.instanceWrite.baseUrlConsequences", "chat.jira.instanceWrite.noNavigation"];
  if (tool === "jira_set_system_columns") return ["chat.jira.instanceWrite.systemSequence"];
  return tool === "jira_set_read_only_mode"
    ? ["chat.jira.instanceWrite.noEnforcementProof"]
    : ["chat.jira.instanceWrite.closedProperties"];
}
export function jiraAdministrativeMutationContextFacts(
  operation: string | undefined,
  args: unknown,
  t: OptionalWidgetTranslate,
): readonly JiraDraftField[] {
  const tool = selected(operation);
  if (tool === undefined) return [];
  const labels: WidgetMessageKey[] = [
    "chat.jira.accessWrite.admin",
    "chat.jira.structural.noAtomicSnapshot",
    ...(JIRA_SCHEME_ADMINISTRATION_TOOLS.has(tool)
      ? schemeLabels(tool, args)
      : instanceLabels(tool)),
  ];
  if (jiraInstanceConfirmationUnavailable(tool))
    labels.push("chat.jira.accessWrite.ackUnconfirmed");
  return labels.map((label) => ({
    id: t("chat.jira.savedConfiguration.nativeLimitation"),
    value: literal(t(label)),
  }));
}
