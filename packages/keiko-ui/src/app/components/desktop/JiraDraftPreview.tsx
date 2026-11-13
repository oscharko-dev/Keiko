"use client";
import { useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import type {
  JiraDraftField,
  JiraDraftTree,
  JiraDraftTreeItem,
  JiraDraftValue,
} from "./jiraDraftTree";
import { jiraReadableText } from "./jira-readable-text";
import { JiraNamesContext, jiraNamed, jiraNameOf, restatesTarget } from "./jiraNames";
import { jiraStandardFieldLabel } from "./jira-standard-field-label";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
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

function CollapsibleText({
  text: raw,
  readable,
}: {
  readonly text: string;
  readonly readable: boolean;
}): ReactNode {
  const t = useTranslate();
  const [open, setOpen] = useState(false);
  const text = readable ? jiraReadableText(raw) : raw;
  const characters = Array.from(text);
  if (characters.length <= COLLAPSE_AT)
    return (
      <span className={styles.cmpDraftValue}>
        {text === "" ? t("chat.jira.draft.empty") : text}
      </span>
    );
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

/**
 * Only the issue's own description and a comment's body hold wiki text, matched by where they sit
 * and not by a member name at any depth: a summary, a label or a `description` inside another
 * object (a component, a link) is shown exactly as it is stored.
 */
const WIKI_TEXT_FIELDS: ReadonlySet<string> = new Set(["description", "comment", "body"]);
/** A description value is `{ format, text }`: only its `text` member is wiki text. */
const WIKI_TEXT_MEMBER: ReadonlySet<string> = new Set(["text"]);
const NO_WIKI_FIELDS: ReadonlySet<string> = new Set();

function DraftValue({
  value,
  readable = false,
  wikiMembers = NO_WIKI_FIELDS,
}: {
  readonly value: JiraDraftValue;
  /** This value is wiki text itself. */
  readonly readable?: boolean;
  /** Which members of this value, when it is a group, are wiki text. */
  readonly wikiMembers?: ReadonlySet<string>;
}): ReactNode {
  const t = useTranslate();
  switch (value.kind) {
    case "text":
      return <CollapsibleText text={value.text} readable={readable} />;
    case "cleared":
      return <span className={styles.cmpDraftNote}>{t("chat.jira.draft.cleared")}</span>;
    case "empty":
      return <span className={styles.cmpDraftNote}>{t("chat.jira.draft.empty")}</span>;
    case "group":
      return (
        <DraftFields
          fields={value.members.map((member) => ({ id: member.name, value: member.value }))}
          wikiIds={readable ? WIKI_TEXT_MEMBER : wikiMembers}
        />
      );
    case "list":
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
}

/** Named values as a definition list: a field id (or argument name) and what it is set to. */
export function DraftFields({
  fields,
  wikiIds = WIKI_TEXT_FIELDS,
}: {
  readonly fields: readonly JiraDraftField[];
  /** The ids of the fields whose text is wiki text; the top-level default names the issue's own. */
  readonly wikiIds?: ReadonlySet<string>;
}): ReactNode {
  const t = useTranslate();
  const reported = useRef(false);
  useEffect(() => {
    const localizedCount = fields.filter(
      (field) => field.label !== undefined && field.label === jiraStandardFieldLabel(field.id, t),
    ).length;
    if (!reported.current && localizedCount > 0) {
      reported.current = true;
      reportClientDiagnostic("Jira built-in field labels presented.", {
        jiraFieldPresentation: { fieldCount: fields.length, localizedCount },
      });
    }
  }, [fields, t]);
  return fields.length === 0 ? null : (
    <dl className={styles.cmpDraftFields}>
      {fields.map((field) => (
        <div key={field.id}>
          <dt>{field.label ?? field.id}</dt>
          <dd>
            <DraftValue
              value={field.value}
              readable={wikiIds.has(field.id)}
              wikiMembers={field.id === "fields" ? WIKI_TEXT_FIELDS : NO_WIKI_FIELDS}
            />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ItemFields({ item }: { readonly item: JiraDraftTreeItem }): ReactNode {
  const names = useContext(JiraNamesContext);
  const t = useTranslate();
  return (
    <DraftFields
      fields={item.fields
        .filter((field) => !restatesTarget(field, item.projectId, item.issueTypeId))
        .map((field) => jiraNamed(field, names, item, t))}
    />
  );
}

function ItemRelations({ item }: { readonly item: JiraDraftTreeItem }): ReactNode {
  const t = useTranslate();
  const names = useContext(JiraNamesContext);
  const parent = item.parentRef ?? item.parentIssueKey;
  const notes = [
    ...(item.requirementIds.length === 0
      ? [t("chat.jira.draft.requirementsMissing")]
      : [t("chat.jira.draft.requirements", { ids: item.requirementIds.join(", ") })]),
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
          projectId: jiraNameOf(names, "projects", item.projectId) ?? item.projectId,
          issueTypeId: jiraNameOf(names, "issueTypes", item.issueTypeId) ?? item.issueTypeId,
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
