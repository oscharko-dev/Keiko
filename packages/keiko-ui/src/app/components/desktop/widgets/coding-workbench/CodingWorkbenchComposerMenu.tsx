"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import type { CodingWorkbenchMentionableSkill } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import type { CodingWorkbenchTranslate } from "./coding-workbench-i18n";
import type { CodingWorkbenchMessageKey } from "./coding-workbench-i18n.en";
import styles from "./CodingWorkbenchPromptInputs.module.css";
import type { ComposerMenuStatus } from "./codingWorkbenchComposerListbox";
import type { CommandOption } from "./codingWorkbenchSlashCommands";
import type { SkillMenu } from "./useCodingWorkbenchSkillMenu";
import type { SlashMenu } from "./useCodingWorkbenchSlashMenu";

/** Keeps the active option visible while the arrow keys move through a long list. */
export function useActiveOptionInView(
  highlighted: number,
  options: readonly unknown[],
): RefObject<HTMLUListElement | null> {
  const listRef = useRef<HTMLUListElement | null>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-highlighted="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [highlighted, options]);
  return listRef;
}

/** The menu state a composer pop-up list renders. */
interface ComposerMenuView<T> {
  readonly open: boolean;
  readonly status: ComposerMenuStatus;
  readonly options: readonly T[];
  readonly highlighted: number;
  readonly listId: string;
  readonly optionId: (index: number) => string;
  readonly pick: (option: T) => void;
  readonly retry: () => void;
}

/** One option as the list shows it: the token it writes and an optional description. */
interface ComposerMenuOption {
  readonly key: string;
  readonly token: string;
  readonly description: string | undefined;
  /** The option's accessible name, and the name its announcement uses. */
  readonly label: string;
  readonly announced: string;
}

/** What tells one menu from another: its messages and how it shows an option. */
interface ComposerMenuFamily<T> {
  readonly messages: Readonly<Record<ComposerMenuStatus, CodingWorkbenchMessageKey>>;
  readonly title: CodingWorkbenchMessageKey;
  readonly results: CodingWorkbenchMessageKey;
  readonly retry: CodingWorkbenchMessageKey;
  /** The active option, announced politely because focus stays in the textarea. */
  readonly active: CodingWorkbenchMessageKey;
  readonly present: (option: T, t: CodingWorkbenchTranslate) => ComposerMenuOption;
}

function familyMessages(
  family: "commands" | "skills",
): Omit<ComposerMenuFamily<never>, "active" | "present"> {
  const prefix = `codingWorkbench.composer.${family}` as const;
  return {
    messages: {
      loading: `${prefix}.loading`,
      found: `${prefix}.found`,
      empty: `${prefix}.empty`,
      none: `${prefix}.none`,
      error: `${prefix}.error`,
    },
    title: `${prefix}.title`,
    results: `${prefix}.results`,
    retry: `${prefix}.retry`,
  };
}

const COMMANDS: ComposerMenuFamily<CommandOption> = {
  ...familyMessages("commands"),
  active: "codingWorkbench.composer.commands.active",
  present: (option, t) => ({
    key: option.name,
    token: `/${option.name}`,
    description: option.description,
    label: t("codingWorkbench.composer.commands.option", { name: option.name }),
    announced: option.name,
  }),
};

const SKILLS: ComposerMenuFamily<CodingWorkbenchMentionableSkill> = {
  ...familyMessages("skills"),
  active: "codingWorkbench.composer.references.picker.active",
  present: (skill, t) => ({
    key: skill.id,
    token: `$${skill.id}`,
    description: skill.description,
    label: t("codingWorkbench.composer.skills.option", { name: skill.name }),
    announced: `$${skill.id}`,
  }),
};

interface ComposerMenuProps<T> {
  readonly menu: ComposerMenuView<T>;
  readonly t: CodingWorkbenchTranslate;
  readonly family: ComposerMenuFamily<T>;
}

function MenuOptions<T>({ menu, t, family }: ComposerMenuProps<T>): ReactNode {
  const listRef = useActiveOptionInView(menu.highlighted, menu.options);
  return (
    <ul
      className={styles.cmpPickerList}
      id={menu.listId}
      ref={listRef}
      aria-label={t(family.results)}
    >
      {menu.options.map((option, index) => {
        const shown = family.present(option, t);
        return (
          <li key={shown.key}>
            <button
              type="button"
              id={menu.optionId(index)}
              tabIndex={-1}
              className={`${styles.cmpOption} ${styles.cmpCommandOption}`}
              data-highlighted={index === menu.highlighted ? "true" : "false"}
              aria-label={shown.label}
              // Keep the caret in the textarea: a pointer press must not move focus to the option.
              onMouseDown={(event): void => event.preventDefault()}
              onClick={(): void => menu.pick(option)}
            >
              <span className={styles.cmpOptionText} aria-hidden="true">
                <span className={styles.cmpOptionName}>{shown.token}</span>
                {shown.description === undefined || shown.description.length === 0 ? null : (
                  <span className={styles.cmpOptionDescription}>{shown.description}</span>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function activeAnnouncement<T>({ menu, t, family }: ComposerMenuProps<T>): string {
  const option = menu.options[menu.highlighted];
  if (option === undefined) return "";
  return t(family.active, {
    name: family.present(option, t).announced,
    position: menu.highlighted + 1,
    total: menu.options.length,
  });
}

/**
 * A pop-up list of the composer (the `/` command and `$` skill menus). Like the `@` picker it is a
 * list the textarea drives (arrow keys, Enter or Tab, Escape), not a dialog, so a pointer press on an
 * option never takes focus away from the draft. A failed listing says so and offers one retry; it
 * never passes for a run that offers nothing.
 */
function ComposerMenuPopover<T>(props: ComposerMenuProps<T>): ReactNode {
  const { menu, t, family } = props;
  if (!menu.open) return null;
  return (
    <fieldset className={styles.cmpPicker} aria-label={t(family.title)}>
      <output
        className={styles.cmpPickerStatus}
        data-state={menu.status === "error" ? "error" : "info"}
      >
        {t(family.messages[menu.status], { count: menu.options.length })}
      </output>
      {menu.status === "error" ? (
        <button
          type="button"
          className={styles.cmpPickerAction}
          // Keep the caret in the textarea: a pointer press must not move focus to the button.
          onMouseDown={(event): void => event.preventDefault()}
          onClick={menu.retry}
        >
          {t(family.retry)}
        </button>
      ) : null}
      {menu.status === "found" ? <MenuOptions {...props} /> : null}
      <output className="sr-only" aria-live="polite">
        {activeAnnouncement(props)}
      </output>
    </fieldset>
  );
}

/** The `/` menu: the slash commands matching what follows the slash. */
export function SlashCommandPopover(props: {
  readonly menu: SlashMenu;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return <ComposerMenuPopover {...props} family={COMMANDS} />;
}

/** The `$` menu (S15, #3906): the run's skills matching what follows the `$`. */
export function SkillMentionPopover(props: {
  readonly menu: SkillMenu;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return <ComposerMenuPopover {...props} family={SKILLS} />;
}
