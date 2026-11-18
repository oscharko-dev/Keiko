"use client";

import { useId, type ReactNode } from "react";
import type { JiraTemplateNamedOption } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  editJiraTemplateForm,
  jiraTemplateForInstance,
  jiraTemplateIssueTypeMatches,
  JIRA_ISSUE_TEMPLATE_LIMITS,
  parseJiraIssueTemplate,
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
}

type Translate = ReturnType<typeof useTranslate>;

function matchingType(
  options: readonly JiraTemplateNamedOption[],
  issueType: string,
  markdown: string,
  instanceId: string | undefined,
): JiraTemplateNamedOption | undefined {
  const parsed = parseJiraIssueTemplate(markdown);
  const template = parsed.ok ? jiraTemplateForInstance(parsed.template, instanceId) : { issueType };
  const matches = options.filter((option) => jiraTemplateIssueTypeMatches(template, option));
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

export function JiraTemplateMetadata(props: MetadataProps): ReactNode {
  const t = useTranslate();
  const id = useId();
  const { podId, form } = props;
  const project = form.project.trim().toUpperCase();
  const projects = useJiraTemplateOptions(podId);
  const typesRead = useJiraTemplateOptions(project === "" ? undefined : podId, project);
  const types =
    typesRead.state === "ready" && typesRead.options.kind === "types"
      ? typesRead.options
      : undefined;
  const choices = types?.issueTypes ?? [];
  const selected = matchingType(choices, form.issueType, props.markdown, types?.instanceId);
  const details = useJiraTemplateOptions(
    selected === undefined ? undefined : podId,
    project,
    selected?.id,
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
      {podId === undefined ? <output>{t("chat.skills.jira.form.connect")}</output> : null}
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
      <JiraTemplateRuleFields form={form} details={details} onChange={editRules} />
    </section>
  );
}
