import { useId, type ReactNode } from "react";
import type {
  JiraTemplateFieldOption,
  JiraTemplateNamedOption,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  JIRA_ISSUE_TEMPLATE_LIMITS,
  resolveJiraTemplateFieldIds,
  type JiraIssueTemplate,
  type JiraTemplateEditedIds,
  type JiraTemplateForm,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import type { JiraOptionsRead } from "./useJiraTemplateOptions";
import styles from "./JiraTemplateMetadata.module.css";

interface RuleChoice {
  readonly value: string;
  readonly label: string;
  /** Shown with its reason in the label, but not selectable: the guided form cannot write it safely. */
  readonly disabled?: boolean;
}

interface ListFieldProps {
  readonly label: string;
  readonly help: string;
  readonly values: readonly string[];
  readonly options: readonly RuleChoice[];
  readonly max: number;
  readonly display: (value: string) => string;
  /** Whether Jira offers what a written value names; a value it does not offer is marked. */
  readonly offered?: ((value: string) => boolean) | undefined;
  readonly onChange: (values: readonly string[]) => void;
}

function ListField({
  label,
  help,
  values,
  options,
  max,
  display,
  offered,
  onChange,
}: ListFieldProps): ReactNode {
  const t = useTranslate();
  const id = useId();
  const choices = options.filter((choice) => !values.includes(choice.value));
  return (
    <div className={styles.cmpField}>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        aria-describedby={`${id}-help`}
        value=""
        disabled={choices.length === 0 || values.length >= max}
        onChange={(event) => {
          const value = event.target.value;
          // A choice the form cannot write safely is shown, never taken.
          const blocked = options.find((choice) => choice.value === value)?.disabled === true;
          if (value !== "" && !blocked) onChange([...values, value]);
        }}
      >
        <option value="">{t("chat.skills.jira.form.choose")}</option>
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value} disabled={choice.disabled === true}>
            {choice.label}
          </option>
        ))}
      </select>
      <span className={styles.cmpHelp} id={`${id}-help`}>
        {help}
      </span>
      <RuleValues values={values} display={display} offered={offered} onChange={onChange} />
    </div>
  );
}

function RuleValues({
  values,
  display,
  offered,
  onChange,
}: Pick<ListFieldProps, "values" | "display" | "offered" | "onChange">): ReactNode {
  const t = useTranslate();
  if (values.length === 0) return null;
  return (
    <ul className={styles.cmpRuleValues}>
      {values.map((value, index) => (
        <li
          key={`${value}:${String(index)}`}
          data-offered={offered === undefined ? undefined : String(offered(value))}
        >
          <span>
            {offered === undefined || offered(value)
              ? display(value)
              : t("chat.skills.jira.form.notOffered", { subject: display(value) })}
          </span>
          <button
            type="button"
            aria-label={t("chat.skills.jira.form.remove", { subject: display(value) })}
            onClick={() => onChange(values.filter((_, offset) => offset !== index))}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

function appliesToWrites(value: string): boolean {
  return value === "create" || value === "edit";
}

type Translate = ReturnType<typeof useTranslate>;

/**
 * A field's name, with its id when the name alone does not name exactly this field by the gate's
 * rule: Jira can return several fields of one name, and the id tells which one governs writes.
 */
function fieldLabel(
  field: JiraTemplateFieldOption,
  fields: readonly JiraTemplateFieldOption[],
): string {
  const named = resolveJiraTemplateFieldIds(field.name, fields);
  return named.length === 1 && named[0] === field.id ? field.name : `${field.name} (${field.id})`;
}

/** Jira's name for the one field a written reference names, by the gate's rule; else the reference. */
function fieldName(
  fields: readonly JiraTemplateFieldOption[],
  value: string,
  template: JiraIssueTemplate | undefined,
): string {
  const ids = resolveJiraTemplateFieldIds(value, fields, template);
  const only = ids.length === 1 ? fields.find((field) => field.id === ids[0]) : undefined;
  return only === undefined ? value : fieldLabel(only, fields);
}

/** The fields no written reference already names, so one field is never offered twice. */
function unwrittenFields(
  fields: readonly JiraTemplateFieldOption[],
  written: readonly string[],
  template: JiraIssueTemplate | undefined,
): readonly JiraTemplateFieldOption[] {
  const named = new Set(
    written.flatMap((value) => resolveJiraTemplateFieldIds(value, fields, template)),
  );
  return fields.filter((field) => !named.has(field.id));
}

/**
 * The text a guided pick writes for a field: its name, which is portable across Jira instances, and
 * only when that name names exactly this field by the gate's rule and fits the template grammar. A
 * name several fields share, or a bare instance-local id, is never written by a pick: it would name a
 * different field on another Jira, so the author writes such an id explicitly (UyB).
 */
function portableReference(
  field: JiraTemplateFieldOption,
  fields: readonly JiraTemplateFieldOption[],
): string | undefined {
  const named = resolveJiraTemplateFieldIds(field.name, fields);
  const fits = field.name.trim() === field.name && portableText(field.name);
  return named.length === 1 && named[0] === field.id && fits ? field.name : undefined;
}

function portableText(text: string): boolean {
  return (
    text.length > 0 && text.length <= JIRA_ISSUE_TEMPLATE_LIMITS.textChars && !/\p{Cc}/u.test(text)
  );
}

function fieldChoices(
  offered: readonly JiraTemplateFieldOption[],
  fields: readonly JiraTemplateFieldOption[],
  t: Translate,
): readonly RuleChoice[] {
  return offered.map((field) => {
    const label = fieldLabel(field, fields);
    const reference = portableReference(field, fields);
    if (reference === undefined)
      return {
        value: field.id,
        label: t("chat.skills.jira.form.sharedName", { subject: label }),
        disabled: true,
      };
    return {
      value: reference,
      label: field.required ? t("chat.skills.jira.form.requiredByJira", { subject: label }) : label,
    };
  });
}

/** The id Jira gave each field a pick can write, by the reference the pick writes. */
function fieldIdsByReference(
  fields: readonly JiraTemplateFieldOption[],
): ReadonlyMap<string, string> {
  const ids = new Map<string, string>();
  for (const field of fields) {
    const reference = portableReference(field, fields);
    if (reference !== undefined) ids.set(reference, field.id);
  }
  return ids;
}

/** A status name a transition target can carry without being taken for a transition id. */
function portableStatusName(name: string): boolean {
  return portableText(name) && !/^\d+$/u.test(name);
}

function statusChoices(
  statuses: readonly JiraTemplateNamedOption[],
  t: Translate,
): readonly RuleChoice[] {
  const names = new Set(statuses.map(({ name }) => name).filter(portableText));
  return [
    { value: "transition", label: t("chat.skills.jira.form.anyStatus") },
    ...Array.from(names, (name) =>
      portableStatusName(name)
        ? { value: `transition:${name}`, label: name }
        : {
            value: `transition:${name}`,
            label: t("chat.skills.jira.form.statusNotChoosable", { subject: name }),
            disabled: true,
          },
    ),
  ];
}

/** The id of each status a pick can name, by its name; a name two statuses share names none. */
function statusIdsByName(
  statuses: readonly JiraTemplateNamedOption[],
): ReadonlyMap<string, string> {
  const ids = new Map<string, string>();
  const seen = new Set<string>();
  for (const { id, name } of statuses) {
    const key = name.trim().toLowerCase();
    if (seen.has(key)) ids.delete(key);
    else ids.set(key, id);
    seen.add(key);
  }
  return ids;
}

interface RuleFieldsProps {
  readonly form: JiraTemplateForm;
  /** The whole template as it governs this Jira, once it reads; its binding names fields by id. */
  readonly template: JiraIssueTemplate | undefined;
  readonly details: JiraOptionsRead;
  /** `resolved` carries the ids Jira gave the references a pick adds, so a bound template keeps them. */
  readonly onChange: (patch: Partial<JiraTemplateForm>, resolved?: JiraTemplateEditedIds) => void;
}

function ActivationField({
  form,
  details,
  onChange,
}: Omit<RuleFieldsProps, "template">): ReactNode {
  const t = useTranslate();
  const writes = form.activateOn.filter(appliesToWrites);
  const transitions = form.activateOn.filter((value) => !appliesToWrites(value));
  const metadata =
    details.state === "ready" && details.options.kind === "details" ? details.options : undefined;
  const statusIds = { statusIds: statusIdsByName(metadata?.statuses ?? []) };
  // Adding the write activation to a full list would exceed the limit; removing it stays possible.
  const full = writes.length === 0 && transitions.length >= JIRA_ISSUE_TEMPLATE_LIMITS.activations;
  return (
    <div className={styles.cmpField}>
      <label className={styles.cmpCheckbox}>
        <input
          type="checkbox"
          checked={writes.length > 0}
          disabled={full}
          onChange={(event) =>
            onChange(
              { activateOn: event.target.checked ? ["create", ...transitions] : transitions },
              statusIds,
            )
          }
        />
        {t("chat.skills.jira.form.onWrite")}
      </label>
      {form.activateOn.length === 0 ? (
        <output className={styles.cmpHelp}>{t("chat.skills.jira.form.activationRequired")}</output>
      ) : null}
      <ListField
        label={t("chat.skills.jira.form.addStatus")}
        help={t("chat.skills.jira.form.statusHelp")}
        values={transitions}
        options={statusChoices(metadata?.statuses ?? [], t)}
        max={JIRA_ISSUE_TEMPLATE_LIMITS.activations - writes.length}
        display={(value) =>
          value === "transition"
            ? t("chat.skills.jira.form.anyStatus")
            : value.replace(/^transition:/u, "")
        }
        onChange={(values) => onChange({ activateOn: [...writes, ...values] }, statusIds)}
      />
    </div>
  );
}

function FieldRequirement({ form, template, details, onChange }: RuleFieldsProps): ReactNode {
  const t = useTranslate();
  const fields =
    details.state === "ready" && details.options.kind === "details"
      ? details.options.fields
      : undefined;
  const hint =
    fields === undefined
      ? "chat.skills.jira.form.selectForFields"
      : "chat.skills.jira.form.fieldsHelp";
  return (
    <ListField
      label={t("chat.skills.jira.form.addField")}
      help={t(hint)}
      values={form.requiredFields}
      options={fieldChoices(
        unwrittenFields(fields ?? [], form.requiredFields, template),
        fields ?? [],
        t,
      )}
      max={JIRA_ISSUE_TEMPLATE_LIMITS.listItems}
      display={(value) => fieldName(fields ?? [], value, template)}
      offered={
        fields === undefined
          ? undefined
          : (value: string): boolean =>
              resolveJiraTemplateFieldIds(value, fields, template).length > 0
      }
      onChange={(requiredFields) =>
        onChange({ requiredFields }, { fieldIds: fieldIdsByReference(fields ?? []) })
      }
    />
  );
}

function DetailsStatus({ details }: { readonly details: JiraOptionsRead }): ReactNode {
  const t = useTranslate();
  if (details.state === "loading") return <output>{t("chat.skills.jira.form.loading")}</output>;
  if (details.state === "idle") return null;
  if (
    details.state === "ready" &&
    details.options.kind === "details" &&
    details.options.fields !== undefined &&
    details.options.statuses !== undefined
  )
    return null;
  return (
    <div className={styles.cmpHelp}>
      <output>{t("chat.skills.jira.form.detailsUnavailable")}</output>
      <button type="button" onClick={details.retry}>
        {t("chat.skills.jira.form.retry")}
      </button>
    </div>
  );
}

export function JiraTemplateRuleFields(props: RuleFieldsProps): ReactNode {
  const t = useTranslate();
  return (
    <details className={styles.cmpRules}>
      <summary>{t("chat.skills.jira.form.rules")}</summary>
      <DetailsStatus details={props.details} />
      <div className={styles.cmpChoices}>
        <ActivationField {...props} />
        <FieldRequirement {...props} />
      </div>
    </details>
  );
}
