"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { CODING_WORKBENCH_PROMPT_REFERENCES_MAX } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import { Icons } from "../../Icons";
import { FileIcon } from "../shared/projectTree";
import type { CodingWorkbenchTranslate } from "./coding-workbench-i18n";
import styles from "./CodingWorkbenchPromptInputs.module.css";
import type { FileReferencePicker } from "./useCodingWorkbenchFileReferences";

const CloseIcon = Icons.close;

interface PickerViewProps {
  readonly picker: FileReferencePicker;
  readonly t: CodingWorkbenchTranslate;
}

function pickerStatus(picker: FileReferencePicker, t: CodingWorkbenchTranslate): string {
  if (picker.atLimit) {
    return t("codingWorkbench.composer.references.picker.limit", {
      count: CODING_WORKBENCH_PROMPT_REFERENCES_MAX,
    });
  }
  switch (picker.status) {
    case "searching":
      return t("codingWorkbench.composer.references.picker.searching");
    case "found":
      return t("codingWorkbench.composer.references.picker.found", {
        count: picker.options.length,
      });
    case "empty":
      return t("codingWorkbench.composer.references.picker.empty");
    case "error":
      return t("codingWorkbench.composer.references.picker.error");
    case "idle":
      return t("codingWorkbench.composer.references.picker.hint");
  }
}

/** The option the arrow keys are on, announced politely because focus stays in the textarea. */
function activeOptionAnnouncement(
  picker: FileReferencePicker,
  t: CodingWorkbenchTranslate,
): string {
  const option = picker.options[picker.highlighted];
  if (picker.atLimit || option === undefined) return "";
  return t("codingWorkbench.composer.references.picker.active", {
    name: option.path,
    position: picker.highlighted + 1,
    total: picker.options.length,
  });
}

function PickerOptions({ picker, t }: PickerViewProps): ReactNode {
  const listRef = useRef<HTMLUListElement | null>(null);
  // The active option stays visible while the arrow keys move through a long list.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-highlighted="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [picker.highlighted, picker.options]);
  return (
    <ul
      className={styles.pickerList}
      id={picker.listId}
      ref={listRef}
      aria-label={t("codingWorkbench.composer.references.picker.results")}
    >
      {picker.options.map((option, index) => (
        <li key={option.path}>
          <button
            type="button"
            id={picker.optionId(index)}
            tabIndex={-1}
            className={styles.option}
            data-highlighted={index === picker.highlighted ? "true" : "false"}
            aria-label={t("codingWorkbench.composer.references.picker.option", {
              path: option.path,
            })}
            // Keep the caret in the textarea: a pointer press must not move focus to the option.
            onMouseDown={(event): void => event.preventDefault()}
            onClick={(): void => picker.pick(option)}
          >
            <span className={styles.optionIcon} aria-hidden="true">
              <FileIcon name={option.name} />
            </span>
            <span className={styles.optionText} aria-hidden="true">
              <span className={styles.optionName}>{option.name}</span>
              {option.directory.length === 0 ? null : (
                <span className={styles.optionDirectory}>{option.directory}</span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The `@` picker of the composer: the task workspace's files matching what follows the `@`. It is
 * a list the textarea drives (arrow keys, Enter or Tab, Escape), not a dialog, so a pointer press
 * on an option never takes focus away from the draft.
 */
export function FileReferencePopover({ picker, t }: PickerViewProps): ReactNode {
  if (!picker.open) return null;
  const showList = picker.status === "found" && !picker.atLimit && picker.options.length > 0;
  return (
    <div
      className={styles.picker}
      role="group"
      aria-label={t("codingWorkbench.composer.references.picker.title")}
    >
      <p
        className={styles.pickerStatus}
        role="status"
        data-state={picker.status === "error" ? "error" : "info"}
      >
        {pickerStatus(picker, t)}
      </p>
      {showList ? <PickerOptions picker={picker} t={t} /> : null}
      <p className="sr-only" role="status" aria-live="polite">
        {activeOptionAnnouncement(picker, t)}
      </p>
    </div>
  );
}

/** The files the message references, each removable; removing one removes its `@path` token. */
export function FileReferenceChips({ picker, t }: PickerViewProps): ReactNode {
  if (picker.references.length === 0) return null;
  return (
    <ul className={styles.chips} aria-label={t("codingWorkbench.composer.references.label")}>
      {picker.references.map((reference) => (
        <li key={reference.path} className={styles.chip}>
          <FileIcon name={reference.path} />
          <span className={styles.chipPath} title={reference.path}>
            {reference.path}
          </span>
          <button
            type="button"
            className={styles.chipRemove}
            aria-label={t("codingWorkbench.composer.references.remove", { path: reference.path })}
            onClick={(): void => picker.remove(reference.path)}
          >
            <CloseIcon size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}
