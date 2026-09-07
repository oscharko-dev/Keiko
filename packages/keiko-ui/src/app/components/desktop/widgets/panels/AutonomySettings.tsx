"use client";

import { useId, type ReactNode } from "react";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import {
  CODING_WORKBENCH_MODES,
  compareCodingWorkbenchModeAuthority,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { useAutonomyModePolicy } from "../../hooks/useAutonomyModePolicy";
import {
  useGitHubIssueReaderAuthorization,
  type GitHubIssueReaderAuthorization,
} from "../../hooks/useGitHubIssueReaderAuthorization";
import { useOptionalChatSessionProject } from "../../context/ChatSessionContext";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "../coding-workbench/coding-workbench-i18n";
import { useSettingsTranslate as useTranslate, type I18nTranslate } from "./settings-i18n";
import styles from "./AutonomySettings.module.css";
import intakeStyles from "../coding-workbench/CodingWorkbenchIssueIntake.module.css";

const MODE_KEYS = {
  "governed-assist": {
    label: "settings.autonomy.mode.governedAssist.label",
    description: "settings.autonomy.mode.governedAssist.description",
  },
  "supervised-coding": {
    label: "settings.autonomy.mode.supervisedCoding.label",
    description: "settings.autonomy.mode.supervisedCoding.description",
  },
  "autonomous-delivery": {
    label: "settings.autonomy.mode.autonomousDelivery.label",
    description: "settings.autonomy.mode.autonomousDelivery.description",
  },
} as const;

function modeLabel(mode: CodingWorkbenchMode, t: I18nTranslate): string {
  return t(MODE_KEYS[mode].label);
}

// A deployment ceiling is an authority bound, not a preference: an option above it can be requested
// but never takes effect. Mark it at the option itself so the bound is visible before the choice,
// rather than only as an after-the-fact clamp notice. The ordering comes from the contracts helper
// so this surface cannot fork the authority order locally.
function cappedByCeiling(
  mode: CodingWorkbenchMode,
  deploymentCeiling: CodingWorkbenchMode | null,
): boolean {
  return (
    deploymentCeiling !== null && compareCodingWorkbenchModeAuthority(mode, deploymentCeiling) > 0
  );
}

function ModeOption({
  groupId,
  mode,
  selected,
  disabled,
  capped,
  onChange,
  t,
}: {
  readonly groupId: string;
  readonly mode: CodingWorkbenchMode;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly capped: boolean;
  readonly onChange: (mode: CodingWorkbenchMode) => void;
  readonly t: I18nTranslate;
}): ReactNode {
  const id = `${groupId}-${mode}`;
  const copy = MODE_KEYS[mode];
  return (
    <label
      className={styles.option}
      data-selected={selected}
      data-capped={capped}
      data-mode={mode}
      htmlFor={id}
      aria-label={t(copy.label)}
    >
      <input
        id={id}
        type="radio"
        name={groupId}
        value={mode}
        checked={selected}
        disabled={disabled}
        onChange={() => onChange(mode)}
      />
      <span className={styles.optionText}>
        <strong>{t(copy.label)}</strong>
        <span>{t(copy.description)}</span>
        {capped ? (
          <span className={styles.capped}>{t("settings.autonomy.mode.capped")}</span>
        ) : null}
      </span>
    </label>
  );
}

function GitHubIssueAccessToggle({
  grant,
  disabled,
  describedBy,
  t,
}: {
  readonly grant: GitHubIssueReaderAuthorization;
  readonly disabled: boolean;
  readonly describedBy: string;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const id = useId();
  return (
    <label className={styles.option} data-selected={grant.authorized} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={grant.authorized}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => {
          grant.change(event.target.checked);
        }}
      />
      <span className={styles.optionText}>
        <strong>{t("codingWorkbench.githubAccess.toggle")}</strong>
        <span>
          {grant.authorized
            ? t("codingWorkbench.githubAccess.enabled")
            : t("codingWorkbench.githubAccess.disabled")}
        </span>
        {grant.repositoryId === null ? null : (
          <span>
            {t("codingWorkbench.githubAccess.repositoryId")}:{" "}
            <code className={`mono ${intakeStyles["cmp-issue-grant-id"] ?? ""}`}>
              {grant.repositoryId}
            </code>
          </span>
        )}
      </span>
    </label>
  );
}

function GitHubIssueAccessStatus({
  grant,
  repositoryPath,
  t,
}: {
  readonly grant: GitHubIssueReaderAuthorization;
  readonly repositoryPath: string | null;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <>
      {/* A live region without role="status": the clamp notice above owns that role on this
          surface, and the loading sentence must not be mistaken for it. */}
      <p className={styles.footnote} aria-live="polite" aria-atomic="true">
        {grant.pending ? t("codingWorkbench.githubAccess.loading") : ""}
      </p>
      {repositoryPath === null ? (
        <p className={styles.notice}>{t("codingWorkbench.githubAccess.noRepository")}</p>
      ) : null}
      {grant.error === null ? null : (
        <p className={styles.error} role="alert">
          {t(`codingWorkbench.githubAccess.error.${grant.error}`)}
        </p>
      )}
    </>
  );
}

/**
 * The per-checkout GitHub issue reader grant (#3385). Server-persisted and revisioned like the
 * autonomy mode above it; keyed on the SELECTED project path, which the server accepts only as a
 * registered project and resolves to a content-free repository id itself. The id is the only
 * identity shown — never the path, never a remote.
 *
 * Its strings live in the Coding Workbench feature catalog because the grant is that feature's
 * capability; the settings catalog is not this change's to extend.
 */
function GitHubIssueAccessSettings(): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const repositoryPath = useOptionalChatSessionProject()?.path ?? null;
  const grant = useGitHubIssueReaderAuthorization(repositoryPath);
  const baseId = useId();
  const titleId = `${baseId}-github-access-title`;
  const descriptionId = `${baseId}-github-access-description`;
  return (
    <fieldset className={styles.fieldset} aria-labelledby={titleId}>
      <legend id={titleId}>{t("codingWorkbench.githubAccess.title")}</legend>
      <p id={descriptionId} className={styles.footnote}>
        {t("codingWorkbench.githubAccess.description")}
      </p>
      <div className={styles.group}>
        <GitHubIssueAccessToggle
          grant={grant}
          disabled={grant.pending || repositoryPath === null}
          describedBy={descriptionId}
          t={t}
        />
      </div>
      <GitHubIssueAccessStatus grant={grant} repositoryPath={repositoryPath} t={t} />
    </fieldset>
  );
}

export function AutonomySettings(): ReactNode {
  const t = useTranslate();
  const groupId = `${useId()}-product-autonomy`;
  const policy = useAutonomyModePolicy();
  const clamped = policy.effectiveMode !== null && policy.effectiveMode !== policy.requestedMode;
  return (
    <section className={styles.root} aria-labelledby="settings-autonomy-title">
      <header className={styles.header}>
        <div>
          <h2 id="settings-autonomy-title">{t("settings.autonomy.title")}</h2>
          <p>{t("settings.autonomy.description")}</p>
        </div>
        {policy.effectiveMode === null ? null : (
          <span className={styles.status} data-mode={policy.effectiveMode}>
            {t("settings.autonomy.effective", {
              mode: modeLabel(policy.effectiveMode, t),
            })}
          </span>
        )}
      </header>
      <fieldset className={styles.fieldset} disabled={policy.pending}>
        <legend>{t("settings.autonomy.mode.legend")}</legend>
        <div className={styles.group}>
          {CODING_WORKBENCH_MODES.map((mode) => (
            <ModeOption
              key={mode}
              groupId={groupId}
              mode={mode}
              selected={policy.requestedMode === mode}
              disabled={policy.pending}
              capped={cappedByCeiling(mode, policy.deploymentCeiling)}
              onChange={policy.change}
              t={t}
            />
          ))}
        </div>
      </fieldset>
      {clamped && policy.effectiveMode !== null ? (
        <output className={styles.notice}>
          {t("settings.autonomy.clamped", {
            mode: modeLabel(policy.effectiveMode, t),
          })}
        </output>
      ) : null}
      {policy.error === null ? null : (
        <p className={styles.error} role="alert">
          {t(`settings.autonomy.error.${policy.error}`)}
        </p>
      )}
      <GitHubIssueAccessSettings />
      <p className={styles.footnote}>{t("settings.autonomy.footnote")}</p>
    </section>
  );
}
