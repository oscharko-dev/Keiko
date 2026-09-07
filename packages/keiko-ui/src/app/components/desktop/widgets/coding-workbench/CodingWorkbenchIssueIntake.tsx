"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import type { GitHubIssuePreviewResponseWire } from "@/lib/api";
import { GITHUB_ISSUE_REFERENCE_MAX_CHARS } from "@/lib/api";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import {
  acceptedWorkbenchIssue,
  type AcceptedWorkbenchIssue,
  type IssueIntakeController,
  type IssueIntakeFailure,
} from "./useCodingWorkbenchIssueIntake";
import type { CodingWorkbenchSetupRuntimePosture } from "./CodingWorkbenchSetup";
import styles from "./CodingWorkbenchIssueIntake.module.css";
import workbenchStyles from "./CodingWorkbenchWindow.module.css";

interface IntakeProps {
  readonly intake: IssueIntakeController;
  readonly accepted: AcceptedWorkbenchIssue | null;
  readonly repositoryPath: string;
  readonly runtimePosture: CodingWorkbenchSetupRuntimePosture;
  readonly pending: boolean;
  readonly onAccepted: (issue: AcceptedWorkbenchIssue | null) => void;
  readonly onOpenGit: (() => void) | undefined;
}

const FIELD_ID = "coding-workbench-issue-ref";
const ALERT_ID = "coding-workbench-issue-failure";

function focusIssueField(): void {
  document.getElementById(FIELD_ID)?.focus();
}

function useIntakeFocus(props: Pick<IntakeProps, "accepted" | "intake">): {
  readonly heading: RefObject<HTMLHeadingElement | null>;
  readonly alert: RefObject<HTMLParagraphElement | null>;
  readonly accepted: RefObject<HTMLOutputElement | null>;
} {
  const heading = useRef<HTMLHeadingElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const accepted = useRef<HTMLOutputElement>(null);
  useEffect(() => {
    if (props.accepted !== null) accepted.current?.focus();
    else if (props.intake.state.kind === "ready") heading.current?.focus();
    else if (props.intake.state.kind === "failed") alert.current?.focus();
    else if (props.intake.state.kind === "cancelled") focusIssueField();
  }, [props.accepted, props.intake.state]);
  return { heading, alert, accepted };
}

export function CodingWorkbenchIssueIntake(props: IntakeProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const focus = useIntakeFocus(props);
  return (
    <section className={styles["cmp-issue-intake"]} aria-label={t("codingWorkbench.issue.title")}>
      <p className={styles["cmp-issue-note"]}>{t("codingWorkbench.issue.help")}</p>
      <IssueField {...props} />
      {props.accepted === null ? (
        <IntakeActions {...props} />
      ) : (
        <AcceptedIssue {...props} acceptedRef={focus.accepted} />
      )}
      <output
        className={styles["cmp-issue-status"]}
        data-testid="coding-workbench-issue-status"
        aria-live="polite"
        data-state={props.intake.state.kind}
      >
        {t(`codingWorkbench.issue.status.${props.intake.state.kind}`)}
      </output>
      <IntakeFailure {...props} alertRef={focus.alert} />
      {props.intake.state.kind === "ready" && props.accepted === null ? (
        <IssuePreview response={props.intake.state.response} headingRef={focus.heading} />
      ) : null}
      {props.intake.state.kind === "ready" && props.accepted === null ? (
        <PreviewActions {...props} />
      ) : null}
    </section>
  );
}

function AcceptedIssue(
  props: Pick<IntakeProps, "accepted" | "intake" | "onAccepted" | "pending"> & {
    readonly acceptedRef: RefObject<HTMLOutputElement | null>;
  },
): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const issue = props.accepted;
  if (issue === null) return null;
  const remove = (): void => {
    props.onAccepted(null);
    props.intake.change("");
    focusIssueField();
  };
  return (
    <output
      ref={props.acceptedRef}
      tabIndex={-1}
      className={styles["cmp-issue-chip"]}
      data-testid="coding-workbench-issue-accepted"
    >
      <span>
        {t("codingWorkbench.issue.accepted", {
          issue: issue.label,
          baseRef: issue.binding.defaultBaseRef,
        })}
      </span>
      <button
        type="button"
        disabled={props.pending}
        className={workbenchStyles.button}
        onClick={remove}
      >
        {t("codingWorkbench.issue.remove")}
      </button>
    </output>
  );
}

function IssueField({
  intake,
  pending,
  accepted,
  onAccepted,
}: Pick<IntakeProps, "intake" | "pending" | "accepted" | "onAccepted">): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return (
    <div className={styles["cmp-issue-field"]}>
      <label className={workbenchStyles.fieldLabel} htmlFor={FIELD_ID}>
        {t("codingWorkbench.issue.reference")}
      </label>
      <input
        id={FIELD_ID}
        className={workbenchStyles.setupInput}
        value={intake.issueRef}
        disabled={pending}
        maxLength={GITHUB_ISSUE_REFERENCE_MAX_CHARS}
        placeholder={t("codingWorkbench.issue.referencePlaceholder")}
        onChange={(event) => {
          if (accepted !== null) onAccepted(null);
          intake.change(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            intake.preview();
          }
        }}
      />
    </div>
  );
}

function IntakeActions({
  intake,
  repositoryPath,
  pending,
  onOpenGit,
}: Pick<IntakeProps, "intake" | "repositoryPath" | "pending" | "onOpenGit">): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const loading = intake.state.kind === "loading";
  return (
    <div className={styles["cmp-issue-actions"]}>
      <button
        type="button"
        className={workbenchStyles.button}
        onClick={intake.preview}
        disabled={
          pending || loading || intake.issueRef.trim() === "" || repositoryPath.trim() === ""
        }
      >
        {t(loading ? "codingWorkbench.issue.previewing" : "codingWorkbench.issue.preview")}
      </button>
      {loading ? (
        <button type="button" className={workbenchStyles.button} onClick={intake.cancel}>
          {t("codingWorkbench.issue.cancel")}
        </button>
      ) : null}
      {repositoryPath.trim() === "" && onOpenGit !== undefined ? (
        <RepositoryHandoff onOpenGit={onOpenGit} />
      ) : null}
    </div>
  );
}

function visibleFailure(
  props: Pick<IntakeProps, "intake" | "runtimePosture">,
): { readonly failure: IssueIntakeFailure; readonly correlationId?: string | undefined } | null {
  const state = props.intake.state;
  if (state.kind === "failed") return state;
  if (state.kind === "cancelled") return { failure: "cancelled" };
  if (state.kind === "ready" && props.runtimePosture === "unavailable")
    return { failure: "unavailable-runtime" };
  return null;
}

function IntakeFailure(
  props: Pick<IntakeProps, "intake" | "runtimePosture" | "onOpenGit"> & {
    readonly alertRef: RefObject<HTMLParagraphElement | null>;
  },
): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const failure = visibleFailure(props);
  if (failure === null) return null;
  return (
    <>
      <p
        id={ALERT_ID}
        ref={props.alertRef}
        role="alert"
        tabIndex={-1}
        data-testid="coding-workbench-issue-alert"
        data-failure={failure.failure}
        className={styles["cmp-issue-alert"]}
      >
        {t(`codingWorkbench.issue.error.${failure.failure}`)}
        {failure.correlationId === undefined ? null : (
          <span className={styles["cmp-issue-support"]}>
            {t("codingWorkbench.issue.supportId", { correlationId: failure.correlationId })}
          </span>
        )}
      </p>
      {props.intake.state.kind === "failed" ? (
        <button type="button" className={workbenchStyles.button} onClick={props.intake.preview}>
          {t("codingWorkbench.issue.retry")}
        </button>
      ) : null}
      {failure.failure === "repository-mismatch" ? (
        <RepositoryHandoff onOpenGit={props.onOpenGit} />
      ) : null}
    </>
  );
}

function RepositoryHandoff({
  onOpenGit,
}: {
  readonly onOpenGit: (() => void) | undefined;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return (
    <div className={styles["cmp-issue-actions"]}>
      <button
        type="button"
        className={workbenchStyles.button}
        onClick={() => document.getElementById("coding-workbench-setup-path")?.focus()}
      >
        {t("codingWorkbench.issue.changeRepository")}
      </button>
      {onOpenGit === undefined ? null : (
        <button type="button" className={workbenchStyles.button} onClick={onOpenGit}>
          {t("codingWorkbench.issue.openGit")}
        </button>
      )}
    </div>
  );
}

function PreviewActions(
  props: Pick<
    IntakeProps,
    "intake" | "runtimePosture" | "onAccepted" | "repositoryPath" | "pending"
  >,
): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const unavailable = props.runtimePosture === "unavailable" || props.runtimePosture === "pending";
  const accept = (): void => {
    if (props.intake.state.kind !== "ready" || unavailable) return;
    props.onAccepted(acceptedWorkbenchIssue(props.intake.state.response, props.repositoryPath));
  };
  return (
    <div className={styles["cmp-issue-actions"]}>
      <button
        type="button"
        disabled={unavailable || props.pending}
        aria-describedby={props.runtimePosture === "unavailable" ? ALERT_ID : undefined}
        className={workbenchStyles.button}
        onClick={accept}
      >
        {t("codingWorkbench.issue.confirm")}
      </button>
      <button
        type="button"
        className={workbenchStyles.button}
        onClick={() => {
          props.intake.reset();
          focusIssueField();
        }}
      >
        {t("codingWorkbench.issue.discard")}
      </button>
    </div>
  );
}

function IssueFacts({
  response,
  t,
}: {
  readonly response: GitHubIssuePreviewResponseWire;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const { preview, binding } = response;
  const facts = [
    [
      t("codingWorkbench.issue.fact.state"),
      t(
        preview.state === "open"
          ? "codingWorkbench.issue.state.open"
          : "codingWorkbench.issue.state.closed",
      ),
    ],
    [
      t("codingWorkbench.issue.fact.comments"),
      t("codingWorkbench.issue.commentCount", { count: preview.comments?.length ?? 0 }),
    ],
    [
      t("codingWorkbench.issue.fact.provenance"),
      `${preview.provenance.ownerAndRepo}#${String(preview.provenance.issueNumber)}`,
    ],
    [t("codingWorkbench.issue.fact.url"), preview.provenance.url],
    [t("codingWorkbench.issue.fact.baseRef"), binding.defaultBaseRef],
  ];
  return (
    <dl className={styles["cmp-issue-facts"]}>
      {facts.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function IssuePreview({
  response,
  headingRef,
}: {
  readonly response: GitHubIssuePreviewResponseWire;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return (
    <section
      className={styles["cmp-issue-preview"]}
      aria-label={t("codingWorkbench.issue.previewRegion")}
    >
      <h4 ref={headingRef} tabIndex={-1} className={styles["cmp-issue-preview-title"]}>
        {response.preview.title}
      </h4>
      <IssueFacts response={response} t={t} />
      <section
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- bounded scroll region must be keyboard reachable
        tabIndex={0}
        aria-label={t("codingWorkbench.issue.excerptLabel")}
        className={styles["cmp-issue-excerpt"]}
      >
        {response.preview.bodyExcerpt || t("codingWorkbench.issue.excerptEmpty")}
      </section>
      <IssueComments response={response} />
      {response.preview.bodyExcerptTruncated ? (
        <p className={styles["cmp-issue-note"]}>{t("codingWorkbench.issue.bodyTruncated")}</p>
      ) : null}
      <p className={styles["cmp-issue-note"]}>{t("codingWorkbench.issue.untrustedNote")}</p>
    </section>
  );
}

function identifiedComments(
  comments: readonly string[],
): readonly { readonly comment: string; readonly key: string }[] {
  const occurrences = new Map<string, number>();
  return comments.map((comment) => {
    const occurrence = (occurrences.get(comment) ?? 0) + 1;
    occurrences.set(comment, occurrence);
    return { comment, key: `${String(occurrence)}:${comment}` };
  });
}

function IssueComments({
  response,
}: {
  readonly response: GitHubIssuePreviewResponseWire;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const comments = response.preview.comments ?? [];
  if (comments.length === 0) return null;
  return (
    <section
      className={styles["cmp-issue-field"]}
      aria-label={t("codingWorkbench.issue.commentsLabel")}
    >
      {identifiedComments(comments).map(({ comment, key }, index) => (
        <section
          aria-label={t("codingWorkbench.issue.commentLabel", { index: index + 1 })}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- bounded scroll region must be keyboard reachable
          tabIndex={0}
          className={styles["cmp-issue-excerpt"]}
          key={key}
        >
          {comment}
        </section>
      ))}
      {response.preview.commentsTruncated ? (
        <p className={styles["cmp-issue-note"]}>{t("codingWorkbench.issue.commentsTruncated")}</p>
      ) : null}
    </section>
  );
}

export function IssueBaseRef({ issue }: { readonly issue: AcceptedWorkbenchIssue }): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return (
    <p className={styles["cmp-issue-baseref"]} data-testid="coding-workbench-issue-baseref">
      <code>{issue.binding.defaultBaseRef}</code>
      {t("codingWorkbench.issue.baseRefServerChosen")}
    </p>
  );
}
