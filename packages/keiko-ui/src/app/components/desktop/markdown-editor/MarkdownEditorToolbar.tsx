"use client";

import type { ReactNode } from "react";
import type { Command } from "prosemirror-state";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import { Icons, type IconName } from "../Icons";
import {
  blockStyle,
  blockStyleCommand,
  codeBlockCommand,
  historyAvailable,
  markActive,
  redoCommand,
  toggleMarkCommand,
  toggleWrapCommand,
  undoCommand,
  wrapActive,
  type MarkdownBlockStyle,
  type MarkdownMarkFormat,
  type MarkdownWrapFormat,
} from "./markdown-editor-commands";
import type { MarkdownDocumentController } from "./markdown-document-controller";
import styles from "./MarkdownEditor.module.css";

export type MarkdownView = "rich" | "source" | "split";

type Translate = ReturnType<typeof useTranslate>;

function ToolButton({
  icon,
  label,
  pressed,
  disabled,
  onRun,
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly onRun: () => void;
}): ReactNode {
  const Icon = Icons[icon];
  return (
    <button
      type="button"
      className={styles.mdeTool}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      // Keep the editor's selection: the command applies to what the person selected.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onRun}
    >
      <Icon size={17} />
    </button>
  );
}

const MARKS = [
  { mark: "strong", icon: "bold", label: "markdownEditor.mark.strong" },
  { mark: "em", icon: "italic", label: "markdownEditor.mark.em" },
  { mark: "code", icon: "code", label: "markdownEditor.mark.code" },
] as const satisfies readonly {
  readonly mark: MarkdownMarkFormat;
  readonly icon: IconName;
  readonly label: string;
}[];
const WRAPS = [
  { wrap: "bullet_list", icon: "listBullet", label: "markdownEditor.wrap.bullet_list" },
  { wrap: "ordered_list", icon: "listOrdered", label: "markdownEditor.wrap.ordered_list" },
  { wrap: "blockquote", icon: "quote", label: "markdownEditor.wrap.blockquote" },
] as const satisfies readonly {
  readonly wrap: MarkdownWrapFormat;
  readonly icon: IconName;
  readonly label: string;
}[];
const BLOCK_STYLES = [
  { style: "paragraph", label: "markdownEditor.block.paragraph" },
  { style: "heading-1", label: "markdownEditor.block.heading-1" },
  { style: "heading-2", label: "markdownEditor.block.heading-2" },
  { style: "heading-3", label: "markdownEditor.block.heading-3" },
] as const satisfies readonly { readonly style: MarkdownBlockStyle; readonly label: string }[];

function BlockStyleSelect({
  controller,
  t,
}: {
  readonly controller: MarkdownDocumentController;
  readonly t: Translate;
}): ReactNode {
  const style = blockStyle(controller.view.state);
  return (
    <select
      className={styles.mdeBlock}
      aria-label={t("markdownEditor.blockStyle")}
      value={style === "other" ? "" : style}
      onChange={(event) =>
        controller.run(blockStyleCommand(event.target.value as MarkdownBlockStyle))
      }
    >
      {style === "other" ? <option value="">{t("markdownEditor.block.other")}</option> : null}
      {BLOCK_STYLES.map((item) => (
        <option key={item.style} value={item.style}>
          {t(item.label)}
        </option>
      ))}
    </select>
  );
}

function HistoryButtons({
  controller,
  t,
}: {
  readonly controller: MarkdownDocumentController;
  readonly t: Translate;
}): ReactNode {
  const history = historyAvailable(controller.view.state);
  return (
    <>
      <ToolButton
        icon="undo"
        label={t("markdownEditor.undo")}
        disabled={!history.undo}
        onRun={() => controller.run(undoCommand)}
      />
      <ToolButton
        icon="redo"
        label={t("markdownEditor.redo")}
        disabled={!history.redo}
        onRun={() => controller.run(redoCommand)}
      />
    </>
  );
}

/** Formatting for the formatted view; every action is also a Markdown shortcut or input rule. */
export function MarkdownEditorToolbar({
  controller,
}: {
  readonly controller: MarkdownDocumentController | null;
}): ReactNode {
  const t = useTranslate();
  if (controller === null) return <span className={styles.mdeGrow} />;
  const state = controller.view.state;
  const run = (command: Command) => (): void => controller.run(command);
  return (
    <div className={styles.mdeTools} role="toolbar" aria-label={t("markdownEditor.toolbar")}>
      <BlockStyleSelect controller={controller} t={t} />
      <span className={styles.mdeDivider} />
      {MARKS.map(({ mark, icon, label }) => (
        <ToolButton
          key={mark}
          icon={icon}
          label={t(label)}
          pressed={markActive(state, mark)}
          onRun={run(toggleMarkCommand(mark))}
        />
      ))}
      <span className={styles.mdeDivider} />
      {WRAPS.map(({ wrap, icon, label }) => (
        <ToolButton
          key={wrap}
          icon={icon}
          label={t(label)}
          pressed={wrapActive(state, wrap)}
          onRun={run(toggleWrapCommand(wrap))}
        />
      ))}
      <ToolButton
        icon="codeBlock"
        label={t("markdownEditor.codeBlock")}
        onRun={run(codeBlockCommand)}
      />
      <span className={styles.mdeDivider} />
      <HistoryButtons controller={controller} t={t} />
    </div>
  );
}

const VIEWS = [
  { view: "rich", icon: "edit", label: "markdownEditor.view.rich" },
  { view: "source", icon: "code", label: "markdownEditor.view.source" },
  { view: "split", icon: "split", label: "markdownEditor.view.split" },
] as const satisfies readonly {
  readonly view: MarkdownView;
  readonly icon: IconName;
  readonly label: string;
}[];

/** The design system's view switch: one segmented control at the trailing edge of the toolbar. */
export function MarkdownViewSwitch({
  view,
  formattable,
  onView,
}: {
  readonly view: MarkdownView;
  readonly formattable: boolean;
  readonly onView: (view: MarkdownView) => void;
}): ReactNode {
  const t = useTranslate();
  return (
    <div className={styles.mdeViews} role="group" aria-label={t("markdownEditor.view")}>
      {VIEWS.map((item) => {
        const Icon = Icons[item.icon];
        return (
          <button
            key={item.view}
            type="button"
            aria-pressed={view === item.view}
            disabled={item.view === "rich" && !formattable}
            title={
              item.view === "rich" && !formattable ? t("markdownEditor.sourceOnly") : undefined
            }
            onClick={() => {
              if (view !== item.view) onView(item.view);
            }}
          >
            <Icon size={15} />
            <span>{t(item.label)}</span>
          </button>
        );
      })}
    </div>
  );
}
