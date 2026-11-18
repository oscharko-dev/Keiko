import { useId, type ReactNode } from "react";
import type {
  JiraTemplateFieldOption,
  JiraTemplateNamedOption,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  isPortableJiraTemplateText,
  jiraTemplateBoundStatusId,
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
  /** Whether a written value and an offered choice name the same thing; such a choice is not offered. Absent: only the identical value. */
  readonly equivalent?: ((written: string, choice: string) => boolean) | undefined;
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
  equivalent,
  onChange,
}: ListFieldProps): ReactNode {
  const t = useTranslate();
  const id = useId();
  const written = new Set(values);
  const choices = options.filter(
    (choice) =>
      !written.has(choice.value) &&
      (equivalent === undefined || !values.some((value) => equivalent(value, choice.value))),
  );
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
 * Each field's label: its name, with its id when the name alone does not name exactly this field by
 * the gate's rule (Jira can return several fields of one name, and the id tells which one governs
 * writes) or when another field would carry the very same final label (a field whose Jira name is
 * itself `Team (customfield_10010)`). Every field in a collision gets its id until the labels are
 * unique; a unique label keeps the plain name.
 */
function fieldLabels(fields: readonly JiraTemplateFieldOption[]): ReadonlyMap<string, string> {
  const withId = new Set<string>();
  for (const field of fields) {
    const named = resolveJiraTemplateFieldIds(field.name, fields);
    if (named.length !== 1 || named[0] !== field.id) withId.add(field.id);
  }
  const labelOf = (field: JiraTemplateFieldOption): string =>
    withId.has(field.id) ? `${field.name} (${field.id})` : field.name;
  // Each round adds the id to the plain-named holders of a shared label; ids are unique, so the
  // rounds are bounded by the number of fields.
  for (let round = 0; round <= fields.length; round += 1) {
    const grown = collidingPlainIds(fields, labelOf, withId);
    if (grown.length === 0) break;
    for (const id of grown) withId.add(id);
  }
  return new Map(fields.map((field) => [field.id, labelOf(field)]));
}

/** The ids of fields that share their final label with another field and do not show their id yet. */
function collidingPlainIds(
  fields: readonly JiraTemplateFieldOption[],
  labelOf: (field: JiraTemplateFieldOption) => string,
  withId: ReadonlySet<string>,
): readonly string[] {
  const holders = new Map<string, string[]>();
  for (const field of fields) {
    const label = labelOf(field);
    holders.set(label, [...(holders.get(label) ?? []), field.id]);
  }
  return [...holders.values()]
    .filter((ids) => ids.length > 1)
    .flat()
    .filter((id) => !withId.has(id));
}

const labelCache = new WeakMap<readonly JiraTemplateFieldOption[], ReadonlyMap<string, string>>();

function fieldLabel(
  field: JiraTemplateFieldOption,
  fields: readonly JiraTemplateFieldOption[],
): string {
  let labels = labelCache.get(fields);
  if (labels === undefined) {
    labels = fieldLabels(fields);
    labelCache.set(fields, labels);
  }
  return labels.get(field.id) ?? `${field.name} (${field.id})`;
}

/** Jira's name for the one field a written reference names, by the gate's rule; else the reference. */
function fieldName(
  fields: readonly JiraTemplateFieldOption[],
  value: string,
  template: JiraIssueTemplate | undefined,
): string {
  const ids = resolveJiraTemplateFieldIds(value, fields, template, "required");
  const only = ids.length === 1 ? fields.find((field) => field.id === ids[0]) : undefined;
  return only === undefined ? value : fieldLabel(only, fields);
}

interface UnwrittenRead {
  readonly written: readonly string[];
  readonly key: string;
  readonly result: readonly JiraTemplateFieldOption[];
}

const unwrittenCache = new WeakMap<readonly JiraTemplateFieldOption[], UnwrittenRead>();

/** What `resolveJiraTemplateFieldIds` reads of a template: its binding, typed fields and parent field. */
function resolutionKey(template: JiraIssueTemplate | undefined): string {
  return JSON.stringify([template?.binding, template?.requiredFields, template?.parent.field]);
}

/**
 * The fields no written reference already names, so one field is never offered twice. Each written
 * reference is resolved against the catalog once and the offered fields are filtered by set
 * membership; the result is reused while the catalog, the written list and the binding stay the same.
 */
function unwrittenFields(
  fields: readonly JiraTemplateFieldOption[],
  written: readonly string[],
  template: JiraIssueTemplate | undefined,
): readonly JiraTemplateFieldOption[] {
  const key = resolutionKey(template);
  const hit = unwrittenCache.get(fields);
  if (hit?.written === written && hit.key === key) return hit.result;
  const named = new Set(
    written.flatMap((value) => resolveJiraTemplateFieldIds(value, fields, template, "required")),
  );
  // A reference Jira renamed keeps the id it was bound to, so a field now carrying that written name
  // is excluded too: selecting it would store the old id twice.
  const names = new Set(written.map((value) => value.trim().toLowerCase()));
  const result = fields.filter(
    (field) => !named.has(field.id) && !names.has(field.name.trim().toLowerCase()),
  );
  unwrittenCache.set(fields, { written, key, result });
  return result;
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
  let references = referenceCache.get(fields);
  if (references === undefined) {
    references = new Map(fields.map((entry) => [entry.id, computeReference(entry, fields)]));
    referenceCache.set(fields, references);
  }
  return references.has(field.id) ? references.get(field.id) : computeReference(field, fields);
}

const referenceCache = new WeakMap<
  readonly JiraTemplateFieldOption[],
  ReadonlyMap<string, string | undefined>
>();

function computeReference(
  field: JiraTemplateFieldOption,
  fields: readonly JiraTemplateFieldOption[],
): string | undefined {
  const named = resolveJiraTemplateFieldIds(field.name, fields);
  const fits = field.name.trim() === field.name && isPortableJiraTemplateText(field.name);
  return named.length === 1 && named[0] === field.id && fits && !instanceLocalId(field.name)
    ? field.name
    : undefined;
}

/** An id form Jira assigns per instance: as a name it would name another field on another Jira. */
function instanceLocalId(name: string): boolean {
  return /^customfield_\d+$/iu.test(name.trim());
}

/**
 * What the instance's full field catalog says about the offered names: the names it cannot resolve
 * to one field, or undefined while it was unreadable. An unbound template is bound later against
 * that catalog, so only a name proved unique there may be picked into it.
 */
interface CatalogUniqueness {
  readonly ambiguous: ReadonlySet<string> | undefined;
  readonly unbound: boolean;
  /** The catalog was unreadable and the template needs it: the details are partial. */
  readonly missing: boolean;
}

function catalogUniqueness(
  details: JiraOptionsRead,
  template: JiraIssueTemplate | undefined,
): CatalogUniqueness {
  const names =
    details.state === "ready" && details.options.kind === "details"
      ? details.options.ambiguousFieldNames
      : undefined;
  const unbound = template?.binding === undefined;
  return {
    ambiguous: names === undefined ? undefined : new Set(names),
    unbound,
    missing: names === undefined && unbound,
  };
}

function fieldChoices(
  offered: readonly JiraTemplateFieldOption[],
  fields: readonly JiraTemplateFieldOption[],
  t: Translate,
  uniqueness: CatalogUniqueness,
): readonly RuleChoice[] {
  return offered.map((field) => {
    const label = fieldLabel(field, fields);
    const reference = portableReference(field, fields);
    if (reference !== undefined && uniqueness.ambiguous?.has(field.name) === true)
      return {
        value: field.id,
        label: t("chat.skills.jira.form.sharedName", { subject: label }),
        disabled: true,
      };
    if (reference !== undefined && uniqueness.ambiguous === undefined && uniqueness.unbound)
      return {
        value: field.id,
        label: t("chat.skills.jira.form.fieldCatalogUnknown", { subject: label }),
        disabled: true,
      };
    if (reference === undefined)
      return {
        value: field.id,
        label: t(
          instanceLocalId(field.name)
            ? "chat.skills.jira.form.instanceLocalName"
            : "chat.skills.jira.form.sharedName",
          { subject: label },
        ),
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

/** The one normalisation of a status name: the template parser trims it, the gate compares it folded. */
function statusKey(name: string): string {
  return name.trim().toLowerCase();
}

/** A status name a transition target can carry without being taken for a transition id. */
function portableStatusName(name: string): boolean {
  return isPortableJiraTemplateText(name) && !/^\d+$/u.test(name.trim());
}

function statusChoices(
  statuses: readonly JiraTemplateNamedOption[],
  t: Translate,
): readonly RuleChoice[] {
  const counts = new Map<string, number>();
  for (const { name } of statuses)
    counts.set(statusKey(name), (counts.get(statusKey(name)) ?? 0) + 1);
  const names = new Set(statuses.map(({ name }) => name).filter(isPortableJiraTemplateText));
  const choice = (name: string): RuleChoice => {
    const value = `transition:${name}`;
    if ((counts.get(statusKey(name)) ?? 0) > 1)
      return {
        value,
        label: t("chat.skills.jira.form.statusShared", { subject: name }),
        disabled: true,
      };
    if (!portableStatusName(name))
      return {
        value,
        label: t("chat.skills.jira.form.statusNotChoosable", { subject: name }),
        disabled: true,
      };
    return { value, label: name };
  };
  return [
    { value: "transition", label: t("chat.skills.jira.form.anyStatus") },
    ...Array.from(names, choice),
  ];
}

/** The id of each status a pick can name, by its name; a name two statuses share names none. */
function statusIdsByName(
  statuses: readonly JiraTemplateNamedOption[],
): ReadonlyMap<string, string> {
  const ids = new Map<string, string>();
  const seen = new Set<string>();
  for (const { id, name } of statuses) {
    const key = statusKey(name);
    if (seen.has(key)) ids.delete(key);
    else ids.set(key, id);
    seen.add(key);
  }
  return ids;
}

/** Two activation values name the same target: the same folded name, or the same native status id. */
function sameActivation(
  ids: ReadonlyMap<string, string>,
  template: JiraIssueTemplate | undefined,
): (written: string, choice: string) => boolean {
  const target = (value: string): string | undefined =>
    value.startsWith("transition:") ? value.slice("transition:".length).trim() : undefined;
  // A saved target keeps the id it was bound to even when Jira now names that status differently.
  const savedId = (name: string): string | undefined =>
    template === undefined
      ? undefined
      : jiraTemplateBoundStatusId(template, { kind: "transition", target: name });
  return (written, choice) => {
    const a = target(written);
    const b = target(choice);
    if (a === undefined || b === undefined) return written === choice;
    if (statusKey(a) === statusKey(b)) return true;
    const idA = savedId(a) ?? ids.get(statusKey(a));
    return idA !== undefined && idA === ids.get(statusKey(b));
  };
}

interface RuleSectionProps {
  readonly form: JiraTemplateForm;
  /** The whole template as it governs this Jira, once it reads; its binding names fields by id. */
  readonly template: JiraIssueTemplate | undefined;
  readonly details: JiraOptionsRead;
  /** `resolved` carries the ids Jira gave the references a pick adds, so a bound template keeps them. */
  readonly onChange: (patch: Partial<JiraTemplateForm>, resolved?: JiraTemplateEditedIds) => void;
}

interface RuleFieldsProps extends RuleSectionProps {
  /** The rules are bound to a Jira this editor cannot read now: guided edits would unbind them. */
  readonly locked?: boolean;
}

function ActivationField({ form, template, details, onChange }: RuleSectionProps): ReactNode {
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
        equivalent={sameActivation(statusIds.statusIds, template)}
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

function FieldRequirement({ form, template, details, onChange }: RuleSectionProps): ReactNode {
  const t = useTranslate();
  const fields =
    details.state === "ready" && details.options.kind === "details"
      ? details.options.fields
      : undefined;
  const uniqueness = catalogUniqueness(details, template);
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
        uniqueness,
      )}
      max={JIRA_ISSUE_TEMPLATE_LIMITS.listItems}
      display={(value) => fieldName(fields ?? [], value, template)}
      offered={
        fields === undefined
          ? undefined
          : (value: string): boolean =>
              resolveJiraTemplateFieldIds(value, fields, template, "required").length > 0
      }
      onChange={(requiredFields) =>
        onChange({ requiredFields }, { fieldIds: fieldIdsByReference(fields ?? []) })
      }
    />
  );
}

function DetailsStatus({
  details,
  template,
}: {
  readonly details: JiraOptionsRead;
  readonly template: JiraIssueTemplate | undefined;
}): ReactNode {
  const t = useTranslate();
  if (details.state === "loading") return <output>{t("chat.skills.jira.form.loading")}</output>;
  if (details.state === "idle") return null;
  if (
    details.state === "ready" &&
    details.options.kind === "details" &&
    details.options.fields !== undefined &&
    details.options.statuses !== undefined &&
    // An unbound template is bound against the full field catalog, so a missing catalog is partial too.
    !catalogUniqueness(details, template).missing
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

export function JiraTemplateRuleFields({ locked, ...section }: RuleFieldsProps): ReactNode {
  const t = useTranslate();
  return (
    <details className={styles.cmpRules}>
      <summary>{t("chat.skills.jira.form.rules")}</summary>
      <DetailsStatus details={section.details} template={section.template} />
      {locked === true ? <output>{t("chat.skills.jira.form.rulesLocked")}</output> : null}
      <fieldset className={styles.cmpFieldset} disabled={locked === true}>
        <div className={styles.cmpChoices}>
          <ActivationField {...section} />
          <FieldRequirement {...section} />
        </div>
      </fieldset>
    </details>
  );
}
