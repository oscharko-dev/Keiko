import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { privateNativeCase } from "./jira-private-native-cases.js";
import { PROJECT_ISSUE_EXPECTED_OUTCOMES } from "./jira-project-issue-transport-fixture.js";

interface SelectedCase {
  readonly args: CatalogJsonObject;
  readonly receipt: CatalogJsonObject;
  readonly state: { readonly lifecycle: object };
  readonly outcome: "succeeded" | "succeeded-unconfirmed";
}
function selected(tool: string): SelectedCase {
  const value = privateNativeCase(tool);
  if (value?.receipt === undefined) throw new TypeError("Missing independent native mutation case");
  return {
    args: value.args,
    receipt: value.receipt,
    state: { lifecycle: value.state },
    outcome: value.outcome,
  };
}
/** Explicit mutation membership: password/license validators deliberately stay out of journals. */
const CASES = {
  "jira.create-user": selected("jira.create-user"),
  "jira.update-user": selected("jira.update-user"),
  "jira.delete-user": selected("jira.delete-user"),
  "jira.invalidate-user-session": selected("jira.invalidate-user-session"),
  "jira.schedule-user-anonymization": selected("jira.schedule-user-anonymization"),
  "jira.rerun-user-anonymization": selected("jira.rerun-user-anonymization"),
  "jira.update-myself": selected("jira.update-myself"),
  "jira.update-my-password": selected("jira.update-my-password"),
  "jira.update-user-password": selected("jira.update-user-password"),
  "jira.login": selected("jira.login"),
  "jira.logout": selected("jira.logout"),
  "jira.release-websudo": selected("jira.release-websudo"),
  "jira.upload-temporary-avatar": selected("jira.upload-temporary-avatar"),
  "jira.crop-temporary-avatar": selected("jira.crop-temporary-avatar"),
  "jira.upload-issue-type-avatar": selected("jira.upload-issue-type-avatar"),
  "jira.create-issue-type-avatar": selected("jira.create-issue-type-avatar"),
  "jira.upload-project-avatar": selected("jira.upload-project-avatar"),
  "jira.create-project-avatar": selected("jira.create-project-avatar"),
  "jira.set-project-avatar": selected("jira.set-project-avatar"),
  "jira.delete-project-avatar": selected("jira.delete-project-avatar"),
  "jira.upload-owned-avatar": selected("jira.upload-owned-avatar"),
  "jira.create-owned-avatar": selected("jira.create-owned-avatar"),
  "jira.delete-owned-avatar": selected("jira.delete-owned-avatar"),
  "jira.upload-user-avatar": selected("jira.upload-user-avatar"),
  "jira.create-user-avatar": selected("jira.create-user-avatar"),
  "jira.set-user-avatar": selected("jira.set-user-avatar"),
  "jira.delete-user-avatar": selected("jira.delete-user-avatar"),
  "jira.unlock-user-anonymization": selected("jira.unlock-user-anonymization"),
};
type PrivateWrite = keyof typeof CASES;
/** The closed mapping keeps every independently enumerated write in all three existing tables. */
function project<T>(read: (row: ReturnType<typeof selected>) => T): Record<PrivateWrite, T> {
  return {
    "jira.create-user": read(CASES["jira.create-user"]),
    "jira.update-user": read(CASES["jira.update-user"]),
    "jira.delete-user": read(CASES["jira.delete-user"]),
    "jira.invalidate-user-session": read(CASES["jira.invalidate-user-session"]),
    "jira.schedule-user-anonymization": read(CASES["jira.schedule-user-anonymization"]),
    "jira.rerun-user-anonymization": read(CASES["jira.rerun-user-anonymization"]),
    "jira.update-myself": read(CASES["jira.update-myself"]),
    "jira.update-my-password": read(CASES["jira.update-my-password"]),
    "jira.update-user-password": read(CASES["jira.update-user-password"]),
    "jira.login": read(CASES["jira.login"]),
    "jira.logout": read(CASES["jira.logout"]),
    "jira.release-websudo": read(CASES["jira.release-websudo"]),
    "jira.upload-temporary-avatar": read(CASES["jira.upload-temporary-avatar"]),
    "jira.crop-temporary-avatar": read(CASES["jira.crop-temporary-avatar"]),
    "jira.upload-issue-type-avatar": read(CASES["jira.upload-issue-type-avatar"]),
    "jira.create-issue-type-avatar": read(CASES["jira.create-issue-type-avatar"]),
    "jira.upload-project-avatar": read(CASES["jira.upload-project-avatar"]),
    "jira.create-project-avatar": read(CASES["jira.create-project-avatar"]),
    "jira.set-project-avatar": read(CASES["jira.set-project-avatar"]),
    "jira.delete-project-avatar": read(CASES["jira.delete-project-avatar"]),
    "jira.upload-owned-avatar": read(CASES["jira.upload-owned-avatar"]),
    "jira.create-owned-avatar": read(CASES["jira.create-owned-avatar"]),
    "jira.delete-owned-avatar": read(CASES["jira.delete-owned-avatar"]),
    "jira.upload-user-avatar": read(CASES["jira.upload-user-avatar"]),
    "jira.create-user-avatar": read(CASES["jira.create-user-avatar"]),
    "jira.set-user-avatar": read(CASES["jira.set-user-avatar"]),
    "jira.delete-user-avatar": read(CASES["jira.delete-user-avatar"]),
    "jira.unlock-user-anonymization": read(CASES["jira.unlock-user-anonymization"]),
  };
}
export const PRIVATE_ARGUMENTS = project<CatalogJsonObject>((row) => row.args);
export const PRIVATE_RECEIPTS = project<CatalogJsonObject>((row) => row.receipt);
export const PRIVATE_REMOTE_STATE = project<object>((row) => row.state);
export const FINAL_EXPECTED_OUTCOMES = {
  ...PROJECT_ISSUE_EXPECTED_OUTCOMES,
  ...project((row) => row.outcome),
};
export function expectedFinalOutcome(
  operation: string,
): "succeeded" | "succeeded-unconfirmed" | undefined {
  const outcomes: Readonly<Record<string, "succeeded" | "succeeded-unconfirmed">> =
    FINAL_EXPECTED_OUTCOMES;
  return Object.hasOwn(outcomes, operation) ? outcomes[operation] : undefined;
}
