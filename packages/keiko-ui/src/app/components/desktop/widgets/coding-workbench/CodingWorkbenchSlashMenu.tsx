"use client";

import { useEffect, useRef, type ReactNode } from "react";

import type { CodingWorkbenchTranslate } from "./coding-workbench-i18n";
import styles from "./CodingWorkbenchPromptInputs.module.css";
import type { SlashMenu } from "./useCodingWorkbenchSlashMenu";

interface MenuViewProps {
  readonly menu: SlashMenu;
  readonly t: CodingWorkbenchTranslate;
}

function menuStatusText(menu: SlashMenu, t: CodingWorkbenchTranslate): string {
  switch (menu.status) {
    case "loading":
      return t("codingWorkbench.composer.commands.loading");
    case "found":
      return t("codingWorkbench.composer.commands.found", { count: menu.options.length });
    case "empty":
      return t("codingWorkbench.composer.commands.empty");
    case "none":
      return t("codingWorkbench.composer.commands.none");
    case "error":
      return t("codingWorkbench.composer.commands.error");
  }
}

/** The command the arrow keys are on, announced politely because focus stays in the textarea. */
function activeOptionAnnouncement(menu: SlashMenu, t: CodingWorkbenchTranslate): string {
  const option = menu.options[menu.highlighted];
  if (option === undefined) return "";
  return t("codingWorkbench.composer.commands.active", {
    name: option.name,
    position: menu.highlighted + 1,
    total: menu.options.length,
  });
}

function CommandOptions({ menu, t }: MenuViewProps): ReactNode {
  const listRef = useRef<HTMLUListElement | null>(null);
  // The active option stays visible while the arrow keys move through a long list.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-highlighted="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [menu.highlighted, menu.options]);
  return (
    <ul
      className={styles.cmpPickerList}
      id={menu.listId}
      ref={listRef}
      aria-label={t("codingWorkbench.composer.commands.results")}
    >
      {menu.options.map((option, index) => (
        <li key={option.name}>
          <button
            type="button"
            id={menu.optionId(index)}
            tabIndex={-1}
            className={`${styles.cmpOption} ${styles.cmpCommandOption}`}
            data-highlighted={index === menu.highlighted ? "true" : "false"}
            aria-label={t("codingWorkbench.composer.commands.option", { name: option.name })}
            // Keep the caret in the textarea: a pointer press must not move focus to the option.
            onMouseDown={(event): void => event.preventDefault()}
            onClick={(): void => menu.pick(option)}
          >
            <span className={styles.cmpOptionText} aria-hidden="true">
              <span className={styles.cmpOptionName}>{`/${option.name}`}</span>
              {option.description.length === 0 ? null : (
                <span className={styles.cmpOptionDescription}>{option.description}</span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The `/` menu of the composer: the slash commands matching what follows the slash. Like the `@`
 * picker it is a list the textarea drives (arrow keys, Enter or Tab, Escape), not a dialog, so a
 * pointer press on an option never takes focus away from the draft. A failed listing says so and
 * offers one retry; it never passes for a run that has no commands.
 */
export function SlashCommandPopover({ menu, t }: MenuViewProps): ReactNode {
  if (!menu.open) return null;
  return (
    <fieldset
      className={styles.cmpPicker}
      aria-label={t("codingWorkbench.composer.commands.title")}
    >
      <output
        className={styles.cmpPickerStatus}
        data-state={menu.status === "error" ? "error" : "info"}
      >
        {menuStatusText(menu, t)}
      </output>
      {menu.status === "error" ? (
        <button
          type="button"
          className={styles.cmpPickerAction}
          // Keep the caret in the textarea: a pointer press must not move focus to the button.
          onMouseDown={(event): void => event.preventDefault()}
          onClick={menu.retry}
        >
          {t("codingWorkbench.composer.commands.retry")}
        </button>
      ) : null}
      {menu.status === "found" ? <CommandOptions menu={menu} t={t} /> : null}
      <output className="sr-only" aria-live="polite">
        {activeOptionAnnouncement(menu, t)}
      </output>
    </fieldset>
  );
}
