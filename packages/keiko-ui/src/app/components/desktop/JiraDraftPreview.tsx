"use client";
import type { ReactNode } from "react";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import type { JiraDraftTree, JiraDraftTreeItem } from "./jiraDraftTree";
import styles from "./JiraChatTools.module.css";

interface ItemProps {
  readonly item: JiraDraftTreeItem;
  readonly deselected: ReadonlySet<string>;
  readonly excluded: ReadonlySet<string>;
  readonly editable: boolean;
  readonly toggle: (ref: string) => void;
}

function ItemRelations({ item }: { readonly item: JiraDraftTreeItem }): ReactNode {
  const t = useTranslate();
  const notes = [
    ...(item.parentIssueKey === undefined
      ? []
      : [t("chat.jira.draft.parentIssue", { issueKey: item.parentIssueKey })]),
    ...item.links.map((link) =>
      t(
        link.direction === "outward" ? "chat.jira.draft.linkOutward" : "chat.jira.draft.linkInward",
        {
          type: link.type,
          target: link.target,
        },
      ),
    ),
    ...(item.otherFieldCount === 0
      ? []
      : [
          item.otherFieldCount === 1
            ? t("chat.jira.draft.moreField")
            : t("chat.jira.draft.moreFields", { count: item.otherFieldCount }),
        ]),
  ];
  return notes.length === 0 ? null : (
    <span className={styles.cmpDraftNote}>{notes.join(" · ")}</span>
  );
}

function DraftItem({ item, deselected, excluded, editable, toggle }: ItemProps): ReactNode {
  const t = useTranslate();
  const dependent = excluded.has(item.ref) && !deselected.has(item.ref);
  return (
    <li>
      <label className={styles.cmpDraftItem}>
        <input
          type="checkbox"
          checked={!excluded.has(item.ref)}
          disabled={!editable || dependent}
          onChange={() => {
            toggle(item.ref);
          }}
        />
        <span>
          <span className={styles.cmpDraftSummary}>{item.summary}</span>
          {dependent ? (
            <span className={styles.cmpDraftNote}>{t("chat.jira.draft.dependent")}</span>
          ) : null}
          <ItemRelations item={item} />
        </span>
      </label>
      {item.children.length === 0 ? null : (
        <ul className={styles.cmpDraftTree}>
          {item.children.map((child) => (
            <DraftItem
              key={child.ref}
              item={child}
              deselected={deselected}
              excluded={excluded}
              editable={editable}
              toggle={toggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** The proposed backlog as a tree; while pending, the human may leave items out (#4178). */
export function JiraDraftPreview({
  tree,
  deselected,
  excluded,
  editable,
  toggle,
}: {
  readonly tree: JiraDraftTree;
  readonly deselected: ReadonlySet<string>;
  readonly excluded: ReadonlySet<string>;
  readonly editable: boolean;
  readonly toggle: (ref: string) => void;
}): ReactNode {
  const t = useTranslate();
  const selected = tree.refs.length - excluded.size;
  return (
    <fieldset className={styles.cmpDraft}>
      <legend>{t("chat.jira.draft.legend", { selected, total: tree.refs.length })}</legend>
      <ul className={styles.cmpDraftTree}>
        {tree.roots.map((item) => (
          <DraftItem
            key={item.ref}
            item={item}
            deselected={deselected}
            excluded={excluded}
            editable={editable}
            toggle={toggle}
          />
        ))}
      </ul>
    </fieldset>
  );
}
