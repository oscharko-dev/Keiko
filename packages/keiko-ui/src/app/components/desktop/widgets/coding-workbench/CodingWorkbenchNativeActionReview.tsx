"use client";

import type { ReactNode } from "react";
import type { CodingWorkbenchNativeActionReview } from "@oscharko-dev/keiko-contracts";

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
};

// What Approve does depends on the permission: a command runs in the task workspace, an edit
// changes the listed files, and web access leaves the machine (Full access only). Every other
// permission keeps the generic wording.
const HELP_MESSAGE_KEYS: Readonly<Record<string, CodingWorkbenchMessageKey>> = {
  shell: "codingWorkbench.approval.native.help.shell",
  edit: "codingWorkbench.approval.native.help.edit",
  write: "codingWorkbench.approval.native.help.edit",
  patch: "codingWorkbench.approval.native.help.edit",
  webfetch: "codingWorkbench.approval.native.help.internet",
  websearch: "codingWorkbench.approval.native.help.internet",
};

const NATIVE_LABEL_MESSAGE_KEYS: Readonly<Record<string, CodingWorkbenchMessageKey>> = {
  "native-shell": "codingWorkbench.approval.native.label.native-shell",
  "native-edit": "codingWorkbench.approval.native.label.native-edit",
  "native-egress": "codingWorkbench.approval.native.label.native-egress",
  "native-execute": "codingWorkbench.approval.native.label.native-execute",
  "native-read": "codingWorkbench.approval.native.label.native-read",
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
 * up to 64 paths cannot push Approve and Deny off the card.
 */
export function CodingWorkbenchNativeActionReview({
  action,
  t,
}: {
  readonly action: CodingWorkbenchNativeActionReview;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const title = t("codingWorkbench.approval.native.title");
  const permission = t(
    ownMessageKey(PERMISSION_MESSAGE_KEYS, action.permission) ??
      "codingWorkbench.approval.native.permission.other",
  );
  const help = ownMessageKey(HELP_MESSAGE_KEYS, action.permission);
  return (
    <fieldset className={styles.approvalResearch} aria-label={title}>
      <p className={styles.approvalResearchTitle}>
        {title}: {permission}
      </p>
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
