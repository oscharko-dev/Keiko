"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { listAtlassianConnectors } from "@/lib/atlassian-connectors-api";
import {
  fetchJiraTemplates,
  proposeJiraTemplates,
  type JiraTemplateEntry,
  type JiraTemplateFindingCode,
  type JiraTemplateProposal,
  type JiraTemplateValidation,
} from "@/lib/jira-templates-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import { bffRequestErrorKind } from "@/lib/http";
import { usePodChoices } from "../useJiraPodChoices";
import {
  templateKey,
  useAutomaticTemplateChecks,
  type AutomaticTemplateCheck,
} from "./useAutomaticTemplateChecks";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import type { MarkdownSkillMetadata } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ChatMarkdownSkill } from "../hooks/useChatMarkdownSkill";
import { SkillChatToggle } from "./SkillChatToggle";
import type { MarkdownSkillLibrary } from "./useMarkdownSkillLibrary";
import styles from "./MarkdownSkillControl.module.css";

/**
 * Jira issue templates are skills with a Jira front matter (#4177): saving, downloading and
 * deleting are the skill library's. They apply on their own to every Jira write, so they have no
 * per-chat selection. Keiko checks each against Jira and can propose one from an existing project.
 */
const FINDING_MESSAGES = {
  "unknown-project": "chat.skills.jira.finding.unknown-project",
  "unknown-issue-type": "chat.skills.jira.finding.unknown-issue-type",
  "unknown-field": "chat.skills.jira.finding.unknown-field",
  "ambiguous-field": "chat.skills.jira.finding.ambiguous-field",
  "unknown-link-type": "chat.skills.jira.finding.unknown-link-type",
  "unknown-transition-target": "chat.skills.jira.finding.unknown-transition-target",
  "wrong-parent-field": "chat.skills.jira.finding.wrong-parent-field",
} as const satisfies Record<JiraTemplateFindingCode, string>;

type Work = "idle" | "loading" | "proposing";
/** Each proposal run is a generation, so a new proposal never inherits an earlier draft's edits. */
interface Proposals {
  readonly scope: RequestScope;
  readonly correlationId: string;
  readonly generation: number;
  readonly items: readonly JiraTemplateProposal[];
}
interface Tools {
  readonly templates: readonly JiraTemplateEntry[];
  /** True once the list for the current library was read, successfully or not. */
  readonly listed: boolean;
  /** Automatic results by `id:revision`, for the selected Pod and the listed revisions only. */
  readonly checks: ReadonlyMap<string, AutomaticTemplateCheck>;
  readonly work: Work;
  readonly failed: boolean;
  readonly proposals: Proposals | undefined;
  readonly propose: (projectKey: string) => Promise<void>;
  readonly reload: () => Promise<void>;
}

/** Identifies the stored skills (id, revision, digest): a same-count replacement changes it. */
function libraryVersion(skills: MarkdownSkillLibrary["skills"]): string {
  return skills.map((skill) => `${skill.id}:${String(skill.revision)}:${skill.digest}`).join("|");
}

/** The template list together with the stored-library version it was read for. */
interface Loaded {
  readonly version: string;
  readonly entries: readonly JiraTemplateEntry[];
  readonly failed: boolean;
}

/** Object identity also invalidates an A → B → A scope transition. */
interface RequestScope {
  readonly podId: string | undefined;
  readonly version: string;
}
interface RequestState {
  readonly scope: RequestScope;
  readonly work: Work;
  readonly failed: boolean;
}
type Run = (
  kind: Work,
  operation: (isCurrent: () => boolean, correlationId: string) => Promise<void>,
) => Promise<void>;

function useTemplateRequest(scope: RequestScope): Pick<Tools, "work" | "failed"> & { run: Run } {
  const [state, setState] = useState<RequestState>({ scope, work: "loading", failed: false });
  const currentScope = useRef<RequestScope | undefined>(scope);
  const sequence = useRef(0);
  currentScope.current = scope;
  useEffect(() => {
    currentScope.current = scope;
    return (): void => {
      if (currentScope.current === scope) currentScope.current = undefined;
    };
  }, [scope]);
  const run: Run = async (kind, operation) => {
    const correlationId = newClientCorrelationId();
    const request = ++sequence.current;
    const isCurrent = (): boolean => currentScope.current === scope && sequence.current === request;
    setState({ scope, work: kind, failed: false });
    try {
      await operation(isCurrent, correlationId);
    } catch (error) {
      if (isCurrent()) setState({ scope, work: "idle", failed: true });
      reportClientDiagnostic("Jira template request failed.", {
        correlationId,
        errorKind: bffRequestErrorKind(error),
        errorEvidence: clientErrorEvidence(error),
      });
    } finally {
      if (isCurrent()) setState((current) => ({ ...current, work: "idle" }));
    }
  };
  return {
    run,
    work: state.scope === scope ? state.work : "idle",
    failed: state.scope === scope && state.failed,
  };
}

/** A proposal needs a Pod; each result is recorded against the run that made it. */
function useTemplateProposals(run: Run, scope: RequestScope): Pick<Tools, "propose" | "proposals"> {
  const [proposals, setProposals] = useState<Proposals>();
  const retired = useRef<Proposals | undefined>(undefined);
  useEffect(() => {
    if (proposals === undefined || proposals.scope === scope || retired.current === proposals)
      return;
    retired.current = proposals;
    reportClientDiagnostic("Jira template proposal superseded.", {
      correlationId: proposals.correlationId,
    });
  }, [proposals, scope]);
  return {
    proposals: proposals?.scope === scope ? proposals : undefined,
    propose: (projectKey) =>
      run("proposing", async (isCurrent, correlationId) => {
        if (scope.podId === undefined) return;
        const items = await proposeJiraTemplates(scope.podId, projectKey, correlationId);
        if (!isCurrent()) return;
        setProposals((current) => ({
          scope,
          correlationId,
          generation: (current?.generation ?? 0) + 1,
          items,
        }));
      }),
  };
}

function useJiraTemplateTools(podId: string | undefined, version: string): Tools {
  const [loaded, setLoaded] = useState<Loaded>();
  const scope = useMemo(() => ({ podId, version }), [podId, version]);
  const request = useTemplateRequest(scope);
  const { run } = request;
  const latestLoad = useRef(0);
  const currentVersion = useRef(version);
  currentVersion.current = version;
  const reload = (): Promise<void> =>
    run("loading", async (_isCurrent, correlationId) => {
      const load = ++latestLoad.current;
      const readFor = currentVersion.current;
      try {
        const next = await fetchJiraTemplates(correlationId);
        // List reads depend on the library, so resolving the default Pod cannot retire them.
        if (load === latestLoad.current)
          setLoaded({ version: readFor, entries: next, failed: false });
      } catch (error) {
        if (load === latestLoad.current) setLoaded({ version: readFor, entries: [], failed: true });
        throw error;
      }
    });
  useEffect(() => {
    void reload();
    // The library version changes when a template is uploaded, replaced or deleted.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- list reads depend on the library, not its selected Pod
  }, [version]);
  const proposals = useTemplateProposals(run, scope);
  // A list read for an older stored library describes rules the store no longer holds, so while
  // the current read is unavailable nothing is listed, checked or qualified from it.
  const templates = loaded?.version === version ? loaded.entries : [];
  const checks = useAutomaticTemplateChecks(podId, templates);
  return {
    ...proposals,
    templates,
    listed: loaded?.version === version,
    checks,
    ...request,
    failed: request.failed || (loaded?.version === version && loaded.failed),
    reload,
  };
}

/** The templates, their checks against the chosen Jira Pod, and the project proposals. */
export interface JiraTemplates {
  readonly tools: Tools;
  readonly pods: readonly { readonly id: string; readonly name: string }[];
  readonly podId: string | undefined;
  readonly selectPod: (podId: string) => void;
  /** The stored skills that are templates, once the list was read (empty when it failed). */
  readonly templateIds: ReadonlySet<string> | undefined;
}

export function useJiraTemplates(library: MarkdownSkillLibrary): JiraTemplates {
  const pods = usePodChoices(listAtlassianConnectors, true);
  const ready = pods.pods.filter((pod) => pod.ready);
  const [selected, setSelected] = useState<string>();
  const podId = ready.find((pod) => pod.id === selected)?.id ?? ready[0]?.id;
  const tools = useJiraTemplateTools(podId, libraryVersion(library.skills));
  const ids = tools.templates.map((entry) => entry.id).join("|");
  const templateIds = useMemo(() => {
    if (!tools.listed) return undefined;
    return new Set(ids.length === 0 ? [] : ids.split("|"));
  }, [ids, tools.listed]);
  return { tools, pods: ready, podId, selectPod: setSelected, templateIds };
}

export function PodSelect({ jira }: { readonly jira: JiraTemplates }): ReactNode {
  const t = useTranslate();
  const selectId = useId();
  if (jira.pods.length < 2) return null;
  return (
    <label className={styles.cmpPod} htmlFor={selectId}>
      <span>{t("chat.skills.jira.pod")}</span>
      <select
        id={selectId}
        value={jira.podId ?? ""}
        onChange={(event) => jira.selectPod(event.target.value)}
      >
        {jira.pods.map((pod) => (
          <option key={pod.id} value={pod.id}>
            {pod.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function TemplateRow({
  entry,
  item,
  library,
  check,
  open,
  onOpen,
  chat,
}: {
  readonly entry: JiraTemplateEntry;
  readonly item: MarkdownSkillMetadata | undefined;
  readonly library: MarkdownSkillLibrary;
  readonly check: AutomaticTemplateCheck | undefined;
  readonly open: boolean;
  readonly onOpen: (skill: MarkdownSkillMetadata) => void;
  readonly chat: { readonly skill: ChatMarkdownSkill; readonly disabled: boolean } | undefined;
}): ReactNode {
  return (
    <li className={styles.cmpRow}>
      <button
        type="button"
        className={styles.cmpItem}
        aria-current={open ? "true" : undefined}
        disabled={item === undefined}
        onClick={() => {
          if (item !== undefined) onOpen(item);
        }}
      >
        <span className={styles.cmpItemName}>{entry.name}</span>
        <TemplateStatus entry={entry} check={check} />
      </button>
      {item === undefined || chat === undefined ? null : (
        <SkillChatToggle
          item={item}
          skill={chat.skill}
          library={library}
          disabled={chat.disabled}
        />
      )}
    </li>
  );
}

/** The templates in the library column; each opens in the editor. */
export function JiraTemplateList({
  jira,
  library,
  openId,
  onOpen,
  chat,
}: {
  readonly jira: JiraTemplates;
  readonly library: MarkdownSkillLibrary;
  readonly openId: string | undefined;
  readonly onOpen: (skill: MarkdownSkillMetadata) => void;
  /** Offers choosing a stored template for the chat beside its row. */
  readonly chat?: { readonly skill: ChatMarkdownSkill; readonly disabled: boolean };
}): ReactNode {
  const t = useTranslate();
  const { tools } = jira;
  if (tools.failed)
    return (
      <p role="alert" className={styles.cmpEmpty}>
        {t("chat.skills.jira.error")}
      </p>
    );
  if (tools.work === "loading" && tools.templates.length === 0)
    return <output className={styles.cmpEmpty}>{t("chat.skills.loading")}</output>;
  if (tools.templates.length === 0)
    return <p className={styles.cmpEmpty}>{t("chat.skills.jira.empty")}</p>;
  return (
    <ul className={styles.cmpItems}>
      {tools.templates.map((entry) => (
        <TemplateRow
          key={entry.id}
          entry={entry}
          item={library.skills.find((skill) => skill.id === entry.id)}
          library={library}
          check={tools.checks.get(templateKey(entry))}
          open={openId === entry.id}
          onOpen={onOpen}
          chat={chat}
        />
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
type Translate = ReturnType<typeof useTranslate>;

/** What the automatic check found, as one sentence; a mismatch names its cause and nothing else. */
function checkSentence(check: AutomaticTemplateCheck | undefined, t: Translate): string {
  if (check === undefined) return t("chat.skills.jira.checking");
  if (check === "failed") return t("chat.skills.jira.checkFailed");
  if (!check.valid) return t("chat.skills.jira.invalid");
  if (check.findings.length > 0)
    return t("chat.skills.jira.notApplied", {
      reasons: check.findings
        .map((finding) => t(FINDING_MESSAGES[finding.code], { subject: finding.subject }))
        .join(" "),
    });
  // The server omits instance metadata it could not read, so "no findings" is a complete match
  // only when every part was actually compared.
  const unchecked = (Object.keys(INSTANCE_CHECKS) as (keyof ValidChecked)[]).filter(
    (part) => !check.checked[part],
  );
  return unchecked.length === 0
    ? t("chat.skills.jira.valid")
    : t("chat.skills.jira.partial", {
        checks: unchecked.map((part) => t(INSTANCE_CHECKS[part])).join(", "),
      });
}

type CheckState = "ok" | "mismatch" | "pending";

function checkState(
  entry: JiraTemplateEntry,
  check: AutomaticTemplateCheck | undefined,
): CheckState {
  if (!entry.valid) return "mismatch";
  if (check === undefined) return "pending";
  return check === "failed" || !check.valid || check.findings.length > 0 ? "mismatch" : "ok";
}

/** One short line per template: which Jira project and issue type it governs, and whether it can. */
export function TemplateStatus({
  entry,
  check,
}: {
  readonly entry: JiraTemplateEntry;
  readonly check: AutomaticTemplateCheck | undefined;
}): ReactNode {
  const t = useTranslate();
  const state = checkState(entry, check);
  const sentence = entry.valid ? checkSentence(check, t) : t("chat.skills.jira.invalid");
  const scope = entry.valid ? `${entry.project ?? ""} · ${entry.issueType ?? ""} — ` : "";
  return (
    <span className={styles.cmpStatus} data-state={state}>
      <span className={styles.cmpDot} aria-hidden="true" />
      <span>
        {scope}
        {sentence}
      </span>
    </span>
  );
}

/** A project lead's occasional task: read a Jira project and open the proposal in the editor. */
export function JiraTemplateProposal({
  jira,
  onDraft,
}: {
  readonly jira: JiraTemplates;
  readonly onDraft: (text: string, fileName: string) => void;
}): ReactNode {
  const t = useTranslate();
  const [projectKey, setProjectKey] = useState("");
  const key = projectKey.trim();
  const { tools } = jira;
  const canPropose = jira.podId !== undefined && tools.work === "idle";
  return (
    <div className={styles.cmpForm}>
      <h3>{t("chat.skills.jira.proposeTitle")}</h3>
      <p>{t("chat.skills.jira.proposeDescription")}</p>
      {jira.podId === undefined ? <p role="alert">{t("chat.skills.jira.podRequired")}</p> : null}
      <PodSelect jira={jira} />
      <div className={styles.cmpInline}>
        <label className={styles.cmpField}>
          <span>{t("chat.skills.jira.projectKey")}</span>
          <input
            value={projectKey}
            maxLength={128}
            placeholder="KER"
            onChange={(event) => setProjectKey(event.target.value)}
          />
        </label>
        <button
          type="button"
          className={styles.cmpPrimary}
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
      {tools.failed ? <p role="alert">{t("chat.skills.jira.error")}</p> : null}
      <ProposalList proposals={tools.proposals} onDraft={onDraft} />
    </div>
  );
}

function ProposalList({
  proposals,
  onDraft,
}: {
  readonly proposals: Proposals | undefined;
  readonly onDraft: (text: string, fileName: string) => void;
}): ReactNode {
  const t = useTranslate();
  if (proposals === undefined) return null;
  if (proposals.items.length === 0) return <p>{t("chat.skills.jira.proposalNone")}</p>;
  return (
    <ul className={styles.cmpProposals}>
      {proposals.items.map((proposal) => (
        <li key={`${String(proposals.generation)}:${proposal.issueType}`}>
          <span>
            {t("chat.skills.jira.proposalTitle", {
              issueType: proposal.issueType,
              count: proposal.sampledIssueCount,
            })}
          </span>
          <button
            type="button"
            onClick={() =>
              onDraft(
                proposal.markdown,
                `${proposal.issueType.replace(/[^A-Za-z0-9_-]+/gu, "-")}-template.md`,
              )
            }
          >
            {t("chat.skills.jira.openProposal")}
          </button>
        </li>
      ))}
    </ul>
  );
}
