"use client";

import { type ReactNode } from "react";

import { CODING_WORKBENCH_PROMPT_REFERENCES_MAX } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import { Icons } from "../../Icons";
import { FileIcon } from "../shared/projectTree";
import type { CodingWorkbenchTranslate } from "./coding-workbench-i18n";
import { useActiveOptionInView } from "./CodingWorkbenchComposerMenu";
import styles from "./CodingWorkbenchPromptInputs.module.css";
import type { FileReferenceOption } from "./codingWorkbenchPromptReferences";
import {
  isAgentOption,
  type FileReferencePicker,
  type ReferenceOption,
} from "./useCodingWorkbenchFileReferences";

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

/** The entries in list order: the subagents first, then the files while files can be added. */
function listedOptions(picker: FileReferencePicker): readonly ReferenceOption[] {
  return [...picker.agentOptions, ...(picker.atLimit ? [] : picker.options)];
}

/** The option the arrow keys are on, announced politely because focus stays in the textarea. */
function activeOptionAnnouncement(
  picker: FileReferencePicker,
  t: CodingWorkbenchTranslate,
): string {
  const listed = listedOptions(picker);
  const option = listed[picker.highlighted];
  if (option === undefined) return "";
  return t("codingWorkbench.composer.references.picker.active", {
    name: isAgentOption(option) ? `@${option.agent}` : option.path,
    position: picker.highlighted + 1,
    total: listed.length,
  });
}

function AgentOptionRow({
  picker,
  option,
  index,
  t,
}: PickerViewProps & {
  readonly option: Extract<ReferenceOption, { readonly agent: string }>;
  readonly index: number;
}): ReactNode {
  return (
    <li>
      <button
        type="button"
        id={picker.optionId(index)}
        tabIndex={-1}
        className={styles.cmpOption}
        data-highlighted={index === picker.highlighted ? "true" : "false"}
        aria-label={t("codingWorkbench.composer.references.picker.agent", { name: option.agent })}
        // Keep the caret in the textarea: a pointer press must not move focus to the option.
        onMouseDown={(event): void => event.preventDefault()}
        onClick={(): void => picker.pick(option)}
      >
        <span className={styles.cmpOptionIcon} aria-hidden="true">
          @
        </span>
        <span className={styles.cmpOptionText} aria-hidden="true">
          <span className={styles.cmpOptionName}>{option.agent}</span>
          <span className={styles.cmpOptionDirectory}>
            {option.description ?? t("codingWorkbench.composer.references.picker.agentKind")}
          </span>
        </span>
      </button>
    </li>
  );
}

function FileOptionRow({
  picker,
  option,
  index,
  t,
}: PickerViewProps & { readonly option: FileReferenceOption; readonly index: number }): ReactNode {
  return (
    <li>
      <button
        type="button"
        id={picker.optionId(index)}
        tabIndex={-1}
        className={styles.cmpOption}
        data-highlighted={index === picker.highlighted ? "true" : "false"}
        aria-label={t("codingWorkbench.composer.references.picker.option", {
          path: option.path,
        })}
        // Keep the caret in the textarea: a pointer press must not move focus to the option.
        onMouseDown={(event): void => event.preventDefault()}
        onClick={(): void => picker.pick(option)}
      >
        <span className={styles.cmpOptionIcon} aria-hidden="true">
          <FileIcon name={option.name} />
        </span>
        <span className={styles.cmpOptionText} aria-hidden="true">
          <span className={styles.cmpOptionName}>{option.name}</span>
          {option.directory.length === 0 ? null : (
            <span className={styles.cmpOptionDirectory}>{option.directory}</span>
          )}
        </span>
      </button>
    </li>
  );
}

function PickerOptions({ picker, t }: PickerViewProps): ReactNode {
  const listRef = useActiveOptionInView(picker.highlighted, picker.options);
  return (
    <ul
      className={styles.cmpPickerList}
      id={picker.listId}
      ref={listRef}
      aria-label={t("codingWorkbench.composer.references.picker.results")}
    >
      {picker.agentOptions.map((option, index) => (
        <AgentOptionRow
          key={`@${option.agent}`}
          picker={picker}
          option={option}
          index={index}
          t={t}
        />
      ))}
      {(picker.atLimit ? [] : picker.options).map((option, fileIndex) => (
        <FileOptionRow
          key={option.path}
          picker={picker}
          option={option}
          index={picker.agentOptions.length + fileIndex}
          t={t}
        />
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
  const showList =
    picker.agentOptions.length > 0 ||
    (picker.status === "found" && !picker.atLimit && picker.options.length > 0);
  return (
    <fieldset
      className={styles.cmpPicker}
      aria-label={t("codingWorkbench.composer.references.picker.title")}
    >
      {picker.filesOffered ? (
        <output
          className={styles.cmpPickerStatus}
          data-state={picker.status === "error" ? "error" : "info"}
        >
          {pickerStatus(picker, t)}
        </output>
      ) : null}
      {showList ? <PickerOptions picker={picker} t={t} /> : null}
      <output className="sr-only" aria-live="polite">
        {activeOptionAnnouncement(picker, t)}
      </output>
    </fieldset>
  );
}

/** The files the message references, each removable; removing one removes its `@path` token. */
export function FileReferenceChips({ picker, t }: PickerViewProps): ReactNode {
  if (picker.references.length === 0) return null;
  return (
    <ul className={styles.cmpChips} aria-label={t("codingWorkbench.composer.references.label")}>
      {picker.references.map((reference) => (
        <li key={reference.path} className={styles.cmpChip}>
          <FileIcon name={reference.path} />
          <span className={styles.cmpChipPath} title={reference.path}>
            {reference.path}
          </span>
          <button
            type="button"
            className={styles.cmpChipRemove}
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
