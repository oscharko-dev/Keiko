"use client";
import { useState, type ReactNode } from "react";
import type {
  JiraReportExportFormat,
  JiraReportIncompleteReason,
  JiraReportFailureReason,
  JiraReportEstimateUnavailableReason,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { useLocale } from "@/lib/i18n";
import {
  useOptionalWidgetTranslate as useTranslate,
  type WidgetMessageKey,
} from "@/lib/optional-widget-i18n";
import { saveTextDownload } from "@/lib/browser-download";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";
import { exportJiraReport } from "@/lib/jira-report-api";
import type { JiraReportView } from "./jira-report-view";
import styles from "./JiraChatTools.module.css";

const REASON_KEYS: Readonly<Record<JiraReportIncompleteReason, WidgetMessageKey>> = {
  "read-failed": "chat.jira.report.reason.read-failed",
  "scope-changed": "chat.jira.report.reason.scope-changed",
  "memory-budget": "chat.jira.report.reason.memory-budget",
  "issue-too-large": "chat.jira.report.reason.issue-too-large",
  "template-unreadable": "chat.jira.report.reason.template-unreadable",
};
const LOCAL_FAILURE_KEYS: Partial<Readonly<Record<JiraReportFailureReason, WidgetMessageKey>>> = {
  "effect-denied": "chat.jira.outcome.failure.localAuthority",
  cancelled: "chat.jira.outcome.failure.cancelled",
  "auth-unverified": "chat.jira.outcome.failure.authUnverified",
};
const ESTIMATE_REASON_KEYS: Readonly<
  Record<JiraReportEstimateUnavailableReason, WidgetMessageKey>
> = {
  "project-not-specified": "chat.jira.report.estimateReason.project-not-specified",
  "field-not-found": "chat.jira.report.estimateReason.field-not-found",
  "ambiguous-field": "chat.jira.report.estimateReason.ambiguous-field",
  "metadata-unavailable": "chat.jira.report.estimateReason.metadata-unavailable",
};

function EstimateField({
  estimate,
}: {
  readonly estimate: NonNullable<JiraReportView["estimate"]>;
}): ReactNode {
  const t = useTranslate();
  return (
    <p>
      {estimate.available
        ? t("chat.jira.report.estimateField", { name: estimate.fieldName })
        : t("chat.jira.report.estimateUnavailable", {
            reason: t(ESTIMATE_REASON_KEYS[estimate.reason]),
          })}
    </p>
  );
}
const EXPORTS: readonly {
  readonly format: JiraReportExportFormat;
  readonly label: WidgetMessageKey;
}[] = [
  { format: "markdown", label: "chat.jira.report.exportMarkdown" },
  { format: "csv", label: "chat.jira.report.exportCsv" },
];

function ReportStatus({ view }: { readonly view: JiraReportView }): ReactNode {
  const t = useTranslate();
  const total = view.issuesTotal;
  if (view.status === "reading")
    return (
      <output aria-live="polite">
        {total === undefined
          ? t("chat.jira.report.readingUnknown", { read: view.issuesRead })
          : t("chat.jira.report.reading", { read: view.issuesRead, total })}
      </output>
    );
  if (view.status === "complete")
    return <output>{t("chat.jira.report.complete", { read: view.issuesRead })}</output>;
  return (
    <output>
      {t(
        total === undefined ? "chat.jira.report.incompleteUnknown" : "chat.jira.report.incomplete",
        {
          reason: t(
            view.reason === undefined
              ? "chat.jira.report.reason.read-failed"
              : REASON_KEYS[view.reason],
          ),
          read: view.issuesRead,
          ...(total === undefined ? {} : { total }),
        },
      )}
    </output>
  );
}

/** A percentage in the number format of the person's language: German writes 20,4, not 20.4. */
function percentText(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
}

/** The issue types a template does not cover: the first few by name, then that there are more. */
const TYPES_SHOWN = 5;
function typesText(types: readonly string[]): string {
  const shown = types.slice(0, TYPES_SHOWN).join(", ");
  return types.length > TYPES_SHOWN ? `${shown} …` : shown;
}

type CardFigures = NonNullable<JiraReportView["figures"]>;

/**
 * What the compliance check covered (#4356). Issues no template governs were not checked against
 * one: a deviation count of 0 beside them would read as a clean result, so it is shown only when
 * there is a deviation or nothing is uncovered. The required-field rules, which judged those issues,
 * keep their own plain line.
 */
function Compliance({ figures }: { readonly figures: CardFigures }): ReactNode {
  const t = useTranslate();
  const uncovered = figures.issuesWithoutTemplate;
  const types = typesText(figures.typesWithoutTemplate);
  const showDeviations = uncovered === 0 || figures.deviationCount > 0;
  return (
    <>
      {uncovered === 0 ? null : (
        <p>
          {uncovered >= figures.total
            ? t("chat.jira.report.templateNone", { types })
            : t("chat.jira.report.templatePartial", {
                checked: figures.issuesChecked,
                total: figures.total,
                without: uncovered,
                types,
              })}
        </p>
      )}
      {showDeviations ? (
        <p>
          {t("chat.jira.report.compliance", {
            issues: figures.issuesWithDeviations,
            checked: figures.issuesJudged,
            count: figures.deviationCount,
          })}
        </p>
      ) : null}
      {!showDeviations && figures.requiredFieldRules === "applied" ? (
        <p>{t("chat.jira.report.requiredFieldsClean", { judged: figures.issuesJudged })}</p>
      ) : null}
    </>
  );
}

function Figures({
  figures,
}: {
  readonly figures: NonNullable<JiraReportView["figures"]>;
}): ReactNode {
  const t = useTranslate();
  const locale = useLocale();
  return (
    <>
      <dl className={styles.cmpFigures}>
        {(
          [
            ["chat.jira.report.issues", figures.total],
            ["chat.jira.report.todo", figures.new],
            ["chat.jira.report.inProgress", figures.indeterminate],
            ["chat.jira.report.done", figures.done],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <dt>{t(label)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p>
        {t("chat.jira.report.donePercent", { percent: percentText(figures.donePercent, locale) })}
      </p>
      <Compliance figures={figures} />
      <p>
        {figures.containerRoles === "unobserved"
          ? t("chat.jira.report.coverageUnobserved", { orphans: figures.orphans })
          : t("chat.jira.report.coverage", {
              epics: figures.uncoveredEpics,
              orphans: figures.orphans,
            })}
      </p>
      {figures.inferredParentFields > 0 ? <p>{t("chat.jira.report.parentUnverified")}</p> : null}
    </>
  );
}

function ExportActions({
  reportId,
  chatId,
}: {
  readonly reportId: string;
  readonly chatId: string;
}): ReactNode {
  const t = useTranslate();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const run = async (format: JiraReportExportFormat): Promise<void> => {
    setBusy(true);
    setFailed(false);
    try {
      saveTextDownload(await exportJiraReport(reportId, chatId, format));
    } catch (cause) {
      reportClientDiagnostic(`[keiko] jira report export failed: ${clientErrorSummary(cause)}`, {
        correlationId: correlationIdOf(cause),
      });
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className={styles.cmpActions}>
        {EXPORTS.map(({ format, label }) => (
          <button
            key={format}
            type="button"
            className="lk-btn"
            disabled={busy}
            onClick={() => {
              void run(format);
            }}
          >
            {t(label)}
          </button>
        ))}
      </div>
      {failed ? <p role="alert">{t("chat.jira.report.exportFailed")}</p> : null}
    </>
  );
}

/** The figures shown are the tool result's own; the model's wording cannot change them. */
export function JiraReportCard({
  view,
  chatId,
}: {
  readonly view: JiraReportView;
  readonly chatId: string | undefined;
}): ReactNode {
  const t = useTranslate();
  const localFailure = view.failure === undefined ? undefined : LOCAL_FAILURE_KEYS[view.failure];
  return (
    <>
      <ReportStatus view={view} />
      {localFailure === undefined || view.status !== "incomplete" ? null : <p>{t(localFailure)}</p>}
      {view.figures === undefined ? null : <Figures figures={view.figures} />}
      {view.estimate === undefined ? null : <EstimateField estimate={view.estimate} />}
      {view.figures === undefined ? null : <p>{t("chat.jira.report.figures")}</p>}
      {view.status === "reading" || chatId === undefined ? null : (
        <ExportActions reportId={view.reportId} chatId={chatId} />
      )}
    </>
  );
}
