"use client";

// Prompt Enhancer panel — the governed UI workflow surface (Epic #1307, Issue #1314; ADR-0044 §1
// "Governed UI surface (PromptEnhancerPanel sibling of GroundedAnswerPanel)"). The first screen IS the
// workflow: a dense form (raw draft → profile + missing-info strategy → optional enhancement model) plus
// a structured, reviewable result (every Enhanced Prompt section, the grounding plan, safety rules and
// warnings, the output schema, quality criteria, and the candidate scorecards). The generated prompt is
// data for review and copy/export — it is never executed as a downstream task from here (AC5). The
// optional model runs only as a bounded enhancement/refinement step through the Model Gateway (AC3). No
// secret, raw private log, or hidden system prompt is shown (the server redacts on the wire, AC4).

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ApiError, enhancePrompt, fetchModels } from "@/lib/api";
import { copyTextToClipboard } from "@/lib/clipboard";
import {
  useOptionalWidgetTranslate,
  type OptionalWidgetTranslate,
} from "@/lib/optional-widget-i18n";
import type {
  ModelCapability,
  PromptEnhancementWireRequest,
  PromptEnhancementWireResponse,
} from "@/lib/types";
import { Icons } from "../../Icons";
import KeikoSelect from "../../KeikoSelect";
import { NATIVE_BLOCK_STYLE } from "../../native-element-styles";
import { humanizeToken } from "../../GroundedAnswer";
import { buildConnectedRunSources } from "../quality-intelligence/connectedSources";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const CheckIcon = Icons.check;
const InfoIcon = Icons.info;
const SparkIcon = Icons.spark;
const LayersIcon = Icons.layers;
const ResetIcon = Icons.reset;
const FileIcon = Icons.file;

const PROFILE_VALUES = [
  "auto",
  "fast",
  "precise",
  "research",
  "creative",
  "technical",
  "safety-critical",
  "agentic",
] as const;

const STRATEGY_VALUES = ["clarify", "assume"] as const;

const NO_MODEL = "__none__";
const COPY_SUCCESS_RESET_MS = 3_000;

type CopyState = "idle" | "copying" | "copied" | "failed";

export interface PromptEnhancerPanelProps {
  readonly connectedRoot?: string | null;
  readonly connectedFilePath?: string | null;
  readonly connectedRoots?: readonly string[];
  // Test seams: production wires the real BFF calls; tests inject deterministic fakes.
  readonly enhanceImpl?: typeof enhancePrompt;
  readonly fetchModelsImpl?: typeof fetchModels;
}

interface GroundingContextSummary {
  readonly hasConnectedContext: boolean;
  readonly attachmentCount: number;
  readonly label: string;
  readonly signature: string;
}

interface ConnectedContextInput {
  readonly connectedRoot?: string | null;
  readonly connectedFilePath?: string | null;
  readonly connectedRoots?: readonly string[] | undefined;
}

function describeError(error: unknown, t: OptionalWidgetTranslate): string {
  if (error instanceof ApiError) {
    return `${error.message} (${error.code})`;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return t("promptEnhancer.error.cancelled");
  }
  return t("promptEnhancer.error.failed");
}

function summarizeConnectedContext(
  { connectedRoot, connectedFilePath, connectedRoots }: ConnectedContextInput,
  t: OptionalWidgetTranslate,
): GroundingContextSummary {
  const sources = buildConnectedRunSources({
    connectedRoot: connectedRoot ?? null,
    connectedFilePath: connectedFilePath ?? null,
    connectedRoots,
  });
  if (sources.length === 0) {
    return {
      hasConnectedContext: false,
      attachmentCount: 0,
      label: t("promptEnhancer.context.noFilesSource"),
      signature: "none",
    };
  }
  const labels = sources.map((source) => source.label);
  const label =
    labels.length === 1
      ? (labels[0] ?? t("promptEnhancer.context.connectedSource"))
      : t("promptEnhancer.context.connectedSources", { count: labels.length });
  return {
    hasConnectedContext: true,
    attachmentCount: sources.length,
    label,
    signature: JSON.stringify(sources),
  };
}

function StringList({
  items,
  empty,
}: {
  readonly items: readonly string[];
  readonly empty?: string;
}): ReactNode {
  if (items.length === 0) {
    return empty === undefined ? null : <p className="pe-empty">{empty}</p>;
  }
  return (
    <ul className="pe-list">
      {items.map((item, index) => (
        <li key={`${String(index)}:${item.slice(0, 24)}`}>{item}</li>
      ))}
    </ul>
  );
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section className="pe-section" aria-label={title}>
      <h4 className="pe-section-title">{title}</h4>
      {children}
    </section>
  );
}

// The profile of the candidate that actually produced the prompt. `analysis.recommendedProfile` is
// the analyzer's suggestion and can differ from the winner (an explicit profile preference, or a
// criticality escalation), so showing it under a "Profile" label described the wrong artefact.
function winningProfile(result: PromptEnhancementWireResponse): string | undefined {
  return result.candidates.scorecards.find(
    (scorecard) => scorecard.candidateId === result.candidates.winnerCandidateId,
  )?.profile;
}

function AnalysisSummary({
  result,
  t,
}: {
  readonly result: PromptEnhancementWireResponse;
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  const profile = winningProfile(result);
  const tokens = result.renderedPromptEstimatedTokens;
  const items = [
    [t("promptEnhancer.analysis.task"), humanizeToken(result.analysis.taskClass)],
    [t("promptEnhancer.analysis.domain"), humanizeToken(result.analysis.domain)],
    [t("promptEnhancer.analysis.criticality"), humanizeToken(result.analysis.criticality)],
    [t("promptEnhancer.analysis.profile"), profile === undefined ? "-" : humanizeToken(profile)],
    [
      t("promptEnhancer.analysis.input"),
      t("promptEnhancer.analysis.chars", { count: result.analysis.normalizedInputLength }),
    ],
    // Guarded because the field is a wire value: an older server that omits it must render no token
    // row at all rather than an "~undefined tokens" figure.
    ...(Number.isFinite(tokens)
      ? ([
          [
            t("promptEnhancer.analysis.promptTokens"),
            t("promptEnhancer.analysis.tokenEstimate", { count: tokens }),
          ],
        ] as const)
      : []),
  ] as const;
  return (
    <dl className="pe-analysis" aria-label={t("promptEnhancer.analysis.ariaLabel")}>
      {items.map(([label, value]) => (
        <div className="pe-analysis-item" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// #2723 (S3358): the routing-banner tone was a nested ternary
// (executionStatus === "model-applied" ? "ok" : availability/status check ? "warn" : "muted");
// extracted to a named if/else-if chain.
function modelRoutingTone(
  routing: PromptEnhancementWireResponse["modelRouting"],
): "ok" | "warn" | "muted" {
  if (routing.executionStatus === "model-applied") return "ok";
  if (routing.availability === "unavailable" || routing.executionStatus === "model-fallback") {
    return "warn";
  }
  return "muted";
}

function ModelRoutingBanner({
  routing,
  t,
}: {
  readonly routing: PromptEnhancementWireResponse["modelRouting"];
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  const tone = modelRoutingTone(routing);
  let label = t("promptEnhancer.routing.deterministic");
  if (routing.executionStatus === "model-applied") {
    label = t("promptEnhancer.routing.modelEnhanced", {
      model: routing.resolvedModelId ?? routing.requestedModelId ?? "",
    });
  } else if (routing.executionStatus === "model-fallback") {
    label = t("promptEnhancer.routing.modelFallback", {
      reason: routing.fallbackReason ?? routing.reason,
    });
  } else if (routing.availability === "unavailable") {
    label = t("promptEnhancer.routing.modelUnavailable");
  }
  return (
    <div
      className={`pe-routing pe-routing-${tone}`}
      data-testid="pe-model-routing"
      role="status"
      aria-live="polite"
    >
      <span className="pe-routing-icon" aria-hidden="true">
        {tone === "ok" ? <CheckIcon size={14} /> : <InfoIcon size={14} />}
      </span>
      <span>{label}</span>
    </div>
  );
}

function SafetyPanel({
  safety,
  t,
}: {
  readonly safety: PromptEnhancementWireResponse["safety"];
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  const reviewing = safety.requiresHumanReview;
  // `decision` and `requiresHumanReview` are orthogonal safety signals (ADR-0044 §5): the first is
  // the validate-stage verdict on the artefact itself ("is this prompt safe to use"), the second is
  // a risk-profile flag on the underlying task ("does this specific case need a human look").
  // `requiresHumanReviewForAnalysis` derives the latter from criticality/task-class/risk-flags
  // independently of any blocking finding, so a `rejected` decision (a blocking structural finding —
  // e.g. an authority-grant or override cue) can and does arrive with `requiresHumanReview: false`
  // for a non-agentic, non-critical draft. Gating the alert on `reviewing` alone left that
  // rejected-but-not-flagged-for-review result rendering with NO visual warning at all (0.3.0
  // audit sibling-handoff gap). Each condition renders its own alert so neither can silence the
  // other, and both together render both.
  const rejected = safety.decision === "rejected";
  return (
    <Section title={t("promptEnhancer.safety.title")}>
      <dl className="pe-safety-summary" data-testid="pe-safety-decision">
        <div>
          <dt>{t("promptEnhancer.safety.decision")}</dt>
          <dd>{humanizeToken(safety.decision)}</dd>
        </div>
        <div>
          <dt>{t("promptEnhancer.safety.verification")}</dt>
          <dd>{humanizeToken(safety.verificationStatus)}</dd>
        </div>
        <div>
          <dt>{t("promptEnhancer.safety.humanReview")}</dt>
          <dd>
            {reviewing
              ? t("promptEnhancer.common.required")
              : t("promptEnhancer.common.notRequired")}
          </dd>
        </div>
      </dl>
      {rejected ? (
        <p className="pe-safety-warning pe-safety-rejected" role="alert">
          {t("promptEnhancer.safety.rejectedWarning")}
        </p>
      ) : null}
      {reviewing ? (
        <p className="pe-safety-warning" role="alert">
          {t("promptEnhancer.safety.reviewWarning")}
        </p>
      ) : null}
      {safety.findings.length > 0 ? (
        <>
          <h5 className="pe-subhead">{t("promptEnhancer.safety.findings")}</h5>
          <ul className="pe-list" data-testid="pe-safety-findings">
            {safety.findings.map((finding) => (
              <li key={`${finding.ruleId}:${finding.code}`}>
                <span className={`pe-sev pe-sev-${finding.severity}`}>{finding.severity}</span>{" "}
                {finding.detail}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {safety.leastPrivilege.length > 0 ? (
        <>
          <h5 className="pe-subhead">{t("promptEnhancer.safety.leastPrivilege")}</h5>
          <StringList items={[...safety.leastPrivilege]} />
        </>
      ) : null}
    </Section>
  );
}

// #2723 (S3358): the readiness-text lookup was a nested ternary
// (status === "ready" ? … : status === "unavailable" ? … : …); extracted to a named
// if/else-if chain.
function GroundingPanel({
  plan,
  readiness,
  t,
}: {
  readonly plan: PromptEnhancementWireResponse["enhancedPrompt"]["groundingPlan"];
  readonly readiness: PromptEnhancementWireResponse["groundingReadiness"];
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  let readinessText: string;
  if (readiness.status === "ready") {
    readinessText = t("promptEnhancer.grounding.ready");
  } else if (readiness.status === "unavailable") {
    readinessText = t("promptEnhancer.grounding.unavailable");
  } else {
    readinessText = t("promptEnhancer.grounding.notRequired");
  }
  return (
    <Section title={t("promptEnhancer.grounding.title")}>
      <div
        className={`pe-grounding-readiness pe-grounding-readiness-${readiness.status}`}
        data-testid="pe-grounding-readiness"
        role="status"
        aria-live="polite"
      >
        <span className="pe-routing-icon" aria-hidden="true">
          <InfoIcon size={14} />
        </span>
        <span>{readinessText}</span>
      </div>
      <p className="pe-grounding-meta">
        {t("promptEnhancer.grounding.meta", {
          strategy: humanizeToken(plan.strategy),
          requirement: plan.required
            ? t("promptEnhancer.common.required")
            : t("promptEnhancer.common.optional"),
          discipline: humanizeToken(plan.citation.discipline),
          granularity: humanizeToken(plan.citation.granularity),
        })}
      </p>
      {plan.sourcePriority.length > 0 ? (
        <>
          <h5 className="pe-subhead">{t("promptEnhancer.grounding.sourcePriority")}</h5>
          <ol className="pe-list">
            {plan.sourcePriority.map((source) => (
              <li key={source.source}>
                {source.source}
                {source.required ? t("promptEnhancer.grounding.requiredSuffix") : ""}
              </li>
            ))}
          </ol>
        </>
      ) : null}
      <StringList items={[...plan.directives]} />
    </Section>
  );
}

function EvidencePanel({
  evidence,
  fingerprint,
  t,
}: {
  readonly evidence: PromptEnhancementWireResponse["evidence"];
  readonly fingerprint: string;
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  return (
    <p className="pe-evidence" data-testid="pe-evidence">
      {t("promptEnhancer.evidence.fingerprint")} {fingerprint.slice(0, 16)}...
      {evidence.status === "recorded" && evidence.runId !== undefined ? (
        <>
          {" "}
          {t("promptEnhancer.evidence.manifest")}{" "}
          <a
            href={evidence.manifestUrl ?? "#"}
            target="_blank"
            rel="noreferrer"
            aria-label={t("promptEnhancer.evidence.manifestAriaLabel", { id: evidence.runId })}
          >
            {evidence.runId}
          </a>
        </>
      ) : (
        t("promptEnhancer.evidence.notRecorded")
      )}
    </p>
  );
}

function CandidateScorecards({
  candidates,
  t,
}: {
  readonly candidates: PromptEnhancementWireResponse["candidates"];
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  return (
    <Section title={t("promptEnhancer.scorecards.title")}>
      <div className="c-tablewrap">
        <div className="c-tablescroll">
          <table className="c-table responsive pe-scorecards" data-testid="pe-scorecards">
            <thead>
              <tr>
                <th scope="col">{t("promptEnhancer.analysis.profile")}</th>
                <th scope="col" className="num">
                  {t("promptEnhancer.scorecards.score")}
                </th>
                <th scope="col" className="num">
                  {t("promptEnhancer.scorecards.tokens")}
                </th>
                <th scope="col">{t("promptEnhancer.scorecards.winner")}</th>
              </tr>
            </thead>
            <tbody>
              {candidates.scorecards.map((scorecard) => {
                const winner = scorecard.candidateId === candidates.winnerCandidateId;
                return (
                  <tr
                    key={scorecard.candidateId}
                    className={winner ? "pe-winner" : undefined}
                    aria-selected={winner ? "true" : undefined}
                  >
                    <th scope="row">{scorecard.profile}</th>
                    <td className="num" data-label={t("promptEnhancer.scorecards.score")}>
                      {scorecard.aggregateScore.toFixed(3)}
                    </td>
                    <td className="num" data-label={t("promptEnhancer.scorecards.tokens")}>
                      {scorecard.estimatedTokens.toLocaleString("en-US")}
                    </td>
                    <td data-label={t("promptEnhancer.scorecards.winner")}>
                      {winner ? (
                        <span
                          className="pe-winner-mark"
                          aria-label={t("promptEnhancer.scorecards.winner")}
                        >
                          ★
                        </span>
                      ) : (
                        <span aria-hidden="true">-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Section>
  );
}

type CandidateRejection = PromptEnhancementWireResponse["candidates"]["rejected"][number];

function candidateRejectionReason(
  reason: CandidateRejection["reason"],
  t: OptionalWidgetTranslate,
): string {
  switch (reason) {
    case "lower-aggregate-score":
      return t("promptEnhancer.rejections.reason.lowerAggregateScore");
    case "lower-tie-break-rank":
      return t("promptEnhancer.rejections.reason.lowerTieBreakRank");
    case "exceeded-token-budget":
      return t("promptEnhancer.rejections.reason.exceededTokenBudget");
    case "duplicate-candidate":
      return t("promptEnhancer.rejections.reason.duplicateCandidate");
    case "safety-floor-not-preserved":
      return t("promptEnhancer.rejections.reason.safetyFloorNotPreserved");
    case "safety-validation-failed":
      return t("promptEnhancer.rejections.reason.safetyValidationFailed");
    case "profile-preference-not-matched":
      return t("promptEnhancer.rejections.reason.profilePreferenceNotMatched");
  }
}

function CandidateRejections({
  rejected,
  t,
}: {
  readonly rejected: readonly CandidateRejection[];
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  if (rejected.length === 0) return null;
  return (
    <Section title={t("promptEnhancer.rejections.title")}>
      <div className="c-tablewrap">
        <div className="c-tablescroll">
          <table className="c-table responsive" data-testid="pe-rejections">
            <thead>
              <tr>
                <th scope="col">{t("promptEnhancer.rejections.candidate")}</th>
                <th scope="col">{t("promptEnhancer.analysis.profile")}</th>
                <th scope="col" className="num">
                  {t("promptEnhancer.scorecards.score")}
                </th>
                <th scope="col">{t("promptEnhancer.rejections.reason")}</th>
              </tr>
            </thead>
            <tbody>
              {rejected.map((candidate) => (
                <tr key={candidate.candidateId}>
                  <th scope="row">
                    <code>{candidate.candidateId}</code>
                  </th>
                  <td>{candidate.profile}</td>
                  <td className="num" data-label={t("promptEnhancer.scorecards.score")}>
                    {candidate.aggregateScore === null
                      ? t("promptEnhancer.rejections.notScored")
                      : candidate.aggregateScore.toFixed(3)}
                  </td>
                  <td data-label={t("promptEnhancer.rejections.reason")}>
                    {candidateRejectionReason(candidate.reason, t)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Section>
  );
}

// On the model-assisted path the rendered prompt is the model's text, while the structured sections,
// the winning profile and the candidate scorecards all describe the deterministic baseline the model
// was given. Rendering both without saying so presents baseline numbers as a description of the
// displayed prompt. Styled with the existing `pe-evidence` caption class: `globals.css` is
// SHA-pinned by the visual-proof gate (#1300) and must not grow a new rule for this.
function BaselineNotice({
  routing,
  t,
}: {
  readonly routing: PromptEnhancementWireResponse["modelRouting"];
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  if (routing.executionStatus !== "model-applied") return null;
  return (
    <p className="pe-evidence" data-testid="pe-baseline-note">
      {t("promptEnhancer.result.baselineNote")}
    </p>
  );
}

function EnhancedPromptSections({
  result,
  t,
}: {
  readonly result: PromptEnhancementWireResponse;
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  const prompt = result.enhancedPrompt;
  const missing = result.analysis.missingContext.map((item) =>
    item.kind === "assumption" ? item.statement : item.question,
  );
  return (
    <div className="pe-section-grid">
      <Section title={t("promptEnhancer.section.role")}>
        <p>{prompt.role}</p>
      </Section>
      <Section title={t("promptEnhancer.section.objective")}>
        <p>{prompt.goal}</p>
      </Section>
      <Section title={t("promptEnhancer.section.context")}>
        <StringList
          items={[...prompt.context]}
          empty={t("promptEnhancer.section.noAdditionalContext")}
        />
      </Section>
      <Section
        title={
          result.analysis.missingContext.some((m) => m.kind === "assumption")
            ? t("promptEnhancer.section.assumptions")
            : t("promptEnhancer.section.clarificationQuestions")
        }
      >
        <StringList items={missing} empty={t("promptEnhancer.section.noClarifications")} />
      </Section>
      <Section title={t("promptEnhancer.section.steps")}>
        <StringList items={[...prompt.taskDecomposition]} />
      </Section>
      <Section title={t("promptEnhancer.section.constraints")}>
        <StringList items={[...prompt.constraints]} />
      </Section>
      <Section title={t("promptEnhancer.section.outputSchema")}>
        <p>
          {t("promptEnhancer.section.format")} <strong>{prompt.outputSchema.format}</strong>
          {prompt.outputSchema.structured ? t("promptEnhancer.section.structuredSuffix") : ""}
        </p>
        <StringList items={[...prompt.outputSchema.hints]} />
      </Section>
      <Section title={t("promptEnhancer.section.qualityCriteria")}>
        <StringList items={[...prompt.qualityCriteria]} />
      </Section>
      <Section title={t("promptEnhancer.section.uncertaintyHandling")}>
        <StringList items={[...prompt.uncertaintyHandling]} />
      </Section>
      <Section title={t("promptEnhancer.section.safetyRules")}>
        <StringList items={[...prompt.safetyRules]} />
      </Section>
    </div>
  );
}

type PromptEnhancerStatusKey =
  | "promptEnhancer.status.enhancing"
  | "promptEnhancer.status.waitingForDraft"
  | "promptEnhancer.status.ready";

function promptEnhancerStatusKey(loading: boolean, draftLength: number): PromptEnhancerStatusKey {
  if (loading) return "promptEnhancer.status.enhancing";
  if (draftLength === 0) return "promptEnhancer.status.waitingForDraft";
  return "promptEnhancer.status.ready";
}

export function PromptEnhancerPanel({
  connectedRoot = null,
  connectedFilePath = null,
  connectedRoots,
  enhanceImpl = enhancePrompt,
  fetchModelsImpl = fetchModels,
}: PromptEnhancerPanelProps = {}): ReactNode {
  const t = useOptionalWidgetTranslate();
  const [draft, setDraft] = useState("");
  const [profile, setProfile] = useState("auto");
  const [strategy, setStrategy] = useState("clarify");
  const [modelId, setModelId] = useState(NO_MODEL);
  const [models, setModels] = useState<readonly ModelCapability[]>([]);
  const [result, setResult] = useState<PromptEnhancementWireResponse | null>(null);
  const [resultGroundingSignature, setResultGroundingSignature] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const draftInputRef = useRef<HTMLTextAreaElement | null>(null);
  const resultTitleRef = useRef<HTMLHeadingElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const draftId = useId();
  const draftHintId = useId();
  const errorId = useId();

  useEffect(() => {
    let cancelled = false;
    void fetchModelsImpl()
      .then((response) => {
        if (!cancelled) setModels(response.models.filter((model) => model.kind === "chat"));
      })
      .catch(() => {
        // Enhancement model selection is optional; a config-less workspace simply offers no models.
      });
    return (): void => {
      cancelled = true;
    };
  }, [fetchModelsImpl]);

  useEffect(
    () => (): void => {
      abortRef.current?.abort();
    },
    [],
  );

  const groundingContext = useMemo(
    () => summarizeConnectedContext({ connectedRoot, connectedFilePath, connectedRoots }, t),
    [connectedRoot, connectedFilePath, connectedRoots, t],
  );

  useEffect(() => {
    if (copyState !== "copied") return undefined;
    const timeout = window.setTimeout(() => {
      setCopyState("idle");
      setCopyStatus(null);
    }, COPY_SUCCESS_RESET_MS);
    return (): void => {
      window.clearTimeout(timeout);
    };
  }, [copyState]);

  // After a successful enhance the result artifact renders below the form. Move focus to its heading so
  // keyboard and screen-reader users are taken to the freshly generated output instead of being left on
  // the submit button with a silent DOM change (GEN-UI-FOCUS-009). Keyed on the result identity so every
  // regenerate re-focuses; the pe-result-title heading carries tabIndex={-1} to accept programmatic focus.
  useEffect(() => {
    if (result === null) return;
    resultTitleRef.current?.focus();
  }, [result]);

  const handleEnhance = useCallback(async (): Promise<void> => {
    const text = draft.trim();
    if (text.length === 0) {
      setError(t("promptEnhancer.error.enterDraft"));
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    setCopyState("idle");
    setCopyStatus(null);
    const body: PromptEnhancementWireRequest = {
      text,
      missingInformationStrategy: strategy === "assume" ? "assume" : "clarify",
      ...(groundingContext.hasConnectedContext
        ? {
            hasConnectedContext: true,
            attachmentCount: groundingContext.attachmentCount,
          }
        : {}),
      ...(profile === "auto"
        ? {}
        : {
            profilePreference: profile as NonNullable<
              PromptEnhancementWireRequest["profilePreference"]
            >,
          }),
      ...(modelId === NO_MODEL ? {} : { modelId }),
    };
    try {
      const response = await enhanceImpl(body, controller.signal);
      if (!controller.signal.aborted) {
        setResult(response);
        setResultGroundingSignature(groundingContext.signature);
      }
    } catch (caught) {
      if (!controller.signal.aborted) setError(describeError(caught, t));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [draft, strategy, groundingContext, profile, modelId, enhanceImpl, t]);

  const handleCopy = useCallback(async (): Promise<void> => {
    if (result === null) return;
    setError(null);
    setCopyState("copying");
    setCopyStatus(t("promptEnhancer.copy.copyingStatus"));
    try {
      await copyTextToClipboard(result.renderedPrompt);
      setCopyState("copied");
      setCopyStatus(t("promptEnhancer.copy.copied"));
    } catch {
      setCopyState("failed");
      setCopyStatus(t("promptEnhancer.copy.failed"));
    }
  }, [result, t]);

  const handleClear = useCallback((): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    setDraft("");
    setResult(null);
    setResultGroundingSignature(null);
    setLoading(false);
    setError(null);
    setCopyState("idle");
    setCopyStatus(null);
    draftInputRef.current?.focus();
  }, []);

  const modelSections = [
    {
      options: [
        { value: NO_MODEL, label: t("promptEnhancer.model.deterministicOnly") },
        ...models.map((model) => ({ value: model.id, label: model.id })),
      ],
    },
  ];
  const draftLength = draft.trim().length;
  const statusText = t(promptEnhancerStatusKey(loading, draftLength));
  const hasWorkspaceContent =
    draftLength > 0 ||
    result !== null ||
    loading ||
    error !== null ||
    copyState !== "idle" ||
    copyStatus !== null;
  const resultGroundingContextChanged =
    result !== null &&
    resultGroundingSignature !== null &&
    resultGroundingSignature !== groundingContext.signature;

  return (
    <div className="pe-panel" data-testid="prompt-enhancer-panel">
      <div className="pe-header" data-testid="pe-header">
        <span className="pe-header-icon" aria-hidden="true">
          <SparkIcon size={18} />
        </span>
        <div className="pe-header-copy">
          <p className="pe-eyebrow">{t("promptEnhancer.header.eyebrow")}</p>
          <h3 className="pe-title">{t("promptEnhancer.header.title")}</h3>
        </div>
        <span className="pe-header-chip">{t("promptEnhancer.header.reviewBeforeUse")}</span>
      </div>

      <form
        className="pe-form"
        onSubmit={(event) => {
          event.preventDefault();
          void handleEnhance();
        }}
      >
        <div className="pe-draft-card">
          <div className="pe-field-head">
            <label className="pe-label" htmlFor={draftId}>
              {t("promptEnhancer.field.rawPrompt")}
            </label>
            <span className="pe-counter" id={draftHintId}>
              {t("promptEnhancer.analysis.chars", { count: draftLength })}
            </span>
          </div>
          <textarea
            ref={draftInputRef}
            id={draftId}
            className="pe-draft"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            rows={8}
            placeholder={t("promptEnhancer.field.draftPlaceholder")}
            aria-describedby={error === null ? draftHintId : `${draftHintId} ${errorId}`}
          />
        </div>

        <aside className="pe-controls-card" aria-label={t("promptEnhancer.controls.ariaLabel")}>
          <div className="pe-controls">
            <div className="pe-control">
              <span className="pe-label" aria-hidden="true">
                {t("promptEnhancer.analysis.profile")}
              </span>
              <KeikoSelect
                value={profile}
                ariaLabel={t("promptEnhancer.analysis.profile")}
                onValueChange={setProfile}
                sections={[
                  {
                    options: PROFILE_VALUES.map((value) => ({
                      value,
                      label: t(`promptEnhancer.profile.${value}`),
                    })),
                  },
                ]}
                triggerClassName="pe-select"
                menuClassName="pe-select-menu"
              />
            </div>
            <div className="pe-control">
              <span className="pe-label" aria-hidden="true">
                {t("promptEnhancer.controls.missingInformation")}
              </span>
              <KeikoSelect
                value={strategy}
                ariaLabel={t("promptEnhancer.controls.missingInformation")}
                onValueChange={setStrategy}
                sections={[
                  {
                    options: STRATEGY_VALUES.map((value) => ({
                      value,
                      label: t(`promptEnhancer.strategy.${value}`),
                    })),
                  },
                ]}
                triggerClassName="pe-select"
                menuClassName="pe-select-menu"
              />
            </div>
            <div className="pe-control">
              <span className="pe-label" aria-hidden="true">
                {t("promptEnhancer.controls.model")}
              </span>
              <KeikoSelect
                value={modelId}
                ariaLabel={t("promptEnhancer.controls.model")}
                onValueChange={setModelId}
                sections={modelSections}
                triggerClassName="pe-select"
                menuClassName="pe-select-menu"
              />
            </div>
          </div>

          <div
            className="pe-grounding-context"
            data-connected={groundingContext.hasConnectedContext ? "true" : "false"}
            data-testid="pe-grounding-context"
          >
            <span className="pe-routing-icon" aria-hidden="true">
              <LayersIcon size={14} />
            </span>
            <span>
              <span className="pe-context-label">{t("promptEnhancer.context.title")}</span>
              <strong>{groundingContext.label}</strong>
            </span>
          </div>
          {resultGroundingContextChanged ? (
            <p className="pe-context-stale" role="status" aria-live="polite">
              {t("promptEnhancer.context.changed")}
            </p>
          ) : null}

          <div className="pe-command-row">
            <button
              type="submit"
              className="pe-button pe-button-primary pe-enhance"
              disabled={loading || draftLength === 0}
            >
              <SparkIcon size={15} />
              <span>
                {loading
                  ? t("promptEnhancer.action.enhancing")
                  : t("promptEnhancer.action.enhance")}
              </span>
            </button>
            <button
              type="button"
              className="pe-button pe-button-secondary pe-clear"
              onClick={handleClear}
              disabled={!hasWorkspaceContent}
              aria-label={t("promptEnhancer.action.clearAriaLabel")}
            >
              <ResetIcon size={15} />
              <span>{t("promptEnhancer.action.clear")}</span>
            </button>
          </div>
          <p className="pe-status" role="status" aria-live="polite">
            {statusText}
          </p>
        </aside>
      </form>

      {error !== null ? (
        <p className="pe-error" role="alert" id={errorId}>
          {error}
        </p>
      ) : null}

      {result !== null ? (
        <div className="pe-result" data-testid="pe-result">
          <div className="pe-result-head">
            <div>
              <p className="pe-eyebrow">{t("promptEnhancer.result.eyebrow")}</p>
              <h4 className="pe-result-title" ref={resultTitleRef} tabIndex={-1}>
                {t("promptEnhancer.result.title")}
              </h4>
            </div>
            <ModelRoutingBanner routing={result.modelRouting} t={t} />
          </div>
          <AnalysisSummary result={result} t={t} />

          <Section title={t("promptEnhancer.rendered.title")}>
            <pre
              className="pe-rendered"
              aria-label={t("promptEnhancer.rendered.ariaLabel")}
              data-text-selectable="true"
            >
              {result.renderedPrompt}
            </pre>
            <div className="pe-actions">
              {/* <output> owns role=status, so the success branch needs no role at all; the
                  failure branch keeps its explicit role=alert override. NATIVE_BLOCK_STYLE
                  restores the block box the <p> had (#2721). */}
              {copyStatus !== null ? (
                <output
                  className={`pe-copy-status pe-copy-status-${copyState}`}
                  style={NATIVE_BLOCK_STYLE}
                  role={copyState === "failed" ? "alert" : undefined}
                  aria-live="polite"
                >
                  {copyStatus}
                </output>
              ) : null}
              <button
                type="button"
                className="pe-button pe-button-secondary pe-copy"
                disabled={copyState === "copying"}
                onClick={() => {
                  void handleCopy();
                }}
              >
                <FileIcon size={15} />
                <span>
                  {copyState === "copying"
                    ? t("promptEnhancer.action.copying")
                    : t("promptEnhancer.action.copy")}
                </span>
              </button>
            </div>
          </Section>

          <div className="pe-review-grid">
            <SafetyPanel safety={result.safety} t={t} />
            <GroundingPanel
              plan={result.enhancedPrompt.groundingPlan}
              readiness={result.groundingReadiness}
              t={t}
            />
          </div>
          <BaselineNotice routing={result.modelRouting} t={t} />
          <EnhancedPromptSections result={result} t={t} />
          <CandidateScorecards candidates={result.candidates} t={t} />
          <CandidateRejections rejected={result.candidates.rejected} t={t} />
          <EvidencePanel
            evidence={result.evidence}
            fingerprint={result.inputFingerprintSha256}
            t={t}
          />
        </div>
      ) : (
        <div className="pe-empty-state" aria-label={t("promptEnhancer.empty.ariaLabel")}>
          <LayersIcon size={18} />
          <span>{t("promptEnhancer.empty.message")}</span>
        </div>
      )}
    </div>
  );
}
