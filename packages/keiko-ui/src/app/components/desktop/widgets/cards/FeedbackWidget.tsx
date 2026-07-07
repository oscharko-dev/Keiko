"use client";

import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  FEEDBACK_REPORT_CATEGORIES,
  FEEDBACK_REPORT_SEVERITIES,
  type FeedbackIntakeItem,
  type FeedbackReportCategory,
  type FeedbackReportDraft,
  type FeedbackReportPreview,
  type FeedbackReportSeverity,
  type FeedbackReviewAction,
} from "@oscharko-dev/keiko-contracts/feedback-intake";
import {
  ApiError,
  createFeedbackGithubIssue,
  fetchFeedbackIntakeQueue,
  previewFeedbackReport,
  reviewFeedbackIntakeItem,
  submitFeedbackPreview,
} from "@/lib/api";
import { useTranslate } from "@/lib/i18n";
import { Icons } from "../../Icons";
import styles from "./FeedbackWidget.module.css";

const PUBLIC_GITHUB_ISSUES_URL = "https://github.com/oscharko-dev/Keiko/issues/new";
const REVIEW_ACTIONS = [
  "request-follow-up",
  "reject",
  "archive",
  "approve-for-github",
] as const satisfies readonly FeedbackReviewAction[];
type FeedbackQueueReviewAction = (typeof REVIEW_ACTIONS)[number];

interface FeedbackFormState {
  readonly category: FeedbackReportCategory;
  readonly severity: FeedbackReportSeverity;
  readonly title: string;
  readonly description: string;
  readonly reproductionSteps: string;
  readonly expectedBehavior: string;
  readonly actualBehavior: string;
  readonly featureArea: string;
}

const DEFAULT_FORM: FeedbackFormState = {
  category: "bug",
  severity: "medium",
  title: "",
  description: "",
  reproductionSteps: "",
  expectedBehavior: "",
  actualBehavior: "",
  featureArea: "",
};

function formatError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return `${error.message} (${error.code})`;
  if (error instanceof Error) return error.message;
  return fallback;
}

function splitSteps(value: string): readonly string[] | undefined {
  const steps = value
    .split(/\r?\n/u)
    .map((step) => step.trim())
    .filter((step) => step.length > 0);
  return steps.length > 0 ? steps : undefined;
}

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function clientDiagnostics(featureArea: string): FeedbackReportDraft["diagnostics"] {
  const nav = typeof navigator === "undefined" ? null : navigator;
  const os = nav?.userAgent === undefined ? undefined : nav.userAgent.slice(0, 120);
  const featureAreaValue = optionalText(featureArea);
  return {
    keikoVersion: "local-ui",
    platform: nav?.platform ?? "browser",
    uiMode: "desktop",
    ...(os === undefined ? {} : { os }),
    ...(featureAreaValue === undefined ? {} : { featureArea: featureAreaValue }),
  };
}

function draftFromForm(form: FeedbackFormState): FeedbackReportDraft {
  const reproductionSteps = splitSteps(form.reproductionSteps);
  const expectedBehavior = optionalText(form.expectedBehavior);
  const actualBehavior = optionalText(form.actualBehavior);
  const featureArea = optionalText(form.featureArea);
  return {
    category: form.category,
    severity: form.severity,
    title: form.title,
    description: form.description,
    diagnostics: clientDiagnostics(form.featureArea),
    ...(reproductionSteps === undefined ? {} : { reproductionSteps }),
    ...(expectedBehavior === undefined ? {} : { expectedBehavior }),
    ...(actualBehavior === undefined ? {} : { actualBehavior }),
    ...(featureArea === undefined ? {} : { featureArea }),
  };
}

function previewText(preview: FeedbackReportPreview | null): string {
  if (preview === null) return "";
  return JSON.stringify(preview, null, 2);
}

export function FeedbackWidget(): ReactNode {
  const t = useTranslate();
  const [form, setForm] = useState<FeedbackFormState>(DEFAULT_FORM);
  const [preview, setPreview] = useState<FeedbackReportPreview | null>(null);
  const [queue, setQueue] = useState<readonly FeedbackIntakeItem[]>([]);
  const [status, setStatus] = useState<string>("");
  const [queueStatus, setQueueStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [queueError, setQueueError] = useState<string>("");
  const [busy, setBusy] = useState<"preview" | "submit" | null>(null);
  const [queueBusy, setQueueBusy] = useState<string | null>(null);

  const payload = useMemo(() => previewText(preview), [preview]);
  const canPreview = form.title.trim().length > 0 && form.description.trim().length > 0;
  const canSubmit = preview !== null && preview.safeToSubmit && busy === null;

  const refreshQueue = async (): Promise<void> => {
    setQueueBusy("refresh");
    setQueueError("");
    try {
      const result = await fetchFeedbackIntakeQueue();
      setQueue(result.items);
      setQueueStatus(t("feedback.queue.loaded", { count: result.items.length }));
    } catch (queueLoadError) {
      setQueueError(formatError(queueLoadError, t("feedback.queue.error.load")));
      setQueueStatus("");
    } finally {
      setQueueBusy(null);
    }
  };

  useEffect(() => {
    void refreshQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one initial queue hydration per mount.
  }, []);

  const updateField =
    <K extends keyof FeedbackFormState>(key: K) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>): void => {
      const value = event.currentTarget.value as FeedbackFormState[K];
      setForm((current) => ({ ...current, [key]: value }));
      setPreview(null);
      setStatus("");
      setError("");
    };

  const onPreview = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canPreview || busy !== null) return;
    setBusy("preview");
    setError("");
    setStatus(t("feedback.status.previewing"));
    try {
      const nextPreview = await previewFeedbackReport(draftFromForm(form));
      setPreview(nextPreview);
      setStatus(
        nextPreview.safeToSubmit
          ? t("feedback.status.previewReady")
          : t("feedback.status.previewBlocked"),
      );
    } catch (previewError) {
      setError(formatError(previewError, t("feedback.error.preview")));
      setStatus("");
    } finally {
      setBusy(null);
    }
  };

  const onSubmit = async (): Promise<void> => {
    if (!canSubmit || preview === null) return;
    setBusy("submit");
    setError("");
    setStatus(t("feedback.status.submitting"));
    try {
      const result = await submitFeedbackPreview(preview);
      setStatus(t("feedback.status.submitted", { intakeId: result.receipt.intakeId }));
      await refreshQueue();
    } catch (submitError) {
      setError(formatError(submitError, t("feedback.error.submit")));
      setStatus("");
    } finally {
      setBusy(null);
    }
  };

  const onReview = async (intakeId: string, action: FeedbackQueueReviewAction): Promise<void> => {
    setQueueBusy(`${intakeId}:${action}`);
    setQueueError("");
    try {
      const item = await reviewFeedbackIntakeItem({ intakeId, action, actor: "local-maintainer" });
      setQueue((current) =>
        current.map((entry) => (entry.receipt.intakeId === intakeId ? item : entry)),
      );
      setQueueStatus(t("feedback.queue.reviewed", { intakeId }));
    } catch (reviewError) {
      setQueueError(formatError(reviewError, t("feedback.queue.error.review")));
    } finally {
      setQueueBusy(null);
    }
  };

  const onCreateGithubIssue = async (intakeId: string): Promise<void> => {
    setQueueBusy(`${intakeId}:github`);
    setQueueError("");
    try {
      const item = await createFeedbackGithubIssue(intakeId);
      setQueue((current) =>
        current.map((entry) => (entry.receipt.intakeId === intakeId ? item : entry)),
      );
      setQueueStatus(t("feedback.queue.githubCreated", { intakeId }));
    } catch (githubError) {
      setQueueError(formatError(githubError, t("feedback.queue.error.github")));
    } finally {
      setQueueBusy(null);
    }
  };

  return (
    <section className={styles.scope} aria-label={t("feedback.title")}>
      <div className={styles.header}>
        <div>
          <h3 className={styles.title}>{t("feedback.title")}</h3>
          <p className={styles.subtitle}>{t("feedback.subtitle")}</p>
        </div>
        <a
          className={styles.githubLink}
          href={PUBLIC_GITHUB_ISSUES_URL}
          target="_blank"
          rel="noreferrer"
        >
          <Icons.external size={14} />
          <span>{t("feedback.githubLink")}</span>
        </a>
      </div>

      <form className={styles.grid} onSubmit={onPreview}>
        <label className={styles.field}>
          <span className={styles.label}>{t("feedback.category")}</span>
          <select
            className={styles.control}
            value={form.category}
            onChange={updateField("category")}
          >
            {FEEDBACK_REPORT_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(`feedback.category.${category}`)}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>{t("feedback.severity")}</span>
          <select
            className={styles.control}
            value={form.severity}
            onChange={updateField("severity")}
          >
            {FEEDBACK_REPORT_SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {t(`feedback.severity.${severity}`)}
              </option>
            ))}
          </select>
        </label>
        <label className={`${styles.field} ${styles.fieldWide}`}>
          <span className={styles.label}>{t("feedback.field.title")}</span>
          <input
            className={styles.control}
            value={form.title}
            maxLength={160}
            onChange={updateField("title")}
            required
          />
        </label>
        <label className={`${styles.field} ${styles.fieldWide}`}>
          <span className={styles.label}>{t("feedback.field.description")}</span>
          <textarea
            className={styles.control}
            value={form.description}
            maxLength={8000}
            rows={4}
            onChange={updateField("description")}
            required
          />
        </label>
        <label className={`${styles.field} ${styles.fieldWide}`}>
          <span className={styles.label}>{t("feedback.field.steps")}</span>
          <textarea
            className={styles.control}
            value={form.reproductionSteps}
            rows={3}
            onChange={updateField("reproductionSteps")}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>{t("feedback.field.expected")}</span>
          <textarea
            className={styles.control}
            value={form.expectedBehavior}
            rows={3}
            onChange={updateField("expectedBehavior")}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>{t("feedback.field.actual")}</span>
          <textarea
            className={styles.control}
            value={form.actualBehavior}
            rows={3}
            onChange={updateField("actualBehavior")}
          />
        </label>
        <label className={`${styles.field} ${styles.fieldWide}`}>
          <span className={styles.label}>{t("feedback.field.featureArea")}</span>
          <input
            className={styles.control}
            value={form.featureArea}
            maxLength={120}
            onChange={updateField("featureArea")}
          />
        </label>
        <div className={`${styles.actions} ${styles.fieldWide}`}>
          <button className={styles.button} type="submit" disabled={!canPreview || busy !== null}>
            {busy === "preview" ? t("feedback.action.previewing") : t("feedback.action.preview")}
          </button>
          <button
            className={`${styles.button} ${styles.buttonPrimary}`}
            type="button"
            disabled={!canSubmit}
            onClick={onSubmit}
          >
            {busy === "submit" ? t("feedback.action.submitting") : t("feedback.action.submit")}
          </button>
        </div>
      </form>

      {status.length > 0 ? <p className={styles.status}>{status}</p> : null}
      {error.length > 0 ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      {preview !== null ? (
        <section className={styles.preview} aria-label={t("feedback.preview")}>
          <div className={styles.previewHeader}>
            <h4 className={styles.previewTitle}>{t("feedback.preview")}</h4>
            <div className={styles.badges}>
              <span className={styles.badge}>
                {t("feedback.preview.bytes", { bytes: preview.payloadByteLength })}
              </span>
              <span className={styles.badge}>
                {t("feedback.preview.redactions", {
                  count: preview.provenance.redactedFields.length,
                })}
              </span>
            </div>
          </div>
          <pre className={styles.payload}>{payload}</pre>
        </section>
      ) : null}

      <section className={styles.queue} aria-label={t("feedback.queue.title")}>
        <div className={styles.previewHeader}>
          <h4 className={styles.previewTitle}>{t("feedback.queue.title")}</h4>
          <button
            className={styles.button}
            type="button"
            disabled={queueBusy !== null}
            onClick={() => {
              void refreshQueue();
            }}
          >
            {queueBusy === "refresh" ? t("feedback.queue.refreshing") : t("feedback.queue.refresh")}
          </button>
        </div>
        {queueStatus.length > 0 ? <p className={styles.status}>{queueStatus}</p> : null}
        {queueError.length > 0 ? (
          <p className={styles.error} role="alert">
            {queueError}
          </p>
        ) : null}
        {queue.length === 0 ? (
          <p className={styles.status}>{t("feedback.queue.empty")}</p>
        ) : (
          <ul className={styles.queueList}>
            {queue.map((item) => (
              <li key={item.receipt.intakeId} className={styles.queueItem}>
                <div className={styles.queueItemHeader}>
                  <div>
                    <strong className={styles.queueTitle}>{item.report.title}</strong>
                    <p className={styles.queueMeta}>
                      {item.receipt.intakeId} - {t(`feedback.category.${item.report.category}`)} -{" "}
                      {t(`feedback.intakeStatus.${item.review.status}`)}
                    </p>
                  </div>
                  {item.githubIssue === undefined ? null : (
                    <a
                      className={styles.githubLink}
                      href={item.githubIssue.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Icons.external size={14} />
                      <span>#{item.githubIssue.number.toString()}</span>
                    </a>
                  )}
                </div>
                <p className={styles.queueDescription}>{item.report.description}</p>
                <div className={styles.badges}>
                  <span className={styles.badge}>
                    {t("feedback.preview.redactions", {
                      count: item.provenance.redactedFields.length,
                    })}
                  </span>
                  <span className={styles.badge}>{item.receipt.submittedAt}</span>
                </div>
                <div className={styles.actions}>
                  {REVIEW_ACTIONS.map((action) => (
                    <button
                      key={action}
                      className={styles.button}
                      type="button"
                      disabled={queueBusy !== null || item.review.status === "github-created"}
                      onClick={() => {
                        void onReview(item.receipt.intakeId, action);
                      }}
                    >
                      {t(`feedback.review.${action}`)}
                    </button>
                  ))}
                  <button
                    className={`${styles.button} ${styles.buttonPrimary}`}
                    type="button"
                    disabled={queueBusy !== null || item.review.status !== "approved-for-github"}
                    onClick={() => {
                      void onCreateGithubIssue(item.receipt.intakeId);
                    }}
                  >
                    {t("feedback.queue.createGithub")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
