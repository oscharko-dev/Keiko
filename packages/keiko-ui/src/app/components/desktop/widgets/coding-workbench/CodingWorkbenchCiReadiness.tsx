"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";
import type {
  GitCiCheckCounts,
  ReadinessSnapshot,
} from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import { validateCodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import common from "./CodingWorkbenchWindow.module.css";
import styles from "./CodingWorkbenchCiReadiness.module.css";

const LIVE_STATES = new Set(["running", "ready", "awaiting-approval"]);
const COUNTS = ["total", "passed", "failed", "pending", "blocked", "unknown"] as const;

/** A saved observation is evidence, never authority or a command to poll the provider. */
export function CodingWorkbenchCiReadiness({
  snapshot,
}: {
  readonly snapshot: CodingWorkbenchRuntimeSnapshot | undefined;
}): ReactNode {
  const parsed = validateCodingWorkbenchRuntimeSnapshot(snapshot);
  if (!parsed.ok || parsed.value.draftDelivery?.pullRequest === undefined) return null;
  return (
    <CiReadinessCard snapshot={parsed.value} head={parsed.value.draftDelivery.binding.headSha} />
  );
}

function CiReadinessCard({
  snapshot,
  head,
}: {
  readonly snapshot: CodingWorkbenchRuntimeSnapshot;
  readonly head: string;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const observation = snapshot.ciReadiness;
  const now = useObservationClock(observation?.expiresAt);
  const stale = isStale(snapshot, now);
  const state = displayState(observation, stale);
  useEffect(() => {
    reportClientDiagnostic(`[keiko] CI readiness displayed: ${state} head ${head.slice(0, 12)}`);
  }, [head, state, snapshot.runId]);
  return (
    <section className={common.card} aria-label={t("codingWorkbench.ci.title")}>
      <h3 className={common.approvalResearchTitle}>{t("codingWorkbench.ci.title")}</h3>
      <output className={styles["cmp-ci-state"]} data-state={state}>
        {t(`codingWorkbench.ci.state.${state}`)}
      </output>
      <p className={common.helpText}>{t(`codingWorkbench.ci.${stale ? "staleHelp" : "help"}`)}</p>
      {observation !== undefined && <ObservationDetails observation={observation} t={t} />}
    </section>
  );
}

function isStale(snapshot: CodingWorkbenchRuntimeSnapshot, now: number): boolean {
  const observation = snapshot.ciReadiness;
  if (observation === undefined) return false;
  return (
    !LIVE_STATES.has(snapshot.state) ||
    snapshot.draftDelivery?.phase !== "draft-created" ||
    now >= Date.parse(observation.expiresAt) ||
    now < Date.parse(observation.observedAt)
  );
}

function displayState(
  observation: ReadinessSnapshot | undefined,
  stale: boolean,
): ReadinessSnapshot["state"] | "stale" | "unobserved" {
  if (observation === undefined) return "unobserved";
  return stale ? "stale" : observation.state;
}

function useObservationClock(expiresAt: string | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === undefined) return;
    const update = (): void => {
      setNow(Date.now());
    };
    const initial = globalThis.setTimeout(update, 0);
    const timer = globalThis.setTimeout(
      update,
      Math.max(0, Date.parse(expiresAt) - Date.now()) + 1,
    );
    document.addEventListener("visibilitychange", update);
    globalThis.addEventListener("pageshow", update);
    return (): void => {
      globalThis.clearTimeout(initial);
      globalThis.clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
      globalThis.removeEventListener("pageshow", update);
    };
  }, [expiresAt]);
  return now;
}

function ObservationDetails({
  observation,
  t,
}: {
  readonly observation: ReadinessSnapshot;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <>
      <p className={common.helpText}>{t(`codingWorkbench.ci.reason.${observation.reason}`)}</p>
      <div className={styles["cmp-ci-groups"]}>
        <CheckCounts kind="required" counts={observation.requiredChecks} t={t} />
        <CheckCounts kind="advisory" counts={observation.advisoryChecks} t={t} />
      </div>
      <dl className={common.approvalFacts}>
        <Fact label={t("codingWorkbench.ci.head")} value={<code>{observation.headSha}</code>} />
        <Fact
          label={t("codingWorkbench.ci.observedAt")}
          value={<ObservedTime value={observation.observedAt} />}
        />
        <Fact
          label={t("codingWorkbench.ci.expiresAt")}
          value={<ObservedTime value={observation.expiresAt} />}
        />
        <Fact
          label={t("codingWorkbench.ci.completeness")}
          value={t(`codingWorkbench.ci.${observation.complete ? "complete" : "incomplete"}`)}
        />
      </dl>
      <ReviewContext observation={observation} t={t} />
    </>
  );
}

function CheckCounts({
  kind,
  counts,
  t,
}: {
  readonly kind: "required" | "advisory";
  readonly counts: GitCiCheckCounts;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <section className={styles["cmp-ci-checks"]} aria-label={t(`codingWorkbench.ci.${kind}`)}>
      <h4>{t(`codingWorkbench.ci.${kind}`)}</h4>
      <dl className={styles["cmp-ci-counts"]}>
        {COUNTS.map((key) => (
          <div key={key}>
            <dt>{t(`codingWorkbench.ci.count.${key}`)}</dt>
            <dd>{counts[key]}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ReviewContext({
  observation,
  t,
}: {
  readonly observation: Pick<ReadinessSnapshot, "pullRequest" | "humanReview">;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const { pullRequest, humanReview } = observation;
  const review =
    humanReview.visibility === "unknown"
      ? t("codingWorkbench.ci.reviewUnknown")
      : t("codingWorkbench.ci.reviewCounts", {
          approved: humanReview.approvedCount ?? 0,
          required: humanReview.requiredCount ?? 0,
          changes: humanReview.changesRequestedCount ?? 0,
        });
  return (
    <dl className={common.approvalFacts}>
      <Fact
        label={t("codingWorkbench.ci.pullRequest")}
        value={t(`codingWorkbench.ci.pr.${pullRequest.status}`)}
      />
      <Fact
        label={t("codingWorkbench.ci.draft")}
        value={t(`codingWorkbench.ci.${pullRequest.isDraft ? "isDraft" : "notDraft"}`)}
      />
      <Fact label={t("codingWorkbench.ci.humanReview")} value={review} />
      <Fact
        label={t("codingWorkbench.ci.conflict")}
        value={t(`codingWorkbench.ci.conflict.${pullRequest.conflict}`)}
      />
      <Fact
        label={t("codingWorkbench.ci.baseCurrency")}
        value={t(`codingWorkbench.ci.base.${pullRequest.baseCurrency}`)}
      />
    </dl>
  );
}
function Fact({ label, value }: { readonly label: string; readonly value: ReactNode }): ReactNode {
  return (
    <div className={common.approvalFact}>
      <dt>{label}</dt>
      <dd className={styles["cmp-ci-value"]}>{value}</dd>
    </div>
  );
}
function ObservedTime({ value }: { readonly value: string }): ReactNode {
  return <time dateTime={value}>{value.replace("T", " ").replace(".000Z", " UTC")}</time>;
}
