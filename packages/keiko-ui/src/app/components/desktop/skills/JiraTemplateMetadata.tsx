"use client";

import { useId, type ReactNode } from "react";
import type { JiraTemplateNamedOption } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  editJiraTemplateForm,
  isPortableJiraIssueTypeName,
  jiraTemplateForInstance,
  jiraTemplateIssueTypeMatches,
  parseJiraIssueTemplate,
  rebindJiraTemplateAfterEdit,
  type JiraIssueTemplate,
  type JiraTemplateEditedIds,
  type JiraTemplateForm,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import { JiraTemplateRuleFields } from "./JiraTemplateRuleFields";
import { useJiraTemplateOptions, type JiraOptionsRead } from "./useJiraTemplateOptions";
import styles from "./JiraTemplateMetadata.module.css";

interface MetadataProps {
  readonly value: string;
  readonly form: JiraTemplateForm;
  readonly markdown: string;
  readonly onChange: (value: string) => void;
  readonly podId: string | undefined;
  /** The text below does not read as rules right now: this is the last form that did, held still. */
  readonly stale: boolean;
}

type Translate = ReturnType<typeof useTranslate>;

/** The template as it governs this Jira, once the whole document reads; a draft has none yet. */
function governingTemplate(
  markdown: string,
  instanceId: string | undefined,
): JiraIssueTemplate | undefined {
  const parsed = parseJiraIssueTemplate(markdown);
  return parsed.ok ? jiraTemplateForInstance(parsed.template, instanceId) : undefined;
}

/**
 * A template carrying a binding the loaded Jira cannot confirm (no Jira context yet, or another
 * Jira's binding): a rule edit would leave the binding's digest and ids behind, so guided rule edits
 * wait until the binding is confirmed (YAML stays editable).
 */
function rulesLocked(markdown: string, instanceId: string | undefined): boolean {
  const parsed = parseJiraIssueTemplate(markdown);
  // A document the strict parser rejects has no binding to confirm: a guided rule edit would write
  // changed rules beside the old digest, and the binding would stop matching once the text reads again.
  if (!parsed.ok) return true;
  if (parsed.template.binding === undefined) return false;
  // The binding must be confirmed for the Jira that supplied the choices: another Jira's binding
  // would be rewritten with a digest that holds for neither instance.
  return jiraTemplateForInstance(parsed.template, instanceId).binding === undefined;
}

function documentInvalid(markdown: string): boolean {
  return !parseJiraIssueTemplate(markdown).ok;
}

function matchingType(
  options: readonly JiraTemplateNamedOption[],
  issueType: string,
  template: JiraIssueTemplate | undefined,
): JiraTemplateNamedOption | undefined {
  const matches = options.filter((option) =>
    jiraTemplateIssueTypeMatches(template ?? { issueType }, option),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The portable name a pick writes for an issue type, or undefined when the type has none: a name
 * several types answer to, one the template grammar cannot round-trip, or one that reads as a native
 * id (another Jira would match it to an unrelated type). The native id is instance-local and is
 * never written into the portable `issueType` field by a pick.
 */
function typeReference(
  type: JiraTemplateNamedOption,
  types: readonly JiraTemplateNamedOption[],
): string | undefined {
  const matches = types.filter((option) =>
    jiraTemplateIssueTypeMatches({ issueType: type.name }, option),
  );
  return matches.length === 1 && isPortableJiraIssueTypeName(type.name) ? type.name : undefined;
}

function statusMessage(read: JiraOptionsRead, hint: string, empty: boolean, t: Translate): string {
  switch (read.state) {
    case "loading":
      return t("chat.skills.jira.form.loading");
    case "missing":
      return t("chat.skills.jira.form.projectMissing");
    case "failed":
      return t("chat.skills.jira.form.readFailed");
    case "ready":
      return empty ? t("chat.skills.jira.form.empty") : hint;
    case "idle":
      return hint;
  }
}

function ChoiceHelp({
  id,
  read,
  hint,
  empty,
}: {
  readonly id: string;
  readonly read: JiraOptionsRead;
  readonly hint: string;
  readonly empty: boolean;
}): ReactNode {
  const t = useTranslate();
  return (
    <div className={styles.cmpHelp}>
      <output id={id}>{statusMessage(read, hint, empty, t)}</output>
      {read.state === "failed" || read.state === "missing" ? (
        <button type="button" onClick={read.retry}>
          {t("chat.skills.jira.form.retry")}
        </button>
      ) : null}
    </div>
  );
}

function ProjectChoice({
  project,
  read,
  onProject,
}: {
  readonly project: string;
  readonly read: JiraOptionsRead;
  readonly onProject: (key: string) => void;
}): ReactNode {
  const t = useTranslate();
  const id = useId();
  const projects =
    read.state === "ready" && read.options.kind === "projects" ? read.options.projects : [];
  const missing = project !== "" && !projects.some(({ key }) => key === project);
  return (
    <div className={styles.cmpField}>
      <label htmlFor={id}>{t("chat.skills.jira.form.project")}</label>
      <select
        id={id}
        aria-describedby={`${id}-help`}
        required
        value={project}
        disabled={projects.length === 0}
        onChange={(event) => onProject(event.target.value)}
      >
        <option value="">{t("chat.skills.jira.form.chooseProject")}</option>
        {missing ? (
          <option value={project} disabled>
            {project}
          </option>
        ) : null}
        {projects.map(({ key, name }) => (
          <option key={key} value={key}>
            {name} ({key})
          </option>
        ))}
      </select>
      <ChoiceHelp
        id={`${id}-help`}
        read={read}
        empty={projects.length === 0}
        hint={t("chat.skills.jira.form.projectHelp")}
      />
    </div>
  );
}

function TypeOptions({ types }: { readonly types: readonly JiraTemplateNamedOption[] }): ReactNode {
  const t = useTranslate();
  return types.map((type) => {
    const portable = typeReference(type, types) !== undefined;
    return (
      <option key={type.id} value={type.id} disabled={!portable}>
        {portable
          ? type.name
          : t("chat.skills.jira.form.typeNotPortable", { subject: `${type.name} (${type.id})` })}
      </option>
    );
  });
}

function IssueTypeChoice({
  read,
  types,
  selected,
  issueType,
  onType,
}: {
  readonly read: JiraOptionsRead;
  readonly types: readonly JiraTemplateNamedOption[];
  readonly selected: JiraTemplateNamedOption | undefined;
  readonly issueType: string;
  readonly onType: (value: string) => void;
}): ReactNode {
  const t = useTranslate();
  const id = useId();
  const unmatched = read.state === "ready" && selected === undefined && issueType !== "";
  return (
    <div className={styles.cmpField}>
      <label htmlFor={id}>{t("chat.skills.jira.form.issueType")}</label>
      <select
        id={id}
        aria-describedby={`${id}-help`}
        required
        value={selected?.id ?? ""}
        disabled={types.length === 0}
        onChange={(event) => {
          const type = types.find((item) => item.id === event.target.value);
          const reference = type === undefined ? "" : typeReference(type, types);
          if (reference !== undefined) onType(reference);
        }}
      >
        <option value="">{t("chat.skills.jira.form.chooseType")}</option>
        <TypeOptions types={types} />
      </select>
      <ChoiceHelp
        id={`${id}-help`}
        read={read}
        empty={types.length === 0}
        hint={t(
          unmatched ? "chat.skills.jira.form.unmatchedType" : "chat.skills.jira.form.typeHelp",
          { subject: issueType },
        )}
      />
    </div>
  );
}

interface MetadataReads {
  readonly project: string;
  readonly projects: JiraOptionsRead;
  readonly typesRead: JiraOptionsRead;
  readonly choices: readonly JiraTemplateNamedOption[];
  readonly template: JiraIssueTemplate | undefined;
  /** The identity of the Jira that supplied the choices; what a binding is confirmed against. */
  readonly instanceId: string | undefined;
  readonly selected: JiraTemplateNamedOption | undefined;
  readonly details: JiraOptionsRead;
}

/** The three Jira reads the form needs, each one asked only once the choice before it is made. */
function useMetadataReads(
  podId: string | undefined,
  form: JiraTemplateForm,
  markdown: string,
): MetadataReads {
  const project = form.project.trim().toUpperCase();
  const projects = useJiraTemplateOptions(podId);
  const typesRead = useJiraTemplateOptions(project === "" ? undefined : podId, project);
  const types =
    typesRead.state === "ready" && typesRead.options.kind === "types"
      ? typesRead.options
      : undefined;
  const choices = types?.issueTypes ?? [];
  const instanceId = types?.instanceId;
  const template = governingTemplate(markdown, instanceId);
  const selected = matchingType(choices, form.issueType, template);
  const details = useJiraTemplateOptions(
    selected === undefined ? undefined : podId,
    project,
    selected?.id,
  );
  return { project, projects, typesRead, choices, template, instanceId, selected, details };
}

function MetadataNotices({ podId, stale }: Pick<MetadataProps, "podId" | "stale">): ReactNode {
  const t = useTranslate();
  return (
    <>
      {podId === undefined ? <output>{t("chat.skills.jira.form.connect")}</output> : null}
      {stale ? (
        <output className={styles.cmpHelp}>{t("chat.skills.jira.form.invalid")}</output>
      ) : null}
    </>
  );
}

interface FormEdits {
  readonly edit: (patch: Partial<JiraTemplateForm>) => void;
  readonly editRules: (patch: Partial<JiraTemplateForm>, resolved?: JiraTemplateEditedIds) => void;
}

/** How the form writes its choices into the front matter, for the Jira the reads came from. */
function formEdits(props: MetadataProps, reads: MetadataReads): FormEdits {
  const { form } = props;
  const { template, instanceId, selected, choices } = reads;
  const edit = (patch: Partial<JiraTemplateForm>): void =>
    props.onChange(editJiraTemplateForm(props.value, patch));
  const editRules = (patch: Partial<JiraTemplateForm>, resolved?: JiraTemplateEditedIds): void => {
    if (rulesLocked(props.markdown, instanceId)) return;
    // A binding in force for this Jira keeps every untouched rule on the id it was bound to, and
    // keeps the issue type it names by id: only the references this edit adds are resolved.
    const bound =
      template === undefined
        ? undefined
        : rebindJiraTemplateAfterEdit(
            template,
            instanceId,
            {
              requiredFields: patch.requiredFields ?? form.requiredFields,
              activateOn: patch.activateOn ?? form.activateOn,
            },
            resolved,
          );
    if (bound !== undefined) {
      props.onChange(editJiraTemplateForm(props.value, patch, bound));
      return;
    }
    // Without a binding, rebinding after a rule change must use a name this Pod can resolve.
    const viewedType =
      selected === undefined
        ? form.issueType
        : (typeReference(selected, choices) ?? form.issueType);
    edit(viewedType === form.issueType ? patch : { ...patch, issueType: viewedType });
  };
  return { edit, editRules };
}

export function JiraTemplateMetadata(props: MetadataProps): ReactNode {
  const t = useTranslate();
  const id = useId();
  const { podId, form } = props;
  const reads = useMetadataReads(podId, form, props.markdown);
  const { project, projects, typesRead, choices, template, selected, details } = reads;
  const { edit, editRules } = formEdits(props, reads);
  return (
    <section className={styles.cmpForm} aria-labelledby={id}>
      <h4 id={id}>{t("chat.skills.jira.form.title")}</h4>
      <MetadataNotices podId={podId} stale={props.stale} />
      <fieldset className={styles.cmpFieldset} disabled={props.stale}>
        <div className={styles.cmpChoices}>
          <ProjectChoice
            project={project}
            read={projects}
            onProject={(key) => edit({ project: key, issueType: "" })}
          />
          <IssueTypeChoice
            read={typesRead}
            types={choices}
            selected={selected}
            issueType={form.issueType}
            onType={(issueType) => edit({ issueType })}
          />
        </div>
        <JiraTemplateRuleFields
          form={form}
          template={template}
          details={details}
          locked={rulesLocked(props.markdown, reads.instanceId)}
          invalid={documentInvalid(props.markdown)}
          onChange={editRules}
        />
      </fieldset>
    </section>
  );
}
