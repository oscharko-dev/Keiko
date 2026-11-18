"use client";

import { useId, type ReactNode } from "react";
import type { JiraTemplateNamedOption } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  editJiraTemplateForm,
  jiraTemplateForInstance,
  jiraTemplateIssueTypeMatches,
  JIRA_ISSUE_TEMPLATE_LIMITS,
  parseJiraIssueTemplate,
  type JiraIssueTemplate,
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

function typeReference(
  type: JiraTemplateNamedOption,
  types: readonly JiraTemplateNamedOption[],
): string {
  const matches = types.filter((option) =>
    jiraTemplateIssueTypeMatches({ issueType: type.name }, option),
  );
  return matches.length === 1 && type.name.length <= JIRA_ISSUE_TEMPLATE_LIMITS.textChars
    ? type.name
    : type.id;
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
          onType(type === undefined ? "" : typeReference(type, types));
        }}
      >
        <option value="">{t("chat.skills.jira.form.chooseType")}</option>
        {types.map((type) => (
          <option key={type.id} value={type.id}>
            {typeReference(type, types) === type.name ? type.name : `${type.name} (${type.id})`}
          </option>
        ))}
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
  const template = governingTemplate(markdown, types?.instanceId);
  const selected = matchingType(choices, form.issueType, template);
  const details = useJiraTemplateOptions(
    selected === undefined ? undefined : podId,
    project,
    selected?.id,
  );
  return { project, projects, typesRead, choices, template, selected, details };
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

export function JiraTemplateMetadata(props: MetadataProps): ReactNode {
  const t = useTranslate();
  const id = useId();
  const { podId, form } = props;
  const { project, projects, typesRead, choices, template, selected, details } = useMetadataReads(
    podId,
    form,
    props.markdown,
  );
  const edit = (patch: Partial<JiraTemplateForm>): void =>
    props.onChange(editJiraTemplateForm(props.value, patch));
  const editRules = (patch: Partial<JiraTemplateForm>): void => {
    // Rebinding after a rule change must use a name this Pod can resolve.
    const viewedType = selected === undefined ? form.issueType : typeReference(selected, choices);
    edit(viewedType === form.issueType ? patch : { ...patch, issueType: viewedType });
  };
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
          onChange={editRules}
        />
      </fieldset>
    </section>
  );
}
