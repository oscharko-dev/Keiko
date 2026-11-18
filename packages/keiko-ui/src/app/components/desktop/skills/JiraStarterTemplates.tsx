"use client";

import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import {
  JIRA_ISSUE_TEMPLATE_MARKER,
  JIRA_ISSUE_TEMPLATE_VERSION,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import type { SkillWorkspace } from "./useSkillWorkspace";
import styles from "./MarkdownSkillControl.module.css";

const STARTERS = [
  { key: "epic", name: "Jira Epic", issueType: "Epic" },
  { key: "issue", name: "Jira Issue", issueType: "Task" },
  { key: "bug", name: "Jira Bug", issueType: "Bug" },
] as const;

function openDraft(
  starter: (typeof STARTERS)[number],
  body: string,
  create: SkillWorkspace["create"],
): void {
  const correlationId = newClientCorrelationId();
  const stage = "jira starter draft";
  // i18n-exempt: body-free Activity Log evidence, never rendered.
  reportClientDiagnostic("Jira starter draft requested.", {
    correlationId,
    stageReport: { stage, phase: "started", ordinal: 1 },
  });
  const draft = [
    "---",
    `keiko: ${JIRA_ISSUE_TEMPLATE_MARKER}`,
    `version: ${String(JIRA_ISSUE_TEMPLATE_VERSION)}`,
    'project: ""',
    `issueType: ${starter.issueType}`,
    "activateOn: [create]",
    "---",
    `# ${starter.name}`,
    "",
    body,
    "",
  ].join("\n");
  create(draft, `jira-${starter.key}.md`);
  // i18n-exempt: body-free Activity Log evidence, never rendered.
  reportClientDiagnostic("Jira starter draft opened.", {
    correlationId,
    stageReport: { stage, phase: "settled", ordinal: 1, durationMs: 0 },
  });
}

export function JiraStarterTemplates({
  available,
  workspace,
}: {
  readonly available: boolean;
  readonly workspace: SkillWorkspace;
}): ReactNode {
  const t = useTranslate();
  const titleId = useId();
  // A pending discard confirmation may outlive the ready Pod that opened it.
  const ready = useRef(available);
  useLayoutEffect(() => {
    ready.current = available;
  }, [available]);
  return (
    <>
      <h4 id={titleId} className={styles.cmpGroupHint}>
        {t("chat.skills.jira.starter.title")}
      </h4>
      <p className={styles.cmpGroupHint}>
        {t(available ? "chat.skills.jira.starter.edit" : "chat.skills.jira.starter.connect")}
      </p>
      <ul className={styles.cmpItems} aria-labelledby={titleId}>
        {STARTERS.map((starter) => (
          <li key={starter.key} className={styles.cmpRow}>
            <button
              type="button"
              className={styles.cmpItem}
              disabled={!available}
              onClick={() =>
                workspace.guard(() => {
                  if (ready.current) {
                    openDraft(
                      starter,
                      t(`chat.skills.jira.starter.${starter.key}`),
                      workspace.create,
                    );
                  }
                })
              }
            >
              <span className={styles.cmpItemName}>{starter.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
