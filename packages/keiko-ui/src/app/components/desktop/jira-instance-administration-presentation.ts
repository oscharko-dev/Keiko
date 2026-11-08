import {
  JIRA_INSTANCE_SETTING_MUTATIONS,
  JIRA_EMAIL_TEMPLATE_MUTATIONS,
  JIRA_ATTACHMENT_MAX_BYTES,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails } from "./jira-agile-presentation";
import { jiraAdministrativeReceiptContext as closed } from "./jira-administrative-receipt-context";
import {
  jiraPresentationFact as fact,
  jiraPresentationRecord as record,
  jiraPresentationNativeText as nativeText,
  jiraPresentationMutationLabels,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

const aliases = (values: readonly string[]): ReadonlySet<string> =>
  new Set(values.map((name) => name.replace(/[.-]/gu, "_")));
export const JIRA_INSTANCE_SETTING_WRITE_TOOLS = aliases(JIRA_INSTANCE_SETTING_MUTATIONS);
export const JIRA_EMAIL_TEMPLATE_WRITE_TOOLS = aliases(JIRA_EMAIL_TEMPLATE_MUTATIONS);
export const JIRA_INSTANCE_ADMINISTRATION_WRITE_TOOLS: ReadonlySet<string> = new Set([
  ...JIRA_INSTANCE_SETTING_WRITE_TOOLS,
  ...JIRA_EMAIL_TEMPLATE_WRITE_TOOLS,
]);
export const JIRA_INSTANCE_ADMINISTRATION_TOOLS: ReadonlySet<string> = new Set([
  ...JIRA_INSTANCE_ADMINISTRATION_WRITE_TOOLS,
  "jira_email_template_pack",
]);
const PROPERTY_KEYS = new Set([
  "jira.clone.prefix",
  "jira.option.voting",
  "jira.option.watching",
  "jira.option.timetracking",
]);
export function jiraAdministrativeDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
function columns(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 1000 &&
    Reflect.ownKeys(value).length === value.length + 1 &&
    value.every((id: unknown) => nativeText(id, 255, { multiline: true }))
  );
}
const INSTANCE_VALIDATORS: Readonly<Record<string, (source: Source) => boolean>> = {
  jira_set_application_property: (source) =>
    closed(source, ["propertyKey", "valueDigest"]) &&
    typeof source.propertyKey === "string" &&
    PROPERTY_KEYS.has(source.propertyKey) &&
    jiraAdministrativeDigest(source.valueDigest),
  jira_set_system_columns: (source) => closed(source, ["columnIds"]) && columns(source.columnIds),
  jira_set_instance_base_url: (source) =>
    closed(source, ["baseUrlDigest"]) && jiraAdministrativeDigest(source.baseUrlDigest),
  jira_set_read_only_mode: (source) =>
    closed(source, ["readOnlyEnabled"]) && typeof source.readOnlyEnabled === "boolean",
};
function instanceComplete(tool: string, source: Source): boolean {
  return Object.hasOwn(INSTANCE_VALIDATORS, tool) && INSTANCE_VALIDATORS[tool]?.(source) === true;
}
function uploadComplete(source: Source): boolean {
  return (
    closed(source, ["emailTemplateAction", "uploadSha256", "uploadBytes"]) &&
    source.emailTemplateAction === "upload" &&
    jiraAdministrativeDigest(source.uploadSha256) &&
    positiveBytes(source.uploadBytes)
  );
}
function emailComplete(tool: string, source: Source): boolean {
  if (tool === "jira_upload_email_template_pack") return uploadComplete(source);
  const action = tool === "jira_apply_email_template_pack" ? "apply" : "revert";
  if (
    !closed(source, ["emailTemplateAction", "priorManifestSha256", "observedManifestSha256"]) ||
    source.emailTemplateAction !== action
  )
    return false;
  return (
    jiraAdministrativeDigest(source.priorManifestSha256) &&
    (source.observedManifestSha256 === undefined ||
      jiraAdministrativeDigest(source.observedManifestSha256))
  );
}
export function jiraInstanceAdministrationIdentityComplete(tool: string, source: Source): boolean {
  if (!nativeText(source.userKey, 255, { multiline: true })) return false;
  if (JIRA_INSTANCE_SETTING_WRITE_TOOLS.has(tool)) return instanceComplete(tool, source);
  return JIRA_EMAIL_TEMPLATE_WRITE_TOOLS.has(tool) && emailComplete(tool, source);
}
export function jiraInstanceConfirmationUnavailable(tool: string): boolean {
  return tool === "jira_set_instance_base_url" || JIRA_EMAIL_TEMPLATE_WRITE_TOOLS.has(tool);
}
function positiveBytes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= JIRA_ATTACHMENT_MAX_BYTES
  );
}
function outcome(tool: string, source: Source): WidgetMessageKey[] {
  if (!jiraInstanceAdministrationIdentityComplete(tool, source))
    return ["chat.jira.savedConfiguration.identityUnknown"];
  if (source.outcome === "rejected" && JIRA_INSTANCE_SETTING_WRITE_TOOLS.has(tool))
    return jiraPresentationMutationLabels(source, true);
  return jiraInstanceConfirmationUnavailable(tool)
    ? ["chat.jira.savedConfiguration.unconfirmed"]
    : jiraPresentationMutationLabels(source, true);
}
function instanceFacts(tool: string, source: Source): JiraAgileDetails["facts"] {
  const facts = [
    ...fact("chat.jira.instanceWrite.propertyKey", source.propertyKey),
    ...fact("chat.jira.instanceWrite.valueDigest", source.valueDigest),
    ...fact("chat.jira.instanceWrite.baseUrlDigest", source.baseUrlDigest),
  ];
  if (columns(source.columnIds))
    source.columnIds.forEach((id, index) =>
      facts.push({
        label: "chat.jira.instanceWrite.columnPosition",
        value: `${String(index + 1)}: ${id}`,
      }),
    );
  if (typeof source.readOnlyEnabled === "boolean")
    facts.push({
      label:
        source.outcome === "succeeded" && jiraInstanceAdministrationIdentityComplete(tool, source)
          ? "chat.jira.instanceWrite.observedReadOnly"
          : "chat.jira.instanceWrite.requestedReadOnly",
      value: String(source.readOnlyEnabled),
    });
  return facts;
}
function emailFacts(source: Source): JiraAgileDetails["facts"] {
  return [
    ...fact("chat.jira.emailPack.rawDigest", source.uploadSha256),
    ...(positiveBytes(source.uploadBytes)
      ? [{ label: "chat.jira.emailPack.byteCount", value: String(source.uploadBytes) } as const]
      : []),
    ...fact("chat.jira.emailPack.priorManifest", source.priorManifestSha256),
    ...fact("chat.jira.emailPack.observedManifest", source.observedManifestSha256),
  ];
}
function entry(value: unknown): Source | undefined {
  const row = record(value);
  if (row === undefined || !nativeText(row.path, 1024) || !jiraAdministrativeDigest(row.sha256))
    return undefined;
  return typeof row.sizeBytes === "number" &&
    Number.isSafeInteger(row.sizeBytes) &&
    row.sizeBytes >= 0 &&
    row.sizeBytes <= 64 * 1024 * 1024
    ? row
    : undefined;
}
function archiveEntries(source: Source): readonly Source[] | undefined {
  if (
    !Array.isArray(source.items) ||
    source.items.length > 1000 ||
    source.entryCount !== source.items.length
  )
    return undefined;
  const items = source.items.map(entry);
  if (items.some((row) => row === undefined)) return undefined;
  const complete = items.filter((row): row is Source => row !== undefined);
  return new Set(complete.map((row) => row.path)).size === complete.length ? complete : undefined;
}
function archive(source: Source): readonly JiraAgileDetails[] {
  const items = archiveEntries(source);
  const complete =
    items !== undefined &&
    source.selectionScope === "complete-exported-email-template-pack" &&
    positiveBytes(source.archiveBytes) &&
    jiraAdministrativeDigest(source.archiveSha256) &&
    jiraAdministrativeDigest(source.manifestSha256);
  if (!complete) return [{ facts: [], labels: ["chat.jira.emailPack.metadataUnavailable"] }];
  return [
    {
      facts: [
        ...fact("chat.jira.emailPack.byteCount", String(source.archiveBytes)),
        ...fact("chat.jira.emailPack.entryCount", String(items.length)),
        ...fact("chat.jira.emailPack.rawDigest", source.archiveSha256),
        ...fact("chat.jira.emailPack.manifest", source.manifestSha256),
      ],
      labels: ["chat.jira.emailPack.metadataOnly", "chat.jira.emailPack.exportSideEffect"],
    },
    ...items.map((row) => ({
      facts: [
        ...fact("chat.jira.emailPack.entryPath", row.path),
        ...fact("chat.jira.emailPack.byteCount", String(row.sizeBytes)),
        ...fact("chat.jira.emailPack.entryDigest", row.sha256),
      ],
      labels: [],
    })),
  ];
}
export function jiraInstanceAdministrationDetails(
  tool: string,
  source: Source,
): readonly JiraAgileDetails[] {
  if (tool === "jira_email_template_pack") return archive(source);
  if (!JIRA_INSTANCE_ADMINISTRATION_WRITE_TOOLS.has(tool)) return [];
  const labels: WidgetMessageKey[] = [
    ...outcome(tool, source),
    "chat.jira.schemeWrite.configurationOnly",
  ];
  if (JIRA_EMAIL_TEMPLATE_WRITE_TOOLS.has(tool))
    labels.push("chat.jira.emailPack.unconfirmed", "chat.jira.emailPack.noDelivery");
  if (tool === "jira_set_instance_base_url")
    labels.push("chat.jira.instanceWrite.baseUrlConsequences");
  if (tool === "jira_set_read_only_mode") labels.push("chat.jira.instanceWrite.noEnforcementProof");
  return [
    {
      facts: [
        ...fact("chat.jira.fact.userKey", source.userKey),
        ...instanceFacts(tool, source),
        ...emailFacts(source),
      ],
      labels,
    },
  ];
}
