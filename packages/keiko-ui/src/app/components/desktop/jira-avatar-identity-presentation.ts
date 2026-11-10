import {
  JIRA_AVATAR_MUTATIONS,
  JIRA_IDENTITY_MUTATIONS,
  JIRA_ATTACHMENT_MAX_BYTES,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationMutationLabels,
} from "./jira-presentation-values";
import {
  accountResourceAliases,
  accountResourceFields as fields,
  accountResourceExactFields as exactFields,
  accountResourceId as id,
  accountResourceKey as key,
  accountResourcePrincipal as principal,
  accountResourceInteger as integer,
  accountResourceDigest as digest,
  accountResourceBudget as budget,
  accountResourceOwn as own,
  accountResourceRecord as record,
  type AccountResourceSource as Source,
} from "./jira-account-resource-values";

const JIRA_AVATAR_WRITE_TOOLS = accountResourceAliases(JIRA_AVATAR_MUTATIONS);
const JIRA_IDENTITY_WRITE_TOOLS = accountResourceAliases(JIRA_IDENTITY_MUTATIONS);
export const JIRA_AVATAR_IDENTITY_TOOLS: ReadonlySet<string> = new Set([
  ...JIRA_AVATAR_WRITE_TOOLS,
  ...JIRA_IDENTITY_WRITE_TOOLS,
]);
const USER = ["actorUserKey", "userKey", "username"];
function createdIdentity(source: Source): boolean {
  return (
    fields(source, ["actorUserKey", "userPresent"], ["userKey", "username"]) &&
    source.userPresent === true &&
    ((!Object.hasOwn(source, "userKey") && !Object.hasOwn(source, "username")) ||
      (principal(source.userKey) && principal(source.username)))
  );
}
function anonymizationIdentity(tool: string, source: Source): boolean {
  const rerun = tool === "jira_rerun_user_anonymization";
  return (
    fields(source, [
      ...USER,
      "newOwnerUserKey",
      "anonymizationRequested",
      ...(rerun ? ["anonymizationRerunRequested"] : []),
    ]) &&
    principal(source.newOwnerUserKey) &&
    source.newOwnerUserKey !== source.userKey &&
    source.anonymizationRequested === true &&
    (!rerun || source.anonymizationRerunRequested === true)
  );
}
function existingIdentity(tool: string, source: Source): boolean {
  if (tool === "jira_update_user")
    return (
      fields(source, [...USER, "userPresent"], ["userActive"]) &&
      source.userPresent === true &&
      (!Object.hasOwn(source, "userActive") || typeof source.userActive === "boolean")
    );
  if (tool === "jira_delete_user")
    return fields(source, [...USER, "userPresent"]) && source.userPresent === false;
  if (tool === "jira_invalidate_user_session")
    return (
      fields(source, [...USER, "userSessionInvalidationRequested"]) &&
      source.userSessionInvalidationRequested === true
    );
  return anonymizationIdentity(tool, source);
}
function identityComplete(tool: string, source: Source): boolean {
  if (!principal(source.actorUserKey)) return false;
  if (tool === "jira_create_user") return createdIdentity(source);
  return principal(source.userKey) && principal(source.username) && existingIdentity(tool, source);
}
function crop(value: unknown): boolean {
  const source = record(value);
  return (
    source !== undefined &&
    exactFields(source, ["cropperOffsetX", "cropperOffsetY", "cropperWidth"]) &&
    integer(source.cropperOffsetX) &&
    integer(source.cropperOffsetY) &&
    integer(source.cropperWidth, 1)
  );
}
function typedAvatarOwner(source: Source): readonly string[] | undefined {
  if (source.avatarType === "project")
    return id(source.projectId) && key(source.projectKey) ? ["projectId", "projectKey"] : undefined;
  return source.avatarType === "issuetype" && id(source.issueTypeId) ? ["issueTypeId"] : undefined;
}
const AVATAR_TYPES: ReadonlySet<unknown> = new Set(["user", "project", "issuetype"]);
function avatarOwner(tool: string, source: Source): readonly string[] | undefined {
  if (tool.endsWith("_temporary_avatar"))
    return AVATAR_TYPES.has(source.avatarType) ? [] : undefined;
  if (tool.includes("_owned_")) return typedAvatarOwner(source);
  if (tool.includes("_project_"))
    return source.avatarType === "project" ? typedAvatarOwner(source) : undefined;
  if (tool.includes("_issue_type_"))
    return source.avatarType === "issuetype" ? typedAvatarOwner(source) : undefined;
  return source.avatarType === "user" && principal(source.userKey) ? ["userKey"] : undefined;
}
function temporary(tool: string): boolean {
  return tool.startsWith("jira_upload_") || tool === "jira_crop_temporary_avatar";
}
function temporaryComplete(source: Source, required: readonly string[]): boolean {
  return (
    fields(
      source,
      [...required, "uploadSha256", "uploadBytes", "temporaryAvatar"],
      ["temporaryCrop", "temporaryNeedsCropping"],
    ) &&
    digest(source.uploadSha256) &&
    integer(source.uploadBytes, 1, JIRA_ATTACHMENT_MAX_BYTES) &&
    source.temporaryAvatar === true &&
    ((!Object.hasOwn(source, "temporaryCrop") &&
      !Object.hasOwn(source, "temporaryNeedsCropping")) ||
      (crop(source.temporaryCrop) && typeof source.temporaryNeedsCropping === "boolean"))
  );
}
function createdAvatar(source: Source, required: readonly string[]): boolean {
  return (
    fields(source, [...required, "uploadSha256", "uploadBytes", "avatarPresent"], ["avatarId"]) &&
    digest(source.uploadSha256) &&
    integer(source.uploadBytes, 1, JIRA_ATTACHMENT_MAX_BYTES) &&
    source.avatarPresent === true &&
    (!Object.hasOwn(source, "avatarId") || id(source.avatarId))
  );
}
function avatarComplete(tool: string, source: Source): boolean {
  const owner = avatarOwner(tool, source);
  if (owner === undefined || !principal(source.actorUserKey)) return false;
  const required = ["actorUserKey", "avatarType", ...owner];
  if (temporary(tool)) return temporaryComplete(source, required);
  if (tool.startsWith("jira_create_")) return createdAvatar(source, required);
  return tool.startsWith("jira_set_")
    ? fields(source, [...required, "avatarId", "avatarSelected"]) &&
        id(source.avatarId) &&
        source.avatarSelected === true
    : fields(source, [...required, "avatarId", "avatarPresent"]) &&
        id(source.avatarId) &&
        source.avatarPresent === false;
}
export function jiraAvatarIdentityComplete(tool: string, source: Source): boolean {
  if (!own(source) || !JIRA_AVATAR_IDENTITY_TOOLS.has(tool)) return false;
  return (
    (JIRA_AVATAR_WRITE_TOOLS.has(tool)
      ? avatarComplete(tool, source)
      : identityComplete(tool, source)) && budget(source)
  );
}
const CONFIRMABLE = new Set([
  "jira_set_project_avatar",
  "jira_set_user_avatar",
  "jira_update_user",
]);
export function jiraAvatarIdentityConfirmationUnavailable(
  tool: string,
  args: unknown,
  source: Source,
): boolean {
  if (!JIRA_AVATAR_IDENTITY_TOOLS.has(tool)) return false;
  if (!CONFIRMABLE.has(tool)) return true;
  return (
    tool === "jira_update_user" &&
    (Object.hasOwn(source, "userActive") || Object.hasOwn(record(args) ?? {}, "active"))
  );
}
export function jiraAvatarIdentityNoopSupported(tool: string): boolean {
  return CONFIRMABLE.has(tool);
}
function scalarFacts(source: Source, confirmed: boolean): JiraOutcomeFact[] {
  const result = [
    ...fact("chat.jira.systemAction.actorKey", source.actorUserKey),
    ...fact("chat.jira.systemAction.targetUser", source.userKey),
    ...fact("chat.jira.accounts.username", source.username),
    ...fact("chat.jira.fact.projectId", source.projectId),
    ...fact("chat.jira.fact.projectKey", source.projectKey),
    ...fact("chat.jira.fact.issueTypeId", source.issueTypeId),
    ...fact("chat.jira.accountWrite.avatarType", source.avatarType),
    ...fact("chat.jira.accountWrite.avatarId", source.avatarId),
    ...fact("chat.jira.accountWrite.uploadDigest", source.uploadSha256),
    ...fact("chat.jira.accountWrite.newOwner", source.newOwnerUserKey),
  ];
  if (typeof source.uploadBytes === "number")
    result.push({ label: "chat.jira.accountWrite.uploadBytes", value: String(source.uploadBytes) });
  const targets = {
    userPresent: "chat.jira.resourceWrite.requestedPresence",
    userActive: "chat.jira.accountWrite.requestedActive",
    avatarPresent: "chat.jira.resourceWrite.requestedPresence",
    avatarSelected: confirmed
      ? "chat.jira.accountWrite.observedSelection"
      : "chat.jira.accountWrite.requestedSelection",
    temporaryAvatar: "chat.jira.accountWrite.temporaryRequested",
    temporaryNeedsCropping: "chat.jira.accountWrite.ackNeedsCrop",
  } as const;
  for (const [field, label] of Object.entries(targets))
    if (typeof source[field] === "boolean") result.push({ label, value: String(source[field]) });
  return result;
}
function avatarScope(tool: string): WidgetMessageKey {
  if (tool.startsWith("jira_set_")) return "chat.jira.accountWrite.avatarSelectionScope";
  return temporary(tool)
    ? "chat.jira.accountWrite.temporaryScope"
    : "chat.jira.accountWrite.avatarConsequences";
}
function identityLabels(tool: string, source: Source): WidgetMessageKey[] {
  const labels: WidgetMessageKey[] = [];
  if (tool.includes("anonymization")) labels.push("chat.jira.accountWrite.anonymizationScope");
  if (tool === "jira_invalidate_user_session")
    labels.push("chat.jira.accountWrite.sessionInvalidationScope");
  const createdId = JIRA_AVATAR_WRITE_TOOLS.has(tool) ? source.avatarId : source.userKey;
  if (tool.startsWith("jira_create_") && createdId === undefined)
    labels.push("chat.jira.accountWrite.createdIdentityUnknown");
  return labels;
}
function acknowledgedCrop(source: Source): JiraOutcomeFact[] {
  const observedCrop = record(source.temporaryCrop);
  if (observedCrop === undefined) return [];
  const cropFields = [
    ["cropperOffsetX", "chat.jira.accountWrite.cropX"],
    ["cropperOffsetY", "chat.jira.accountWrite.cropY"],
    ["cropperWidth", "chat.jira.accountWrite.cropWidth"],
  ] as const;
  return cropFields.map(([field, label]) => ({ label, value: String(observedCrop[field]) }));
}
export function jiraAvatarIdentityDetails(
  tool: string,
  source: Source,
  args?: unknown,
): readonly JiraAgileDetails[] {
  const valid = jiraAvatarIdentityComplete(tool, source);
  const unavailable = jiraAvatarIdentityConfirmationUnavailable(tool, args, source);
  const labels: WidgetMessageKey[] = [
    JIRA_AVATAR_WRITE_TOOLS.has(tool)
      ? avatarScope(tool)
      : "chat.jira.accountWrite.identityConsequences",
  ];
  if (!valid)
    return [{ facts: [], labels: [...labels, "chat.jira.savedConfiguration.identityUnknown"] }];
  labels.push(
    ...jiraPresentationMutationLabels(
      {
        ...source,
        outcome:
          unavailable && source.outcome === "succeeded" ? "succeeded-unconfirmed" : source.outcome,
        unchanged: jiraAvatarIdentityNoopSupported(tool) && source.unchanged === true,
      },
      true,
    ),
    ...identityLabels(tool, source),
  );
  const facts = [
    ...scalarFacts(source, source.outcome === "succeeded" && !unavailable),
    ...acknowledgedCrop(source),
  ];
  return [{ facts, labels }];
}
