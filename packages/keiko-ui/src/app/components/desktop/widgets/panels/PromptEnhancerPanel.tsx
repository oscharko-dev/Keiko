"use client";

// Prompt Enhancer panel — the governed UI workflow surface (Epic #1307, Issue #1314; ADR-0044 §1
// "Governed UI surface (PromptEnhancerPanel sibling of GroundedAnswerPanel)"). The first screen IS the
// workflow: a dense form (raw draft → profile + missing-info strategy → optional readiness model) plus
// a structured, reviewable result (every Enhanced Prompt section, the grounding plan, safety rules and
// warnings, the output schema, quality criteria, and the candidate scorecards). The generated prompt is
// data for review and copy/export — it is never executed from here (AC5). Enhancement is deterministic
// and provider-neutral; the optional model only resolves dispatch readiness through the Model Gateway
// (AC3). No secret, raw private log, or hidden system prompt is shown (the server redacts on the wire,
// AC4).

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { enhancePrompt, fetchModels } from "@/lib/api";
import { ApiError } from "@/lib/api";
import type {
  ModelCapability,
  PromptEnhancementWireRequest,
  PromptEnhancementWireResponse,
} from "@/lib/types";
import { Icons } from "../../Icons";
import KeikoSelect from "../../KeikoSelect";
import { buildConnectedRunSources } from "../quality-intelligence/connectedSources";

const PROFILE_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "auto", label: "Auto (recommended)" },
  { value: "fast", label: "Fast" },
  { value: "precise", label: "Precise" },
  { value: "research", label: "Research" },
  { value: "creative", label: "Creative" },
  { value: "technical", label: "Technical" },
  { value: "safety-critical", label: "Safety-critical" },
  { value: "agentic", label: "Agentic" },
];

const STRATEGY_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "clarify", label: "Ask clarifying questions" },
  { value: "assume", label: "State explicit assumptions" },
];

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

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.message} (${error.code})`;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "Request cancelled.";
  }
  return "Prompt enhancement failed. Please try again.";
}

function humanizeToken(value: string): string {
  return value.replaceAll("-", " ");
}

function summarizeConnectedContext({
  connectedRoot,
  connectedFilePath,
  connectedRoots,
}: ConnectedContextInput): GroundingContextSummary {
  const sources = buildConnectedRunSources({
    connectedRoot: connectedRoot ?? null,
    connectedFilePath: connectedFilePath ?? null,
    connectedRoots,
  });
  if (sources.length === 0) {
    return {
      hasConnectedContext: false,
      attachmentCount: 0,
      label: "No connected Files source",
      signature: "none",
    };
  }
  const labels = sources.map((source) => source.label);
  const label =
    labels.length === 1 ? labels[0] ?? "Connected source" : `${labels.length.toString()} connected sources`;
  return {
    hasConnectedContext: true,
    attachmentCount: sources.length,
    label,
    signature: JSON.stringify(sources),
  };
}

async function writeTextWithFallback(text: string): Promise<void> {
  const writeText =
    typeof navigator === "undefined" ? undefined : navigator.clipboard?.writeText;
  if (writeText !== undefined && navigator.clipboard !== undefined) {
    try {
      await writeText.call(navigator.clipboard, text);
      return;
    } catch {
      // Fall through to the selection-backed copy path below.
    }
  }

  if (typeof document === "undefined" || document.body === null) {
    throw new Error("clipboard-unavailable");
  }

  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto -9999px";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    const copied = typeof document.execCommand === "function" && document.execCommand("copy");
    if (!copied) throw new Error("clipboard-fallback-failed");
  } finally {
    textarea.remove();
    previousFocus?.focus();
  }
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

function AnalysisSummary({
  result,
}: {
  readonly result: PromptEnhancementWireResponse;
}): ReactNode {
  const items = [
    ["Task", humanizeToken(result.analysis.taskClass)],
    ["Domain", humanizeToken(result.analysis.domain)],
    ["Criticality", humanizeToken(result.analysis.criticality)],
    ["Profile", humanizeToken(result.analysis.recommendedProfile)],
    ["Input", `${result.analysis.normalizedInputLength.toLocaleString("en-US")} chars`],
  ] as const;
  return (
    <dl className="pe-analysis" aria-label="Prompt enhancement analysis">
      {items.map(([label, value]) => (
        <div className="pe-analysis-item" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ModelRoutingBanner({
  routing,
}: {
  readonly routing: PromptEnhancementWireResponse["modelRouting"];
}): ReactNode {
  const tone =
    routing.availability === "available"
      ? "ok"
      : routing.availability === "unavailable"
        ? "warn"
        : "muted";
  const label =
    routing.availability === "available"
      ? `Model ready: ${routing.resolvedModelId ?? ""}`
      : routing.availability === "unavailable"
        ? "Selected model unavailable - enhancement still completed deterministically"
        : "No downstream model selected - enhancement is provider-neutral";
  return (
    <div
      className={`pe-routing pe-routing-${tone}`}
      data-testid="pe-model-routing"
      role="status"
      aria-live="polite"
    >
      <span className="pe-routing-icon" aria-hidden="true">
        {tone === "ok" ? <Icons.check size={14} /> : <Icons.info size={14} />}
      </span>
      <span>{label}</span>
    </div>
  );
}

function SafetyPanel({
  safety,
}: {
  readonly safety: PromptEnhancementWireResponse["safety"];
}): ReactNode {
  const reviewing = safety.requiresHumanReview;
  return (
    <Section title="Safety">
      <dl className="pe-safety-summary" data-testid="pe-safety-decision">
        <div>
          <dt>Decision</dt>
          <dd>{humanizeToken(safety.decision)}</dd>
        </div>
        <div>
          <dt>Verification</dt>
          <dd>{humanizeToken(safety.verificationStatus)}</dd>
        </div>
        <div>
          <dt>Human review</dt>
          <dd>{reviewing ? "required" : "not required"}</dd>
        </div>
      </dl>
      {reviewing ? (
        <p className="pe-safety-warning" role="alert">
          This prompt requires human review before any downstream use.
        </p>
      ) : null}
      {safety.findings.length > 0 ? (
        <>
          <h5 className="pe-subhead">Safety findings</h5>
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
          <h5 className="pe-subhead">Least-privilege constraints</h5>
          <StringList items={[...safety.leastPrivilege]} />
        </>
      ) : null}
    </Section>
  );
}

function GroundingPanel({
  plan,
  readiness,
}: {
  readonly plan: PromptEnhancementWireResponse["enhancedPrompt"]["groundingPlan"];
  readonly readiness: PromptEnhancementWireResponse["groundingReadiness"];
}): ReactNode {
  const readinessText =
    readiness.status === "ready"
      ? "Grounding readiness: connected context available"
      : readiness.status === "unavailable"
        ? "Grounding readiness: unavailable - connect a Files window and regenerate to mark this prompt grounding-ready."
        : "Grounding readiness: not required";
  return (
    <Section title="Grounding plan">
      <div
        className={`pe-grounding-readiness pe-grounding-readiness-${readiness.status}`}
        data-testid="pe-grounding-readiness"
        role="status"
        aria-live="polite"
      >
        <span className="pe-routing-icon" aria-hidden="true">
          <Icons.info size={14} />
        </span>
        <span>{readinessText}</span>
      </div>
      <p className="pe-grounding-meta">
        Strategy: <strong>{humanizeToken(plan.strategy)}</strong> /{" "}
        {plan.required ? "required" : "optional"} / citations:{" "}
        {humanizeToken(plan.citation.discipline)} ({humanizeToken(plan.citation.granularity)})
      </p>
      {plan.sourcePriority.length > 0 ? (
        <>
          <h5 className="pe-subhead">Source priority</h5>
          <ol className="pe-list">
            {plan.sourcePriority.map((source) => (
              <li key={source.source}>
                {source.source}
                {source.required ? " (required)" : ""}
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
}: {
  readonly evidence: PromptEnhancementWireResponse["evidence"];
  readonly fingerprint: string;
}): ReactNode {
  return (
    <p className="pe-evidence" data-testid="pe-evidence">
      Evidence fingerprint: {fingerprint.slice(0, 16)}...
      {evidence.status === "recorded" && evidence.runId !== undefined ? (
        <>
          {" "}
          Manifest:{" "}
          <a
            href={evidence.manifestUrl ?? "#"}
            target="_blank"
            rel="noreferrer"
            aria-label={`Prompt enhancement evidence manifest ${evidence.runId}`}
          >
            {evidence.runId}
          </a>
        </>
      ) : (
        " Manifest not recorded."
      )}
    </p>
  );
}

function CandidateScorecards({
  candidates,
}: {
  readonly candidates: PromptEnhancementWireResponse["candidates"];
}): ReactNode {
  return (
    <Section title="Candidate scorecards">
      <div className="c-tablewrap">
        <div className="c-tablescroll">
          <table className="c-table responsive pe-scorecards" data-testid="pe-scorecards">
            <thead>
              <tr>
                <th scope="col">Profile</th>
                <th scope="col" className="num">
                  Score
                </th>
                <th scope="col" className="num">
                  Tokens
                </th>
                <th scope="col">Winner</th>
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
                    <td className="num" data-label="Score">
                      {scorecard.aggregateScore.toFixed(3)}
                    </td>
                    <td className="num" data-label="Tokens">
                      {scorecard.estimatedTokens.toLocaleString("en-US")}
                    </td>
                    <td data-label="Winner">
                      {winner ? (
                        <span className="pe-winner-mark" aria-label="Winner">
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

function EnhancedPromptSections({
  result,
}: {
  readonly result: PromptEnhancementWireResponse;
}): ReactNode {
  const prompt = result.enhancedPrompt;
  const missing = result.analysis.missingContext.map((item) =>
    item.kind === "assumption" ? item.statement : item.question,
  );
  return (
    <div className="pe-section-grid">
      <Section title="Role">
        <p>{prompt.role}</p>
      </Section>
      <Section title="Objective">
        <p>{prompt.goal}</p>
      </Section>
      <Section title="Context">
        <StringList items={[...prompt.context]} empty="No additional context." />
      </Section>
      <Section
        title={
          result.analysis.missingContext.some((m) => m.kind === "assumption")
            ? "Assumptions"
            : "Clarification questions"
        }
      >
        <StringList items={missing} empty="No clarifications or assumptions needed." />
      </Section>
      <Section title="Steps">
        <StringList items={[...prompt.taskDecomposition]} />
      </Section>
      <Section title="Constraints">
        <StringList items={[...prompt.constraints]} />
      </Section>
      <Section title="Output schema">
        <p>
          Format: <strong>{prompt.outputSchema.format}</strong>
          {prompt.outputSchema.structured ? " / structured" : ""}
        </p>
        <StringList items={[...prompt.outputSchema.hints]} />
      </Section>
      <Section title="Quality criteria">
        <StringList items={[...prompt.qualityCriteria]} />
      </Section>
      <Section title="Uncertainty handling">
        <StringList items={[...prompt.uncertaintyHandling]} />
      </Section>
      <Section title="Safety rules">
        <StringList items={[...prompt.safetyRules]} />
      </Section>
    </div>
  );
}

export function PromptEnhancerPanel({
  connectedRoot = null,
  connectedFilePath = null,
  connectedRoots,
  enhanceImpl = enhancePrompt,
  fetchModelsImpl = fetchModels,
}: PromptEnhancerPanelProps = {}): ReactNode {
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
        // Readiness model selection is optional; a config-less workspace simply offers no models.
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
    () => summarizeConnectedContext({ connectedRoot, connectedFilePath, connectedRoots }),
    [connectedRoot, connectedFilePath, connectedRoots],
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

  const handleEnhance = useCallback(async (): Promise<void> => {
    const text = draft.trim();
    if (text.length === 0) {
      setError("Enter a prompt draft to enhance.");
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
      if (!controller.signal.aborted) setError(describeError(caught));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [draft, strategy, groundingContext, profile, modelId, enhanceImpl]);

  const handleCopy = useCallback(async (): Promise<void> => {
    if (result === null) return;
    setError(null);
    setCopyState("copying");
    setCopyStatus("Copying rendered prompt...");
    try {
      await writeTextWithFallback(result.renderedPrompt);
      setCopyState("copied");
      setCopyStatus("Copied to clipboard.");
    } catch {
      setCopyState("failed");
      setCopyStatus("Clipboard access failed. Select text manually and use Cmd/Ctrl+C.");
    }
  }, [result]);

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
        { value: NO_MODEL, label: "Deterministic only (no model)" },
        ...models.map((model) => ({ value: model.id, label: model.id })),
      ],
    },
  ];
  const draftLength = draft.trim().length;
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
          <Icons.spark size={18} />
        </span>
        <div className="pe-header-copy">
          <p className="pe-eyebrow">Governed prompt workspace</p>
          <h3 className="pe-title">Prompt Enhancer</h3>
        </div>
        <span className="pe-header-chip">No execution</span>
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
              Raw prompt
            </label>
            <span className="pe-counter" id={draftHintId}>
              {draftLength.toLocaleString("en-US")} chars
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
            placeholder="Describe the task you want a strong prompt for..."
            aria-describedby={error === null ? draftHintId : `${draftHintId} ${errorId}`}
          />
        </div>

        <aside className="pe-controls-card" aria-label="Enhancement controls">
          <div className="pe-controls">
            <div className="pe-control">
              <span className="pe-label" aria-hidden="true">
                Profile
              </span>
              <KeikoSelect
                value={profile}
                ariaLabel="Profile"
                onValueChange={setProfile}
                sections={[{ options: PROFILE_OPTIONS.map((option) => ({ ...option })) }]}
                triggerClassName="pe-select"
                menuClassName="pe-select-menu"
              />
            </div>
            <div className="pe-control">
              <span className="pe-label" aria-hidden="true">
                Missing information
              </span>
              <KeikoSelect
                value={strategy}
                ariaLabel="Missing information"
                onValueChange={setStrategy}
                sections={[{ options: STRATEGY_OPTIONS.map((option) => ({ ...option })) }]}
                triggerClassName="pe-select"
                menuClassName="pe-select-menu"
              />
            </div>
            <div className="pe-control">
              <span className="pe-label" aria-hidden="true">
                Readiness model
              </span>
              <KeikoSelect
                value={modelId}
                ariaLabel="Readiness model"
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
              <Icons.layers size={14} />
            </span>
            <span>
              <span className="pe-context-label">Grounding context</span>
              <strong>{groundingContext.label}</strong>
            </span>
          </div>
          {resultGroundingContextChanged ? (
            <p className="pe-context-stale" role="status" aria-live="polite">
              Grounding context changed. Regenerate to update this review artifact.
            </p>
          ) : null}

          <div className="pe-command-row">
            <button
              type="submit"
              className="pe-button pe-button-primary pe-enhance"
              disabled={loading || draftLength === 0}
            >
              <Icons.spark size={15} />
              <span>{loading ? "Enhancing..." : "Enhance prompt"}</span>
            </button>
            <button
              type="button"
              className="pe-button pe-button-secondary pe-clear"
              onClick={handleClear}
              disabled={!hasWorkspaceContent}
              aria-label="Clear prompt workspace"
            >
              <Icons.reset size={15} />
              <span>Clear</span>
            </button>
          </div>
          <p className="pe-status" role="status" aria-live="polite">
            {loading ? "Enhancing prompt..." : draftLength === 0 ? "Waiting for draft" : "Ready"}
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
              <p className="pe-eyebrow">Review artifact</p>
              <h4 className="pe-result-title">Enhanced prompt</h4>
            </div>
            <ModelRoutingBanner routing={result.modelRouting} />
          </div>
          <AnalysisSummary result={result} />

          <Section title="Rendered prompt">
            <pre
              className="pe-rendered"
              aria-label="Rendered prompt text"
              data-text-selectable="true"
            >
              {result.renderedPrompt}
            </pre>
            <div className="pe-actions">
              {copyStatus !== null ? (
                <p
                  className={`pe-copy-status pe-copy-status-${copyState}`}
                  role={copyState === "failed" ? "alert" : "status"}
                  aria-live="polite"
                >
                  {copyStatus}
                </p>
              ) : null}
              <button
                type="button"
                className="pe-button pe-button-secondary pe-copy"
                disabled={copyState === "copying"}
                onClick={() => {
                  void handleCopy();
                }}
              >
                <Icons.file size={15} />
                <span>{copyState === "copying" ? "Copying..." : "Copy rendered prompt"}</span>
              </button>
            </div>
          </Section>

          <div className="pe-review-grid">
            <SafetyPanel safety={result.safety} />
            <GroundingPanel
              plan={result.enhancedPrompt.groundingPlan}
              readiness={result.groundingReadiness}
            />
          </div>
          <EnhancedPromptSections result={result} />
          <CandidateScorecards candidates={result.candidates} />
          <EvidencePanel evidence={result.evidence} fingerprint={result.inputFingerprintSha256} />
        </div>
      ) : (
        <div className="pe-empty-state" aria-label="Prompt enhancement empty state">
          <Icons.layers size={18} />
          <span>No enhanced prompt yet.</span>
        </div>
      )}
    </div>
  );
}
