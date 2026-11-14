"use client";

import type { ReactNode } from "react";
import type {
  CodingWorkbenchNativeActionReview,
  CodingWorkbenchNativeJiraNames,
  CodingWorkbenchNativeJiraWriteReview,
} from "@oscharko-dev/keiko-contracts";
import { JIRA_MANAGED_ACTION_TYPES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { useOptionalWidgetTranslate } from "@/lib/optional-widget-i18n";
import { jiraActionFacts } from "../../jiraActionFacts";
import { DraftFields } from "../../JiraDraftPreview";
import { NO_JIRA_NAMES, type JiraNames } from "../../jiraNames";
import { jiraCallLabel } from "../../jira-tool-presentation";

import type { CodingWorkbenchTranslate } from "./coding-workbench-i18n";
import type { CodingWorkbenchMessageKey } from "./coding-workbench-i18n.en";
import { cx } from "./codingWorkbenchLabels";
import styles from "./CodingWorkbenchWindow.module.css";

const PERMISSION_MESSAGE_KEYS: Readonly<Record<string, CodingWorkbenchMessageKey>> = {
  shell: "codingWorkbench.approval.native.permission.shell",
  edit: "codingWorkbench.approval.native.permission.edit",
  write: "codingWorkbench.approval.native.permission.write",
  patch: "codingWorkbench.approval.native.permission.patch",
  webfetch: "codingWorkbench.approval.native.permission.webfetch",
  websearch: "codingWorkbench.approval.native.permission.websearch",
  execute: "codingWorkbench.approval.native.permission.execute",
  opencode_worktree_create: "codingWorkbench.approval.native.permission.worktree",
  opencode_schedule: "codingWorkbench.approval.native.permission.schedule",
};

// What Approve does depends on the permission: a command runs in the task workspace, an edit
// changes the listed files, web access leaves the machine (Full access only), and a Code Mode
// program (its text is the resource) runs in OpenCode's script sandbox, and a new worktree becomes
// a managed task workspace of its own (#3903 AC4). Every other permission keeps the generic wording.
const HELP_MESSAGE_KEYS: Readonly<Record<string, CodingWorkbenchMessageKey>> = {
  shell: "codingWorkbench.approval.native.help.shell",
  edit: "codingWorkbench.approval.native.help.edit",
  write: "codingWorkbench.approval.native.help.edit",
  patch: "codingWorkbench.approval.native.help.edit",
  webfetch: "codingWorkbench.approval.native.help.internet",
  websearch: "codingWorkbench.approval.native.help.internet",
  execute: "codingWorkbench.approval.native.help.execute",
  opencode_worktree_create: "codingWorkbench.approval.native.help.worktree",
  opencode_schedule: "codingWorkbench.approval.native.help.schedule",
};

const NATIVE_LABEL_MESSAGE_KEYS: Readonly<Record<string, CodingWorkbenchMessageKey>> = {
  "native-shell": "codingWorkbench.approval.native.label.native-shell",
  "native-edit": "codingWorkbench.approval.native.label.native-edit",
  "native-egress": "codingWorkbench.approval.native.label.native-egress",
  "native-execute": "codingWorkbench.approval.native.label.native-execute",
  "native-read": "codingWorkbench.approval.native.label.native-read",
  "native-schedule": "codingWorkbench.approval.native.label.native-schedule",
};

/**
 * The catalog key a free-form name maps to, or undefined. A permission or label is text from the
 * runtime: `constructor` or `toString` must not resolve to a member inherited from Object.
 */
function ownMessageKey(
  keys: Readonly<Record<string, CodingWorkbenchMessageKey>>,
  name: string,
): CodingWorkbenchMessageKey | undefined {
  return Object.hasOwn(keys, name) ? keys[name] : undefined;
}

/** The localized name of a native permission, which titles its approval card (#3907). */
export function nativePermissionLabel(permission: string, t: CodingWorkbenchTranslate): string {
  return t(
    ownMessageKey(PERMISSION_MESSAGE_KEYS, permission) ??
      "codingWorkbench.approval.native.permission.other",
  );
}

/** The card's title: a Jira write is named as a Jira change, any other action by its permission. */
export function nativeActionTitle(
  action: CodingWorkbenchNativeActionReview,
  t: CodingWorkbenchTranslate,
): string {
  return action.jira === undefined
    ? nativePermissionLabel(action.permission, t)
    : t("codingWorkbench.approval.native.permission.jira");
}

/** The localized name of a native policy ask's closed command label, or the label itself. */
export function nativeActionLabel(label: string, t: CodingWorkbenchTranslate): string {
  const key = ownMessageKey(NATIVE_LABEL_MESSAGE_KEYS, label);
  return key === undefined ? label : t(key);
}

/**
 * Whether a native ask's review names anything to approve. A command, path or address that is
 * empty or blank leaves the human nothing to decide about, so Approve must not be offered for it.
 */
export function nativeActionNamesResource(
  action: CodingWorkbenchNativeActionReview | undefined,
): boolean {
  return action?.resources.some((resource) => resource.trim().length > 0) ?? false;
}

/**
 * The native OpenCode action a pending approval would run (#3897): the agent's own command line,
 * URL or paths, shown so the human decides about the real action. Model-selected text rendered as
 * text, never markup; it rides the authenticated review channel only. Each resource keeps its line
 * breaks, and the list scrolls inside one bounded, keyboard-focusable block so a long command or
 * up to 64 paths cannot push Approve and Deny off the card. The card's heading already names the
 * permission (`nativePermissionLabel`), so the block repeats it only for an assistive technology.
 */
export function CodingWorkbenchNativeActionReview({
  action,
  t,
}: {
  readonly action: CodingWorkbenchNativeActionReview;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  if (action.jira !== undefined) return <JiraWriteReview jira={action.jira} t={t} />;
  const help = ownMessageKey(HELP_MESSAGE_KEYS, action.permission);
  return (
    <fieldset
      className={styles.approvalResearch}
      aria-label={t("codingWorkbench.approval.native.title")}
    >
      {ownMessageKey(PERMISSION_MESSAGE_KEYS, action.permission) === undefined && (
        <p className={styles.approvalResearchDetail}>{action.permission}</p>
      )}
      {action.resources.length === 0 ? (
        <p className={styles.approvalResearchDetail}>
          {t("codingWorkbench.approval.native.noResources")}
        </p>
      ) : (
        <ul
          className={cx(styles["cmp-approval-commit-message"], styles.approvalChangedFiles)}
          aria-label={t("codingWorkbench.approval.native.resources")}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- bounded model-selected text must be keyboard-scrollable
          tabIndex={0}
        >
          {action.resources.map((resource, index) => (
            <li
              className={cx(styles.approvalChangedFile, styles["cmp-approval-native-resource"])}
              key={`${String(index)}:${resource}`}
            >
              {resource}
            </li>
          ))}
        </ul>
      )}
      <p className={styles.approvalResearchDetail}>
        {t(help ?? "codingWorkbench.approval.native.help")}
      </p>
    </fieldset>
  );
}

const WORKBENCH_NAMES_BINDING = "coding-workbench";

function namesOf(entries: CodingWorkbenchNativeJiraNames): ReadonlyMap<string, string> {
  return new Map(
    entries.map(([id, name]) => [JSON.stringify([WORKBENCH_NAMES_BINDING, id]), name]),
  );
}

function jiraNamesOf(jira: CodingWorkbenchNativeJiraWriteReview): JiraNames {
  return {
    ...NO_JIRA_NAMES,
    projects: namesOf(jira.names.projects),
    issueTypes: namesOf(jira.names.issueTypes),
    fields: namesOf(jira.names.fields),
    binding: WORKBENCH_NAMES_BINDING,
  };
}

/** The facts a person decides on first: where the issue goes and what it is called. */
const LEADING_ARGUMENTS = ["projectId", "issueTypeId", "issueKey"] as const;

function leading(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Record<string, unknown> {
  return {
    ...Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]])),
    ...value,
  };
}

/**
 * The call's arguments with the target and the summary first: the model sends them in any order,
 * and a long description must not push what the issue is called out of sight.
 */
function readableInput(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const ordered = leading(input, LEADING_ARGUMENTS);
  const { fields } = ordered;
  return typeof fields === "object" && fields !== null && !Array.isArray(fields)
    ? {
        ...ordered,
        fields: leading(fields as Readonly<Record<string, unknown>>, ["summary"]),
      }
    : ordered;
}

/**
 * A Jira write the run's Pod would make, read as the same named facts Chat's approval shows for it
 * (`jiraActionFacts`): the operation in words, the project and issue type by the names Jira gave
 * them, the summary and fields; never the tool's native name or its raw arguments (#4359).
 */
function JiraWriteReview({
  jira,
  t,
}: {
  readonly jira: CodingWorkbenchNativeJiraWriteReview;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const widget = useOptionalWidgetTranslate();
  const operation = Object.hasOwn(JIRA_MANAGED_ACTION_TYPES, jira.tool)
    ? (jira.tool as keyof typeof JIRA_MANAGED_ACTION_TYPES)
    : undefined;
  const facts = jiraActionFacts(
    readableInput(jira.input),
    true,
    widget,
    jiraNamesOf(jira),
    jira.tool,
  );
  return (
    <fieldset
      className={styles.approvalResearch}
      aria-label={t("codingWorkbench.approval.native.title")}
    >
      {operation === undefined ? null : (
        <p className={styles.approvalResearchDetail}>
          {widget(jiraCallLabel(operation, jira.input as Record<string, never>))}
        </p>
      )}
      <DraftFields fields={facts} />
      <p className={styles.approvalResearchDetail}>
        {t("codingWorkbench.approval.native.help.jira")}
      </p>
    </fieldset>
  );
}
