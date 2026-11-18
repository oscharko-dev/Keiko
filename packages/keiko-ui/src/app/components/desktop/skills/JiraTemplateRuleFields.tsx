import { useId, type ReactNode } from "react";
import type {
  JiraTemplateFieldOption,
  JiraTemplateNamedOption,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  JIRA_ISSUE_TEMPLATE_LIMITS,
  type JiraTemplateForm,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import type { JiraOptionsRead } from "./useJiraTemplateOptions";
import styles from "./JiraTemplateMetadata.module.css";

interface RuleChoice {
  readonly value: string;
  readonly label: string;
}

interface ListFieldProps {
  readonly label: string;
  readonly help: string;
  readonly values: readonly string[];
  readonly options: readonly RuleChoice[];
  readonly max: number;
  readonly display: (value: string) => string;
  readonly onChange: (values: readonly string[]) => void;
}

function ListField({
  label,
  help,
  values,
  options,
  max,
  display,
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
          if (value !== "") onChange([...values, value]);
        }}
      >
        <option value="">{t("chat.skills.jira.form.choose")}</option>
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
      <span className={styles.cmpHelp} id={`${id}-help`}>
        {help}
      </span>
      <RuleValues values={values} display={display} onChange={onChange} />
    </div>
  );
}

function RuleValues({
  values,
  display,
  onChange,
}: Pick<ListFieldProps, "values" | "display" | "onChange">): ReactNode {
  const t = useTranslate();
  if (values.length === 0) return null;
  return (
    <ul className={styles.cmpRuleValues}>
      {values.map((value, index) => (
        <li key={`${value}:${String(index)}`}>
          <span>{display(value)}</span>
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

function fieldName(fields: readonly JiraTemplateFieldOption[], value: string): string {
  return fields.find((field) => field.id === value)?.name ?? value;
}

function fieldChoices(
  fields: readonly JiraTemplateFieldOption[],
  t: Translate,
): readonly RuleChoice[] {
  return fields.map(({ id, name, required }) => ({
    value: id,
    label: required ? t("chat.skills.jira.form.requiredByJira", { subject: name }) : name,
  }));
}

function statusChoices(
  statuses: readonly JiraTemplateNamedOption[],
  t: Translate,
): readonly RuleChoice[] {
  const names = new Set(
    statuses
      .map(({ name }) => name)
      .filter(
        (name) => name.length <= JIRA_ISSUE_TEMPLATE_LIMITS.textChars && !/\p{Cc}/u.test(name),
      ),
  );
  return [
    { value: "transition", label: t("chat.skills.jira.form.anyStatus") },
    ...Array.from(names, (name) => ({ value: `transition:${name}`, label: name })),
  ];
}

interface RuleFieldsProps {
  readonly form: JiraTemplateForm;
  readonly details: JiraOptionsRead;
  readonly onChange: (patch: Partial<JiraTemplateForm>) => void;
}

function ActivationField({ form, details, onChange }: RuleFieldsProps): ReactNode {
  const t = useTranslate();
  const writes = form.activateOn.filter(appliesToWrites);
  const transitions = form.activateOn.filter((value) => !appliesToWrites(value));
  const metadata =
    details.state === "ready" && details.options.kind === "details" ? details.options : undefined;
  return (
    <div className={styles.cmpField}>
      <label className={styles.cmpCheckbox}>
        <input
          type="checkbox"
          checked={writes.length > 0}
          onChange={(event) =>
            onChange({
              activateOn: event.target.checked ? ["create", ...transitions] : transitions,
            })
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
        onChange={(values) => onChange({ activateOn: [...writes, ...values] })}
      />
    </div>
  );
}

function FieldRequirement({ form, details, onChange }: RuleFieldsProps): ReactNode {
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
      options={fieldChoices(fields ?? [], t)}
      max={JIRA_ISSUE_TEMPLATE_LIMITS.listItems}
      display={(value) => fieldName(fields ?? [], value)}
      onChange={(requiredFields) => onChange({ requiredFields })}
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
