import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { configurationExchange } from "./jira-configuration-mutation.test-fixture";

interface ResultCase {
  readonly operation: string;
  readonly receipt: CatalogJsonObject;
  readonly confirmed?: true;
  readonly read?: true;
}
const ACTOR = { actorUserKey: "actor-key" };
const USER = { ...ACTOR, userKey: "target-key", username: "Target User" };
const SELF = { ...ACTOR, userKey: "actor-key", username: "Operator" };
const PROJECT = { projectId: "9007199254740993", projectKey: "SYN" };
const RESOURCE_PROJECT = { userKey: "actor-key", ...PROJECT };
const ISSUE = { userKey: "actor-key", issueId: "9223372036854775807", issueKey: "SYN-1" };
const TEMP = {
  ...ACTOR,
  uploadSha256: "a".repeat(64),
  uploadBytes: 12,
  temporaryAvatar: true,
  temporaryCrop: { cropperOffsetX: 0, cropperOffsetY: 1, cropperWidth: 8 },
  temporaryNeedsCropping: false,
};
const CREATED = {
  ...ACTOR,
  uploadSha256: "a".repeat(64),
  uploadBytes: 12,
  avatarPresent: true,
  avatarId: "9223372036854775807",
};
const SELECTED = { ...ACTOR, avatarId: "9223372036854775807", avatarSelected: true };
const DELETED = { ...ACTOR, avatarId: "9223372036854775807", avatarPresent: false };
/** Independent persisted UI examples: no server receipt validator or native fixture is imported. */
export const ACCOUNT_RESOURCE_CASES = [
  { operation: "jira.upload-temporary-avatar", receipt: { ...TEMP, avatarType: "user" } },
  { operation: "jira.crop-temporary-avatar", receipt: { ...TEMP, avatarType: "project" } },
  {
    operation: "jira.upload-issue-type-avatar",
    receipt: { ...TEMP, avatarType: "issuetype", issueTypeId: "1" },
  },
  {
    operation: "jira.create-issue-type-avatar",
    receipt: { ...CREATED, avatarType: "issuetype", issueTypeId: "1" },
  },
  {
    operation: "jira.upload-project-avatar",
    receipt: { ...TEMP, avatarType: "project", ...PROJECT },
  },
  {
    operation: "jira.create-project-avatar",
    receipt: { ...CREATED, avatarType: "project", ...PROJECT },
  },
  {
    operation: "jira.set-project-avatar",
    receipt: { ...SELECTED, avatarType: "project", ...PROJECT },
    confirmed: true,
  },
  {
    operation: "jira.delete-project-avatar",
    receipt: { ...DELETED, avatarType: "project", ...PROJECT },
  },
  {
    operation: "jira.upload-owned-avatar",
    receipt: { ...TEMP, avatarType: "issuetype", issueTypeId: "1" },
  },
  {
    operation: "jira.create-owned-avatar",
    receipt: { ...CREATED, avatarType: "project", ...PROJECT },
  },
  {
    operation: "jira.delete-owned-avatar",
    receipt: { ...DELETED, avatarType: "issuetype", issueTypeId: "1" },
  },
  {
    operation: "jira.upload-user-avatar",
    receipt: { ...TEMP, avatarType: "user", userKey: "target-key" },
  },
  {
    operation: "jira.create-user-avatar",
    receipt: { ...CREATED, avatarType: "user", userKey: "target-key" },
  },
  {
    operation: "jira.set-user-avatar",
    receipt: { ...SELECTED, avatarType: "user", userKey: "target-key" },
    confirmed: true,
  },
  {
    operation: "jira.delete-user-avatar",
    receipt: { ...DELETED, avatarType: "user", userKey: "target-key" },
  },
  { operation: "jira.create-user", receipt: { ...USER, userPresent: true } },
  { operation: "jira.update-user", receipt: { ...USER, userPresent: true }, confirmed: true },
  { operation: "jira.delete-user", receipt: { ...USER, userPresent: false } },
  {
    operation: "jira.invalidate-user-session",
    receipt: { ...USER, userSessionInvalidationRequested: true },
  },
  {
    operation: "jira.schedule-user-anonymization",
    receipt: { ...USER, newOwnerUserKey: "replacement-key", anonymizationRequested: true },
  },
  {
    operation: "jira.rerun-user-anonymization",
    receipt: {
      ...USER,
      newOwnerUserKey: "replacement-key",
      anonymizationRequested: true,
      anonymizationRerunRequested: true,
    },
  },
  {
    operation: "jira.archive-issues",
    receipt: {
      userKey: "actor-key",
      issueIds: ["9223372036854775807", "10002"],
      issueKeys: ["SYN-1", "SYN-2"],
      issueArchivedRequested: true,
    },
  },
  { operation: "jira.delete-issue", receipt: { ...ISSUE, issuePresent: false } },
  { operation: "jira.archive-issue", receipt: { ...ISSUE, issueArchivedRequested: true } },
  { operation: "jira.restore-issue", receipt: { ...ISSUE, issueArchivedRequested: false } },
  {
    operation: "jira.move-subtask",
    receipt: { ...ISSUE, subtaskIds: ["10002", "10003"], originalPosition: 0, currentPosition: 1 },
  },
  {
    operation: "jira.create-issues",
    receipt: {
      userKey: "actor-key",
      requestedIssueCount: 2,
      issueIds: ["10004"],
      issueKeys: ["SYN-4"],
      bulkFailedElementNumbers: [1],
      bulkFailureStatuses: [400],
    },
  },
  {
    operation: "jira.create-reciprocal-remote-link",
    receipt: {
      ...ISSUE,
      applicationLinkId: "11111111-1111-4111-8111-111111111111",
      applicationLinkDestinationDigest: "b".repeat(64),
      selectedRemoteIssueId: "9999",
      delegatedEffectRequested: true,
      linkId: "6",
    },
  },
  { operation: "jira.delete-project", receipt: { ...RESOURCE_PROJECT, projectPresent: false } },
  {
    operation: "jira.archive-project",
    receipt: { ...RESOURCE_PROJECT, projectArchivedRequested: true },
  },
  {
    operation: "jira.restore-project",
    receipt: { ...RESOURCE_PROJECT, projectArchivedRequested: false },
  },
  {
    operation: "jira.update-project-type",
    receipt: { ...RESOURCE_PROJECT, projectTypeKey: "business" },
  },
  {
    operation: "jira.set-project-permission-scheme",
    receipt: {
      ...RESOURCE_PROJECT,
      schemeId: "2",
      previousSchemeId: "1",
      projectSchemeAssigned: true,
    },
  },
  {
    operation: "jira.set-project-priority-scheme",
    receipt: {
      ...RESOURCE_PROJECT,
      schemeId: "2",
      previousSchemeId: "1",
      projectSchemeAssigned: true,
    },
  },
  {
    operation: "jira.remove-project-priority-scheme",
    receipt: { ...RESOURCE_PROJECT, schemeId: "2", projectSchemeAssigned: false },
  },
  { operation: "jira.update-myself", receipt: SELF, confirmed: true },
  { operation: "jira.update-my-password", receipt: SELF },
  { operation: "jira.update-user-password", receipt: USER },
  { operation: "jira.login", receipt: { ...SELF, sessionEstablished: true }, confirmed: true },
  { operation: "jira.logout", receipt: SELF },
  { operation: "jira.release-websudo", receipt: SELF },
  {
    operation: "jira.validate-create-user-password",
    receipt: {
      ...ACTOR,
      username: "Prospective",
      validationScope: "native-password-policy-only",
      accepted: false,
      violationCount: 2,
    },
    read: true,
  },
  {
    operation: "jira.validate-update-user-password",
    receipt: {
      ...USER,
      validationScope: "native-password-policy-only",
      accepted: true,
      violationCount: 0,
    },
    read: true,
  },
  {
    operation: "jira.validate-license",
    receipt: {
      ...ACTOR,
      validationScope: "native-license-validation-only",
      accepted: false,
      violationCount: 1,
    },
    read: true,
  },
  {
    operation: "jira.unlock-user-anonymization",
    receipt: {
      ...ACTOR,
      userKey: "target-key",
      executingNode: "node-a",
      anonymizationSubmittedTime: "native-submitted",
    },
  },
] as const satisfies readonly ResultCase[];
export function accountResourceCase(operation: string): ResultCase {
  const selected = ACCOUNT_RESOURCE_CASES.find((entry) => entry.operation === operation);
  if (selected === undefined) throw new TypeError("Missing account/resource presentation fixture");
  return selected;
}
export function accountResourceExchange(
  selected: ResultCase,
  index = 0,
  data?: CatalogJsonObject,
  outcome?: ChatToolExchange["mutationOutcome"],
): ChatToolExchange {
  const exchange = configurationExchange(
    selected.operation.replace(/[.-]/gu, "_"),
    data ?? {
      ...selected.receipt,
      outcome:
        selected.read === true || selected.confirmed === true
          ? "succeeded"
          : "succeeded-unconfirmed",
    },
    index,
    outcome,
  );
  return selected.read === true && exchange.result !== undefined
    ? { ...exchange, result: { ...exchange.result, effectStarted: false } }
    : exchange;
}
