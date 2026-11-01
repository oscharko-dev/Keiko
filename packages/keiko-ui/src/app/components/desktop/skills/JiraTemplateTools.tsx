"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
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
/** A validation belongs to the exact stored revision it read, never to the template's name. */
interface Validation {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly result: JiraTemplateValidation;
}
/** Each proposal run is a generation, so a new proposal never inherits an earlier draft's edits. */
interface Proposals {
  readonly generation: number;
  readonly items: readonly JiraTemplateProposal[];
}
interface Tools {
  readonly templates: readonly JiraTemplateEntry[];
  readonly work: Work;
  readonly failed: boolean;
  readonly validation: Validation | undefined;
  readonly proposals: Proposals | undefined;
  readonly validate: (entry: JiraTemplateEntry) => Promise<void>;
  readonly propose: (projectKey: string) => Promise<void>;
  readonly reload: () => Promise<void>;
}

/** Identifies the stored skills (id, revision, digest): a same-count replacement changes it. */
function libraryVersion(skills: MarkdownSkillLibrary["skills"]): string {
  return skills.map((skill) => `${skill.id}:${String(skill.revision)}:${skill.digest}`).join("|");
}

type Run = (kind: Work, operation: () => Promise<void>) => Promise<void>;

/** Validation and proposal need a Pod; each result is recorded against what it was made from. */
function useTemplateActions(
  run: Run,
  podId: string | undefined,
): Pick<Tools, "validate" | "propose"> & Pick<Tools, "validation" | "proposals"> {
  const [validation, setValidation] = useState<Validation>();
  const [proposals, setProposals] = useState<Proposals>();
  return {
    validation,
    proposals,
    validate: (entry) =>
      run("validating", async () => {
        if (podId === undefined) return;
        const skill = await readMarkdownSkill({
          id: entry.id,
          revision: entry.revision,
          digest: "",
        });
        setValidation({
          id: entry.id,
          revision: entry.revision,
          name: entry.name,
          result: await validateJiraTemplate(podId, skill.body),
        });
      }),
    propose: (projectKey) =>
      run("proposing", async () => {
        if (podId === undefined) return;
        const items = await proposeJiraTemplates(podId, projectKey);
        setProposals((current) => ({ generation: (current?.generation ?? 0) + 1, items }));
      }),
  };
}

function useJiraTemplateTools(podId: string | undefined, version: string): Tools {
  const [templates, setTemplates] = useState<readonly JiraTemplateEntry[]>([]);
  const [work, setWork] = useState<Work>("loading");
  const [failed, setFailed] = useState(false);
  const latestLoad = useRef(0);
  const run: Run = async (kind, operation) => {
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
    run("loading", async () => {
      const load = ++latestLoad.current;
      const next = await fetchJiraTemplates();
      // An older read that settles last must not replace the newer list.
      if (load === latestLoad.current) setTemplates(next);
    });
  useEffect(() => {
    void reload();
    // The library version changes when a template is uploaded, replaced or deleted.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload closes over setters only
  }, [version]);
  const actions = useTemplateActions(run, podId);
  const { validation } = actions;
  return {
    ...actions,
    templates,
    work,
    failed,
    reload,
    // Only a result for a revision the list still holds can describe what write admission enforces.
    validation: templates.some(
      (entry) => entry.id === validation?.id && entry.revision === validation.revision,
    )
      ? validation
      : undefined,
  };
}

function JiraTemplatePanel({ library }: { readonly library: MarkdownSkillLibrary }): ReactNode {
  const t = useTranslate();
  const pods = usePodChoices(listAtlassianConnectors, true);
  const ready = pods.pods.filter((pod) => pod.ready);
  const [selected, setSelected] = useState<string>();
  const podId = selected ?? ready[0]?.id;
  const tools = useJiraTemplateTools(podId, libraryVersion(library.skills));
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

const INSTANCE_CHECKS = {
  project: "chat.skills.jira.check.project",
  fields: "chat.skills.jira.check.fields",
  linkTypes: "chat.skills.jira.check.linkTypes",
  transitions: "chat.skills.jira.check.transitions",
} as const satisfies Record<keyof ValidChecked, string>;
type ValidChecked = Extract<JiraTemplateValidation, { valid: true }>["checked"];

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
  // The server omits instance metadata it could not read and the comparison skips that part, so
  // "no findings" is a complete match only when every part was actually compared.
  const unchecked = (Object.keys(INSTANCE_CHECKS) as (keyof ValidChecked)[]).filter(
    (check) => !result.checked[check],
  );
  return (
    <>
      {result.findings.length === 0 ? null : (
        <ul aria-label={validation.name}>
          {result.findings.map((finding) => (
            <li key={`${finding.code}:${finding.subject}`}>
              {t(FINDING_MESSAGES[finding.code], { subject: finding.subject })}
            </li>
          ))}
        </ul>
      )}
      {unchecked.length === 0 && result.findings.length === 0 ? (
        <output>{t("chat.skills.jira.valid")}</output>
      ) : null}
      {unchecked.length === 0 ? null : (
        <output>
          {t("chat.skills.jira.partial", {
            checks: unchecked.map((check) => t(INSTANCE_CHECKS[check])).join(", "),
          })}
        </output>
      )}
    </>
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
          disabled={!canPropose || !/^[A-Za-z]\w*$/u.test(key)}
          onClick={() => {
            void tools.propose(key);
          }}
        >
          {t(
            tools.work === "proposing" ? "chat.skills.jira.proposing" : "chat.skills.jira.propose",
          )}
        </button>
      </div>
      {tools.proposals?.items.length === 0 ? <p>{t("chat.skills.jira.proposalNone")}</p> : null}
      {(tools.proposals?.items ?? []).map((proposal) => (
        <ProposalDraft
          key={`${String(tools.proposals?.generation)}:${proposal.issueType}`}
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
