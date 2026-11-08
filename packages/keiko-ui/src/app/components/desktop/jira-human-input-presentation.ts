import { copyJiraHumanInputReview, type JiraHumanInputPurpose, type JiraHumanInputView } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";

const PURPOSE: Readonly<Record<JiraHumanInputPurpose, WidgetMessageKey>> = {
  "update-myself": "chat.jira.humanInput.review.profile",
  "update-my-password": "chat.jira.humanInput.review.ownPassword",
  "update-user-password": "chat.jira.humanInput.review.userPassword",
  "validate-create-user-password": "chat.jira.humanInput.review.createValidation",
  "validate-update-user-password": "chat.jira.humanInput.review.updateValidation",
  "validate-license": "chat.jira.humanInput.review.licenseValidation",
  login: "chat.jira.humanInput.review.login",
  "unlock-user-anonymization": "chat.jira.humanInput.review.unlock",
};
export interface JiraHumanInputFact { readonly label: string; readonly value: string }
/** Display-only facts from the server-owned review; never links, HTML or model call arguments. */
export function jiraHumanInputReviewFacts(view: JiraHumanInputView,
  t: (key: WidgetMessageKey) => string): readonly JiraHumanInputFact[] | undefined {
  const review = copyJiraHumanInputReview(view.review, view.purpose);
  if (review === undefined) return undefined;
  const facts: JiraHumanInputFact[] = [
    { label: t("chat.jira.humanInput.review.server"), value: review.jiraBaseUrl },
    { label: t("chat.jira.humanInput.review.purpose"), value: t(PURPOSE[view.purpose]) },
    { label: t("chat.jira.humanInput.review.actorUsername"), value: review.actorUsername },
    { label: t("chat.jira.humanInput.review.actorKey"), value: review.actorUserKey },
  ];
  if (review.targetKind === "instance") facts.push({ label: t("chat.jira.humanInput.review.target"), value: t("chat.jira.humanInput.review.instance") });
  else if (review.targetKind === "proposed-user") facts.push({ label: t("chat.jira.humanInput.review.proposedUsername"), value: review.targetUsername });
  else {
    facts.push({ label: t("chat.jira.humanInput.review.targetKey"), value: review.targetUserKey });
    facts.push(review.targetKind === "user"
      ? { label: t("chat.jira.humanInput.review.targetUsername"), value: review.targetUsername }
      : { label: t("chat.jira.humanInput.review.executingNode"), value: review.executingNode });
  }
  return facts;
}
/** A live refresh may fill old absent metadata, but cannot retarget an already reviewed card. */
export function sameJiraHumanInputReview(previous: JiraHumanInputView, next: JiraHumanInputView): boolean {
  if (previous.purpose !== next.purpose) return false;
  const current = copyJiraHumanInputReview(next.review, next.purpose);
  if (current === undefined) return false;
  if (previous.review === undefined) return true;
  const retained = copyJiraHumanInputReview(previous.review, previous.purpose);
  return retained !== undefined && JSON.stringify(retained) === JSON.stringify(current);
}
