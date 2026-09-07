import type { ReactNode } from "react";
import type {
  JourneyOutcome,
  GitJourneyRemoteFacts,
} from "@oscharko-dev/keiko-contracts/runtime/git-journey-outcome";
import { journeyEvidenceFresh } from "@oscharko-dev/keiko-contracts/runtime/git-journey-freshness";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import { journeyCiCurrent, journeyDescriptionCurrent } from "./_journeyPresentation";
import common from "./CodingWorkbenchWindow.module.css";
import styles from "./CodingWorkbenchJourneyOutcome.module.css";

export function JourneyDetails({
  outcome,
  now,
}: {
  readonly outcome: JourneyOutcome;
  readonly now: number;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return (
    <>
      <JourneyIdentity outcome={outcome} />
      <div className={styles["cmp-journey-groups"]}>
        <JourneyCi outcome={outcome} now={now} />
        <JourneyDescription outcome={outcome} now={now} />
      </div>
      {outcome.remote === null ? (
        <p className={common.helpText}>{t("codingWorkbench.journey.remoteUnknown")}</p>
      ) : (
        <JourneyRemote remote={outcome.remote} />
      )}
      {outcome.observationFailure !== null && (
        <p className={common.helpText}>
          {t(`codingWorkbench.ci.reason.${outcome.observationFailure.reason}`)}
        </p>
      )}
    </>
  );
}
function JourneyIdentity({
  outcome,
}: {
  readonly outcome: Pick<JourneyOutcome, "binding" | "observedAt" | "expiresAt">;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const root = `https://github.com/${outcome.binding.repository}`;
  return (
    <>
      <div className={styles["cmp-journey-links"]}>
        <a
          href={`${root}/issues/${String(outcome.binding.issueNumber)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t("codingWorkbench.journey.issueLink", { number: outcome.binding.issueNumber })}
        </a>
        <a
          href={`${root}/pull/${String(outcome.binding.prNumber)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t("codingWorkbench.journey.prLink", { number: outcome.binding.prNumber })}
        </a>
      </div>
      <dl className={common.approvalFacts}>
        <JourneyFact label={t("codingWorkbench.ci.head")}>
          <code>{outcome.binding.headSha}</code>
        </JourneyFact>
        <JourneyFact label={t("codingWorkbench.draftDelivery.baseRef")}>
          {outcome.binding.baseRef}
        </JourneyFact>
        <JourneyFact label={t("codingWorkbench.ci.observedAt")}>
          <JourneyTime value={outcome.observedAt} />
        </JourneyFact>
        <JourneyFact label={t("codingWorkbench.ci.expiresAt")}>
          <JourneyTime value={outcome.expiresAt} />
        </JourneyFact>
      </dl>
    </>
  );
}

function JourneyCi({
  outcome,
  now,
}: {
  readonly outcome: JourneyOutcome;
  readonly now: number;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const ci = outcome.readiness;
  let state: "unobserved" | "stale" | NonNullable<JourneyOutcome["readiness"]>["state"] =
    "unobserved";
  if (ci !== null) state = journeyCiCurrent(outcome, now) ? ci.state : "stale";
  return (
    <section className={styles["cmp-journey-group"]} aria-label={t("codingWorkbench.journey.ci")}>
      <h4>{t("codingWorkbench.journey.ci")}</h4>
      <p>{t(`codingWorkbench.ci.state.${state}`)}</p>
      {ci !== null && (
        <>
          <p>
            {t("codingWorkbench.journey.checkCounts", {
              passed: ci.requiredChecks.passed,
              total: ci.requiredChecks.total,
              failed: ci.advisoryChecks.failed,
            })}
          </p>
          <p>{t(`codingWorkbench.ci.reason.${ci.reason}`)}</p>
          <JourneyReviewCounts outcome={outcome} />
        </>
      )}
    </section>
  );
}
function JourneyReviewCounts({
  outcome,
}: {
  readonly outcome: Pick<JourneyOutcome, "readiness">;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const review = outcome.readiness?.humanReview;
  if (review === undefined || review.visibility === "unknown")
    return <p>{t("codingWorkbench.ci.reviewUnknown")}</p>;
  return (
    <p>
      {t("codingWorkbench.ci.reviewCounts", {
        approved: review.approvedCount ?? 0,
        required: review.requiredCount ?? 0,
        changes: review.changesRequestedCount ?? 0,
      })}
    </p>
  );
}
function descriptionState(
  outcome: JourneyOutcome,
  now: number,
): "unavailable" | NonNullable<JourneyOutcome["description"]>["state"] {
  const description = outcome.description;
  if (description === null) return "unavailable";
  if (!journeyEvidenceFresh(description, now)) return "stale";
  if (
    new Set(["current", "partial", "fallback"]).has(description.state) &&
    !journeyDescriptionCurrent(outcome, now)
  )
    return "stale";
  return description.state;
}
function JourneyDescription({
  outcome,
  now,
}: {
  readonly outcome: JourneyOutcome;
  readonly now: number;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const state = descriptionState(outcome, now);
  const applied = journeyDescriptionCurrent(outcome, now);
  return (
    <section
      className={styles["cmp-journey-group"]}
      aria-label={t("codingWorkbench.journey.description")}
    >
      <h4>{t("codingWorkbench.journey.description")}</h4>
      <p>{t(`codingWorkbench.journey.description.${state}`)}</p>
      <p>
        {t(`codingWorkbench.journey.${applied ? "descriptionApplied" : "descriptionUnconfirmed"}`)}
      </p>
      {outcome.description !== null && (
        <p>{t(`codingWorkbench.journey.completeness.${outcome.description.completeness}`)}</p>
      )}
    </section>
  );
}
function JourneyRemote({ remote }: { readonly remote: GitJourneyRemoteFacts }): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return (
    <dl className={common.approvalFacts}>
      <JourneyFact label={t("codingWorkbench.ci.pullRequest")}>
        {t(`codingWorkbench.draftDelivery.remote.${remote.identity.state}`)}
      </JourneyFact>
      <JourneyFact label={t("codingWorkbench.ci.draft")}>
        {t(`codingWorkbench.ci.${remote.identity.isDraft ? "isDraft" : "notDraft"}`)}
      </JourneyFact>
      <JourneyFact label={t("codingWorkbench.ci.humanReview")}>
        {t(`codingWorkbench.journey.review.${remote.reviewDecision}`)}
      </JourneyFact>
      <JourneyFact label={t("codingWorkbench.journey.conversations")}>
        {t("codingWorkbench.journey.conversationCounts", remote.reviewConversations)}
      </JourneyFact>
      <JourneyFact label={t("codingWorkbench.journey.merge")}>
        {remote.mergedAt === null ? (
          t("codingWorkbench.journey.notMerged")
        ) : (
          <JourneyTime value={remote.mergedAt} />
        )}
      </JourneyFact>
      <JourneyFact label={t("codingWorkbench.journey.issueState")}>
        {t(`codingWorkbench.journey.issue.${remote.issue.state}`)}
      </JourneyFact>
      {remote.issue.closedAt !== null && (
        <JourneyFact label={t("codingWorkbench.journey.closedAt")}>
          <JourneyTime value={remote.issue.closedAt} />
        </JourneyFact>
      )}
    </dl>
  );
}
function JourneyFact({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className={common.approvalFact}>
      <dt>{label}</dt>
      <dd className={styles["cmp-journey-value"]}>{children}</dd>
    </div>
  );
}
function JourneyTime({ value }: { readonly value: string }): ReactNode {
  return <time dateTime={value}>{value.replace("T", " ").replace(".000Z", " UTC")}</time>;
}
