"use client";
import { useId, useState, type ReactNode } from "react";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import type { JiraDraftTree, JiraDraftTreeItem, JiraDraftValue } from "./jiraDraftTree";
import styles from "./JiraChatTools.module.css";

// Longer text is collapsed to this many characters until the human expands it in place.
const COLLAPSE_AT = 160;

interface ItemProps {
  readonly item: JiraDraftTreeItem;
  readonly deselected: ReadonlySet<string>;
  readonly excluded: ReadonlySet<string>;
  readonly editable: boolean;
  readonly toggle: (ref: string) => void;
}

function CollapsibleText({ text }: { readonly text: string }): ReactNode {
  const t = useTranslate();
  const [open, setOpen] = useState(false);
  const characters = Array.from(text);
  if (characters.length <= COLLAPSE_AT)
    return <span className={styles.cmpDraftValue}>{text === "" ? '""' : text}</span>;
  return (
    <>
      <span className={styles.cmpDraftValue}>
        {open ? text : `${characters.slice(0, COLLAPSE_AT).join("")}…`}
      </span>
      <button
        type="button"
        className={styles.cmpDraftMore}
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        {t(open ? "chat.jira.draft.showLess" : "chat.jira.draft.showMore")}
      </button>
    </>
  );
}

function DraftValue({ value }: { readonly value: JiraDraftValue }): ReactNode {
  if (value.kind === "text") return <CollapsibleText text={value.text} />;
  return (
    <ul className={styles.cmpDraftList}>
      {value.items.map((entry) => (
        <li key={entry.position}>
          <DraftValue value={entry.value} />
        </li>
      ))}
    </ul>
  );
}

function ItemFields({ item }: { readonly item: JiraDraftTreeItem }): ReactNode {
  return item.fields.length === 0 ? null : (
    <dl className={styles.cmpDraftFields}>
      {item.fields.map((field) => (
        <div key={field.id}>
          <dt>{field.id}</dt>
          <dd>
            <DraftValue value={field.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ItemRelations({ item }: { readonly item: JiraDraftTreeItem }): ReactNode {
  const t = useTranslate();
  const parent = item.parentRef ?? item.parentIssueKey;
  const notes = [
    ...(item.parentFieldId === undefined || parent === undefined
      ? []
      : [t("chat.jira.draft.parent", { fieldId: item.parentFieldId, target: parent })]),
    ...item.links.map((link) =>
      t(
        link.direction === "outward" ? "chat.jira.draft.linkOutward" : "chat.jira.draft.linkInward",
        {
          type: link.type,
          target: link.target,
        },
      ),
    ),
  ];
  return (
    <>
      <span className={styles.cmpDraftNote}>
        {t("chat.jira.draft.target", {
          projectId: item.projectId,
          issueTypeId: item.issueTypeId,
        })}
      </span>
      {notes.length === 0 ? null : <span className={styles.cmpDraftNote}>{notes.join(" · ")}</span>}
    </>
  );
}

function DraftItem({ item, deselected, excluded, editable, toggle }: ItemProps): ReactNode {
  const t = useTranslate();
  const checkbox = useId();
  const dependent = excluded.has(item.ref) && !deselected.has(item.ref);
  return (
    <li>
      <div className={styles.cmpDraftItem}>
        <input
          id={checkbox}
          type="checkbox"
          checked={!excluded.has(item.ref)}
          disabled={!editable || dependent}
          onChange={() => {
            toggle(item.ref);
          }}
        />
        <div className={styles.cmpDraftBody}>
          <label htmlFor={checkbox} className={styles.cmpDraftSummary}>
            {item.summary}
          </label>
          {dependent ? (
            <span className={styles.cmpDraftNote}>{t("chat.jira.draft.dependent")}</span>
          ) : null}
          <ItemRelations item={item} />
          <ItemFields item={item} />
        </div>
      </div>
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
