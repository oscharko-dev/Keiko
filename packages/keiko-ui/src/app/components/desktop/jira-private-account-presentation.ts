import {
  JIRA_PRIVATE_ACCOUNT_MUTATIONS,
  JIRA_READ_TOOL_FAMILIES,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails } from "./jira-agile-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationMutationLabels,
} from "./jira-presentation-values";
import {
  accountResourceAliases,
  accountResourceFields as fields,
  accountResourcePrincipal as principal,
  accountResourceInteger as integer,
  accountResourceBudget as budget,
  accountResourceOwn as own,
  type AccountResourceSource as Source,
} from "./jira-account-resource-values";

export const JIRA_PRIVATE_ACCOUNT_WRITE_TOOLS = accountResourceAliases(
  JIRA_PRIVATE_ACCOUNT_MUTATIONS,
);
const JIRA_PRIVATE_ACCOUNT_READ_TOOLS = accountResourceAliases(
  JIRA_READ_TOOL_FAMILIES.privateAccount,
);
export const JIRA_PRIVATE_ACCOUNT_TOOLS: ReadonlySet<string> = new Set([
  ...JIRA_PRIVATE_ACCOUNT_WRITE_TOOLS,
  ...JIRA_PRIVATE_ACCOUNT_READ_TOOLS,
]);
function boundUser(tool: string, source: Source): boolean {
  return (
    principal(source.actorUserKey) &&
    principal(source.userKey) &&
    principal(source.username) &&
    (tool === "jira_update_user_password" || source.actorUserKey === source.userKey)
  );
}
export function jiraPrivateAccountIdentityComplete(tool: string, source: Source): boolean {
  if (!own(source) || !JIRA_PRIVATE_ACCOUNT_WRITE_TOOLS.has(tool)) return false;
  return (
    fields(
      source,
      ["actorUserKey", "userKey", "username"],
      tool === "jira_login" ? ["sessionEstablished"] : [],
    ) &&
    boundUser(tool, source) &&
    (!Object.hasOwn(source, "sessionEstablished") || source.sessionEstablished === true) &&
    budget(source)
  );
}
export function jiraPrivateAccountConfirmationUnavailable(tool: string, source: Source): boolean {
  return (
    JIRA_PRIVATE_ACCOUNT_WRITE_TOOLS.has(tool) &&
    tool !== "jira_update_myself" &&
    !(tool === "jira_login" && source.sessionEstablished === true)
  );
}
function validationUserFields(tool: string): readonly string[] {
  if (tool === "jira_validate_license") return [];
  return tool === "jira_validate_update_user_password" ? ["userKey", "username"] : ["username"];
}
function readComplete(tool: string, source: Source): boolean {
  const license = tool === "jira_validate_license";
  const userFields = validationUserFields(tool);
  if (
    !own(source) ||
    source.outcome !== "succeeded" ||
    !fields(source, [
      "actorUserKey",
      "validationScope",
      "accepted",
      "violationCount",
      ...userFields,
    ])
  )
    return false;
  return (
    principal(source.actorUserKey) &&
    userFields.every((field) => principal(source[field])) &&
    source.validationScope ===
      (license ? "native-license-validation-only" : "native-password-policy-only") &&
    integer(source.violationCount, 0, 1000) &&
    source.accepted === (source.violationCount === 0)
  );
}
function privateRead(tool: string, source: Source): readonly JiraAgileDetails[] {
  const scope: WidgetMessageKey =
    tool === "jira_validate_license"
      ? "chat.jira.accountWrite.licenseValidationScope"
      : "chat.jira.accountWrite.passwordValidationScope";
  if (!readComplete(tool, source))
    return [{ facts: [], labels: [scope, "chat.jira.savedConfiguration.identityUnknown"] }];
  return [
    {
      facts: [
        ...fact("chat.jira.systemAction.actorKey", source.actorUserKey),
        ...fact("chat.jira.systemAction.targetUser", source.userKey),
        ...fact("chat.jira.accounts.username", source.username),
        { label: "chat.jira.accountWrite.validationAccepted", value: String(source.accepted) },
        { label: "chat.jira.accountWrite.violationCount", value: String(source.violationCount) },
      ],
      labels: [scope, "chat.jira.accountWrite.privateValuesOmitted"],
    },
  ];
}
export function jiraPrivateAccountDetails(
  tool: string,
  source: Source,
): readonly JiraAgileDetails[] {
  if (JIRA_PRIVATE_ACCOUNT_READ_TOOLS.has(tool)) return privateRead(tool, source);
  const valid = jiraPrivateAccountIdentityComplete(tool, source);
  const labels: WidgetMessageKey[] = [
    "chat.jira.accountWrite.privateValuesOmitted",
    tool === "jira_update_myself"
      ? "chat.jira.accountWrite.profileScope"
      : "chat.jira.accountWrite.privateEffectScope",
  ];
  if (!valid)
    return [{ facts: [], labels: [...labels, "chat.jira.savedConfiguration.identityUnknown"] }];
  const unavailable = jiraPrivateAccountConfirmationUnavailable(tool, source);
  labels.push(
    ...jiraPresentationMutationLabels(
      {
        ...source,
        outcome:
          unavailable && source.outcome === "succeeded" ? "succeeded-unconfirmed" : source.outcome,
        unchanged: tool === "jira_update_myself" && source.unchanged === true,
      },
      true,
    ),
  );
  if (tool === "jira_login")
    labels.push(
      source.outcome === "succeeded" && source.sessionEstablished === true
        ? "chat.jira.accountWrite.sessionObserved"
        : "chat.jira.accountWrite.sessionUnconfirmed",
    );
  return [
    {
      facts: [
        ...fact("chat.jira.systemAction.actorKey", source.actorUserKey),
        ...fact("chat.jira.systemAction.targetUser", source.userKey),
        ...fact("chat.jira.accounts.username", source.username),
      ],
      labels,
    },
  ];
}
