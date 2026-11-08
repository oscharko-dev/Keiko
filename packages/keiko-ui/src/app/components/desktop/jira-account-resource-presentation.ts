import type { JiraAgileDetails } from "./jira-agile-presentation";
import type { AccountResourceSource as Source } from "./jira-account-resource-values";
import { JIRA_RESOURCE_LIFECYCLE_TOOLS, jiraResourceLifecycleDetails, jiraResourceLifecycleIdentityComplete, jiraResourceLifecycleNoopSupported } from "./jira-resource-lifecycle-presentation";
import { JIRA_AVATAR_IDENTITY_TOOLS, jiraAvatarIdentityDetails, jiraAvatarIdentityComplete, jiraAvatarIdentityConfirmationUnavailable, jiraAvatarIdentityNoopSupported } from "./jira-avatar-identity-presentation";
import { JIRA_PRIVATE_ACCOUNT_TOOLS, JIRA_PRIVATE_ACCOUNT_WRITE_TOOLS, jiraPrivateAccountDetails, jiraPrivateAccountIdentityComplete, jiraPrivateAccountConfirmationUnavailable } from "./jira-private-account-presentation";
import { JIRA_ANONYMIZATION_UNLOCK_TOOLS, jiraAnonymizationUnlockIdentityComplete, jiraAnonymizationUnlockDetails } from "./jira-anonymization-unlock-presentation";

export const JIRA_ACCOUNT_RESOURCE_WRITE_TOOLS: ReadonlySet<string> = new Set([...JIRA_RESOURCE_LIFECYCLE_TOOLS, ...JIRA_AVATAR_IDENTITY_TOOLS, ...JIRA_PRIVATE_ACCOUNT_WRITE_TOOLS, ...JIRA_ANONYMIZATION_UNLOCK_TOOLS]);
export const JIRA_ACCOUNT_RESOURCE_TOOLS: ReadonlySet<string> = new Set([...JIRA_ACCOUNT_RESOURCE_WRITE_TOOLS, ...JIRA_PRIVATE_ACCOUNT_TOOLS]);
export function jiraAccountResourceIdentityComplete(tool: string, source: Source): boolean {
  if (JIRA_ANONYMIZATION_UNLOCK_TOOLS.has(tool)) return jiraAnonymizationUnlockIdentityComplete(source);
  if (JIRA_RESOURCE_LIFECYCLE_TOOLS.has(tool)) return jiraResourceLifecycleIdentityComplete(tool, source);
  return JIRA_AVATAR_IDENTITY_TOOLS.has(tool) ? jiraAvatarIdentityComplete(tool, source) : jiraPrivateAccountIdentityComplete(tool, source);
}
export function jiraAccountResourceConfirmationUnavailable(tool: string, args: unknown, source: Source): boolean {
  return JIRA_ANONYMIZATION_UNLOCK_TOOLS.has(tool) || JIRA_RESOURCE_LIFECYCLE_TOOLS.has(tool) || jiraAvatarIdentityConfirmationUnavailable(tool, args, source) || jiraPrivateAccountConfirmationUnavailable(tool, source);
}
export function jiraAccountResourceNoopSupported(tool: string): boolean {
  return jiraResourceLifecycleNoopSupported(tool) || jiraAvatarIdentityNoopSupported(tool) || tool === "jira_update_myself";
}
export function jiraAccountResourceDetails(tool: string, source: Source, args?: unknown): readonly JiraAgileDetails[] {
  if (JIRA_ANONYMIZATION_UNLOCK_TOOLS.has(tool)) return jiraAnonymizationUnlockDetails(source);
  if (JIRA_RESOURCE_LIFECYCLE_TOOLS.has(tool)) return jiraResourceLifecycleDetails(tool, source);
  return JIRA_AVATAR_IDENTITY_TOOLS.has(tool) ? jiraAvatarIdentityDetails(tool, source, args) : jiraPrivateAccountDetails(tool, source);
}
