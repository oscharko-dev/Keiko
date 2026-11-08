import {
  copyJiraHumanInputReview,
  type JiraHumanInputPurpose,
  type JiraHumanInputView,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { OptionalWidgetTranslate, WidgetMessageKey } from "@/lib/optional-widget-i18n";

function purposeKey(purpose: JiraHumanInputPurpose): WidgetMessageKey {
  switch (purpose) {
    case "update-myself":
      return "chat.jira.humanInput.review.profile";
    case "update-my-password":
      return "chat.jira.humanInput.review.ownPassword";
    case "update-user-password":
      return "chat.jira.humanInput.review.userPassword";
    case "validate-create-user-password":
      return "chat.jira.humanInput.review.createValidation";
    case "validate-update-user-password":
      return "chat.jira.humanInput.review.updateValidation";
    case "validate-license":
      return "chat.jira.humanInput.review.licenseValidation";
    case "login":
      return "chat.jira.humanInput.review.login";
    case "unlock-user-anonymization":
      return "chat.jira.humanInput.review.unlock";
  }
}
export interface JiraHumanInputFact {
  readonly label: string;
  readonly value: string;
}
/** Display-only facts from the server-owned review; never links, HTML or model call arguments. */
export function jiraHumanInputReviewFacts(
  view: JiraHumanInputView,
  t: OptionalWidgetTranslate,
): readonly JiraHumanInputFact[] | undefined {
  const review = copyJiraHumanInputReview(view.review, view.purpose);
  if (review === undefined) return undefined;
  const facts: JiraHumanInputFact[] = [
    { label: t("chat.jira.humanInput.review.server"), value: review.jiraBaseUrl },
    { label: t("chat.jira.humanInput.review.purpose"), value: t(purposeKey(view.purpose)) },
    { label: t("chat.jira.humanInput.review.actorUsername"), value: review.actorUsername },
    { label: t("chat.jira.humanInput.review.actorKey"), value: review.actorUserKey },
  ];
  if (review.targetKind === "instance")
    facts.push({
      label: t("chat.jira.humanInput.review.target"),
      value: t("chat.jira.humanInput.review.instance"),
    });
  else if (review.targetKind === "proposed-user")
    facts.push({
      label: t("chat.jira.humanInput.review.proposedUsername"),
      value: review.targetUsername,
    });
  else {
    facts.push(
      { label: t("chat.jira.humanInput.review.targetKey"), value: review.targetUserKey },
      review.targetKind === "user"
        ? { label: t("chat.jira.humanInput.review.targetUsername"), value: review.targetUsername }
        : { label: t("chat.jira.humanInput.review.executingNode"), value: review.executingNode },
    );
  }
  return facts;
}
/** A live refresh may fill old absent metadata, but cannot retarget an already reviewed card. */
export function sameJiraHumanInputReview(
  previous: JiraHumanInputView,
  next: JiraHumanInputView,
): boolean {
  if (previous.purpose !== next.purpose) return false;
  const current = copyJiraHumanInputReview(next.review, next.purpose);
  if (current === undefined) return false;
  if (previous.review === undefined) return true;
  const retained = copyJiraHumanInputReview(previous.review, previous.purpose);
  return retained !== undefined && JSON.stringify(retained) === JSON.stringify(current);
}
