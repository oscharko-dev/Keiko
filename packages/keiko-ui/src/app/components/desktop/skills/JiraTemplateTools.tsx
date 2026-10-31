"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { listAtlassianConnectors } from "@/lib/atlassian-connectors-api";
import {
  fetchJiraTemplates,
  proposeJiraTemplates,
  validateJiraTemplate,
  type JiraTemplateEntry,
  type JiraTemplateFindingCode,
  type JiraTemplateProposal,
  type JiraTemplateValidation,
} from "@/lib/jira-templates-api";
import { readMarkdownSkill } from "@/lib/markdown-skills-api";
import { usePodChoices } from "../useJiraPodChoices";
import { useJiraTemplateCopy as useTranslate } from "./jira-template-copy";
import { skillTextFits } from "./useMarkdownSkillAuthor";
import type { MarkdownSkillLibrary } from "./useMarkdownSkillLibrary";
import styles from "./MarkdownSkillControl.module.css";

/**
 * Jira issue templates are skills with a Jira front matter (#4177): upload, replace, download and
 * delete are the skill library's. This section lists them and adds the two things that need Jira:
 * validating a template against the live instance and proposing one from an existing project.
 */
export function JiraTemplateTools({
  library,
}: {
  readonly library: MarkdownSkillLibrary;
}): ReactNode {
  const t = useTranslate();
  const [open, setOpen] = useState(false);
  return (
    <section className={styles.cmpAuthor}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {t("chat.skills.jira.title")}
      </button>
      {open ? <JiraTemplatePanel library={library} /> : null}
    </section>
  );
}

const FINDING_MESSAGES = {
  "unknown-project": "chat.skills.jira.finding.unknown-project",
  "unknown-issue-type": "chat.skills.jira.finding.unknown-issue-type",
  "unknown-field": "chat.skills.jira.finding.unknown-field",
  "ambiguous-field": "chat.skills.jira.finding.ambiguous-field",
  "unknown-link-type": "chat.skills.jira.finding.unknown-link-type",
  "unknown-transition-target": "chat.skills.jira.finding.unknown-transition-target",
} as const satisfies Record<JiraTemplateFindingCode, string>;

type Work = "idle" | "loading" | "validating" | "proposing";
interface Tools {
  readonly templates: readonly JiraTemplateEntry[];
  readonly work: Work;
  readonly failed: boolean;
  readonly validation:
    { readonly name: string; readonly result: JiraTemplateValidation } | undefined;
  readonly proposals: readonly JiraTemplateProposal[] | undefined;
  readonly validate: (entry: JiraTemplateEntry) => Promise<void>;
  readonly propose: (projectKey: string) => Promise<void>;
  readonly reload: () => Promise<void>;
}

function useJiraTemplateTools(podId: string | undefined, version: number): Tools {
  const [templates, setTemplates] = useState<readonly JiraTemplateEntry[]>([]);
  const [work, setWork] = useState<Work>("loading");
  const [failed, setFailed] = useState(false);
  const [validation, setValidation] = useState<Tools["validation"]>();
  const [proposals, setProposals] = useState<readonly JiraTemplateProposal[]>();
  const run = async (kind: Work, operation: () => Promise<void>): Promise<void> => {
    setWork(kind);
    setFailed(false);
    try {
      await operation();
    } catch {
      setFailed(true);
    } finally {
      setWork("idle");
    }
  };
  const reload = (): Promise<void> =>
    run("loading", async () => setTemplates(await fetchJiraTemplates()));
  useEffect(() => {
    void reload();
    // The library version changes when a template is uploaded, replaced or deleted.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload closes over setters only
  }, [version]);
  return {
    templates,
    work,
    failed,
    validation,
    proposals,
    reload,
    validate: (entry) =>
      run("validating", async () => {
        if (podId === undefined) return;
        const skill = await readMarkdownSkill({
          id: entry.id,
          revision: entry.revision,
          digest: "",
        });
        setValidation({ name: entry.name, result: await validateJiraTemplate(podId, skill.body) });
      }),
    propose: (projectKey) =>
      run("proposing", async () => {
        if (podId !== undefined) setProposals(await proposeJiraTemplates(podId, projectKey));
      }),
  };
}

function JiraTemplatePanel({ library }: { readonly library: MarkdownSkillLibrary }): ReactNode {
  const t = useTranslate();
  const pods = usePodChoices(listAtlassianConnectors, true);
  const ready = pods.pods.filter((pod) => pod.ready);
  const [selected, setSelected] = useState<string>();
  const podId = selected ?? ready[0]?.id;
  const tools = useJiraTemplateTools(podId, library.skills.length);
  const busy = tools.work !== "idle";
  const selectId = useId();
  return (
    <>
      <p>{t("chat.skills.jira.description")}</p>
      <label className={styles.cmpUpload} htmlFor={selectId}>
        {t("chat.skills.jira.pod")}
        <select
          id={selectId}
          value={podId ?? ""}
          disabled={busy || ready.length === 0}
          onChange={(event) => setSelected(event.target.value)}
        >
          {ready.map((pod) => (
            <option key={pod.id} value={pod.id}>
              {pod.name}
            </option>
          ))}
        </select>
      </label>
      {podId === undefined ? <p>{t("chat.skills.jira.podRequired")}</p> : null}
      {tools.failed ? <p role="alert">{t("chat.skills.jira.error")}</p> : null}
      <TemplateList tools={tools} canValidate={podId !== undefined && !busy} />
      {tools.validation ? <ValidationResult validation={tools.validation} /> : null}
      <Proposal tools={tools} library={library} canPropose={podId !== undefined && !busy} />
    </>
  );
}

function TemplateList({
  tools,
  canValidate,
}: {
  readonly tools: Tools;
  readonly canValidate: boolean;
}): ReactNode {
  const t = useTranslate();
  if (tools.work === "loading") return <output>{t("chat.skills.loading")}</output>;
  if (tools.templates.length === 0) return <p>{t("chat.skills.jira.empty")}</p>;
  return (
    <ul className={styles.cmpList}>
      {tools.templates.map((entry) => (
        <li key={entry.id}>
          <span className={styles.cmpName}>
            {entry.name}
            <br />
            <span className={styles.cmpHint}>
              {entry.valid
                ? `${entry.project ?? ""} · ${entry.issueType ?? ""} · ${(entry.activations ?? []).join(", ")}`
                : t("chat.skills.jira.invalid")}
            </span>
          </span>
          <button
            type="button"
            disabled={!canValidate || !entry.valid}
            onClick={() => {
              void tools.validate(entry);
            }}
          >
            {t(
              tools.work === "validating"
                ? "chat.skills.jira.validating"
                : "chat.skills.jira.validate",
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function ValidationResult({
  validation,
}: {
  readonly validation: NonNullable<Tools["validation"]>;
}): ReactNode {
  const t = useTranslate();
  const { result } = validation;
  if (!result.valid)
    return (
      <p role="alert">
        {t("chat.skills.jira.syntax", {
          codes: result.errors.map((error) => error.code).join(", "),
        })}
      </p>
    );
  if (result.findings.length === 0) return <output>{t("chat.skills.jira.valid")}</output>;
  return (
    <ul aria-label={validation.name}>
      {result.findings.map((finding) => (
        <li key={`${finding.code}:${finding.subject}`}>
          {t(FINDING_MESSAGES[finding.code], { subject: finding.subject })}
        </li>
      ))}
    </ul>
  );
}

function Proposal({
  tools,
  library,
  canPropose,
}: {
  readonly tools: Tools;
  readonly library: MarkdownSkillLibrary;
  readonly canPropose: boolean;
}): ReactNode {
  const t = useTranslate();
  const [projectKey, setProjectKey] = useState("");
  const key = projectKey.trim();
  return (
    <section>
      <label className={styles.cmpUpload}>
        {t("chat.skills.jira.projectKey")}
        <input
          value={projectKey}
          maxLength={128}
          onChange={(event) => setProjectKey(event.target.value)}
        />
      </label>
      <div className={styles.cmpActions}>
        <button
          type="button"
          disabled={!canPropose || !/^[A-Za-z][A-Za-z0-9_]*$/u.test(key)}
          onClick={() => {
            void tools.propose(key);
          }}
        >
          {t(
            tools.work === "proposing" ? "chat.skills.jira.proposing" : "chat.skills.jira.propose",
          )}
        </button>
      </div>
      {tools.proposals?.length === 0 ? <p>{t("chat.skills.jira.proposalNone")}</p> : null}
      {(tools.proposals ?? []).map((proposal) => (
        <ProposalDraft
          key={proposal.issueType}
          proposal={proposal}
          library={library}
          onSaved={tools.reload}
        />
      ))}
    </section>
  );
}

function ProposalDraft({
  proposal,
  library,
  onSaved,
}: {
  readonly proposal: JiraTemplateProposal;
  readonly library: MarkdownSkillLibrary;
  readonly onSaved: () => Promise<void>;
}): ReactNode {
  const t = useTranslate();
  const [draft, setDraft] = useState(proposal.markdown);
  return (
    <section>
      <h3>
        {t("chat.skills.jira.proposalTitle", {
          issueType: proposal.issueType,
          count: proposal.sampledIssueCount,
        })}
      </h3>
      <textarea
        aria-label={proposal.issueType}
        rows={10}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className={styles.cmpActions}>
        <button
          type="button"
          disabled={library.busy || !library.available || !skillTextFits(draft)}
          onClick={() => {
            void library
              .upload(
                new File(
                  [draft],
                  `${proposal.issueType.replace(/[^A-Za-z0-9_-]+/gu, "-")}-template.md`,
                  { type: "text/markdown" },
                ),
              )
              .then(onSaved);
          }}
        >
          {t("chat.skills.jira.save")}
        </button>
      </div>
    </section>
  );
}
