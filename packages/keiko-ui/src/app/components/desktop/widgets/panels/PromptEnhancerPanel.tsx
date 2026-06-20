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

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { enhancePrompt, fetchModels } from "@/lib/api";
import { ApiError } from "@/lib/api";
import type {
  ModelCapability,
  PromptEnhancementWireRequest,
  PromptEnhancementWireResponse,
} from "@/lib/types";
import KeikoSelect from "../../KeikoSelect";

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

export interface PromptEnhancerPanelProps {
  // Test seams: production wires the real BFF calls; tests inject deterministic fakes.
  readonly enhanceImpl?: typeof enhancePrompt;
  readonly fetchModelsImpl?: typeof fetchModels;
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
        ? "Selected model unavailable — enhancement still completed deterministically"
        : "No downstream model selected — enhancement is provider-neutral";
  return (
    <p
      className={`pe-routing pe-routing-${tone}`}
      data-testid="pe-model-routing"
      role="status"
      aria-live="polite"
    >
      {label}
    </p>
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
      <p className="pe-safety-summary" data-testid="pe-safety-decision">
        Decision: <strong>{safety.decision}</strong> · verification: {safety.verificationStatus} ·{" "}
        human review: <strong>{reviewing ? "required" : "not required"}</strong>
      </p>
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
        ? `Grounding readiness: unavailable${readiness.notice === undefined ? "" : ` — ${readiness.notice}`}`
        : "Grounding readiness: not required";
  return (
    <Section title="Grounding plan">
      <p
        className={`pe-grounding-readiness pe-grounding-readiness-${readiness.status}`}
        data-testid="pe-grounding-readiness"
        role={readiness.status === "unavailable" ? "alert" : "status"}
        aria-live="polite"
      >
        {readinessText}
      </p>
      <p className="pe-grounding-meta">
        Strategy: <strong>{plan.strategy}</strong> · {plan.required ? "required" : "optional"} ·
        citations: {plan.citation.discipline} ({plan.citation.granularity})
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
      Evidence fingerprint: {fingerprint.slice(0, 16)}…
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
      <table className="pe-scorecards" data-testid="pe-scorecards">
        <thead>
          <tr>
            <th scope="col">Profile</th>
            <th scope="col">Score</th>
            <th scope="col">Tokens</th>
            <th scope="col">Winner</th>
          </tr>
        </thead>
        <tbody>
          {candidates.scorecards.map((scorecard) => {
            const winner = scorecard.candidateId === candidates.winnerCandidateId;
            return (
              <tr key={scorecard.candidateId} className={winner ? "pe-winner" : undefined}>
                <th scope="row">{scorecard.profile}</th>
                <td>{scorecard.aggregateScore.toFixed(3)}</td>
                <td>{scorecard.estimatedTokens}</td>
                <td>{winner ? "★" : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
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
    <>
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
          {prompt.outputSchema.structured ? " · structured" : ""}
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
    </>
  );
}

export function PromptEnhancerPanel({
  enhanceImpl = enhancePrompt,
  fetchModelsImpl = fetchModels,
}: PromptEnhancerPanelProps = {}): ReactNode {
  const [draft, setDraft] = useState("");
  const [profile, setProfile] = useState("auto");
  const [strategy, setStrategy] = useState("clarify");
  const [modelId, setModelId] = useState(NO_MODEL);
  const [models, setModels] = useState<readonly ModelCapability[]>([]);
  const [result, setResult] = useState<PromptEnhancementWireResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const draftId = useId();
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
    setCopied(false);
    setCopyStatus(null);
    const body: PromptEnhancementWireRequest = {
      text,
      missingInformationStrategy: strategy === "assume" ? "assume" : "clarify",
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
      if (!controller.signal.aborted) setResult(response);
    } catch (caught) {
      if (!controller.signal.aborted) setError(describeError(caught));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [draft, strategy, profile, modelId, enhanceImpl]);

  const handleCopy = useCallback(async (): Promise<void> => {
    if (result === null) return;
    const writeText = navigator.clipboard?.writeText;
    if (writeText === undefined) {
      setError("Clipboard is not available in this browser.");
      return;
    }
    try {
      await writeText.call(navigator.clipboard, result.renderedPrompt);
      setCopied(true);
      setCopyStatus("Rendered prompt copied to clipboard.");
    } catch {
      setError("Could not copy to the clipboard.");
    }
  }, [result]);

  const modelSections = [
    {
      options: [
        { value: NO_MODEL, label: "Deterministic only (no model)" },
        ...models.map((model) => ({ value: model.id, label: model.id })),
      ],
    },
  ];

  return (
    <div className="pe-panel" data-testid="prompt-enhancer-panel">
      <h3 className="pe-title">Prompt Enhancer</h3>
      <p className="pe-intro">
        Turn a raw prompt into a governed, structured Enhanced Prompt. The result is for review and
        copy/export — it is never executed from here.
      </p>

      <div className="pe-form">
        <label className="pe-label" htmlFor={draftId}>
          Raw prompt
        </label>
        <textarea
          id={draftId}
          className="pe-draft"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          rows={5}
          placeholder="Describe the task you want a strong prompt for…"
          aria-describedby={error === null ? undefined : errorId}
        />

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
            />
          </div>
        </div>

        <button
          type="button"
          className="pe-enhance"
          onClick={() => {
            void handleEnhance();
          }}
          disabled={loading || draft.trim().length === 0}
        >
          {loading ? "Enhancing…" : "Enhance prompt"}
        </button>
        {loading ? (
          <p className="pe-status" role="status" aria-live="polite">
            Enhancing prompt…
          </p>
        ) : null}
      </div>

      {error !== null ? (
        <p className="pe-error" role="alert" id={errorId}>
          {error}
        </p>
      ) : null}

      {result !== null ? (
        <div className="pe-result" data-testid="pe-result">
          <ModelRoutingBanner routing={result.modelRouting} />
          <p className="pe-analysis">
            Task: <strong>{result.analysis.taskClass}</strong> · domain: {result.analysis.domain} ·
            criticality: {result.analysis.criticality}
          </p>

          <SafetyPanel safety={result.safety} />
          <EnhancedPromptSections result={result} />
          <GroundingPanel
            plan={result.enhancedPrompt.groundingPlan}
            readiness={result.groundingReadiness}
          />
          <CandidateScorecards candidates={result.candidates} />

          <Section title="Rendered prompt">
            <pre className="pe-rendered" aria-label="Rendered prompt text">
              {result.renderedPrompt}
            </pre>
            <div className="pe-actions">
              <button
                type="button"
                className="pe-copy"
                onClick={() => {
                  void handleCopy();
                }}
              >
                Copy rendered prompt
              </button>
            </div>
            {copied && copyStatus !== null ? (
              <p className="pe-status" role="status" aria-live="polite">
                {copyStatus}
              </p>
            ) : null}
          </Section>

          <EvidencePanel evidence={result.evidence} fingerprint={result.inputFingerprintSha256} />
        </div>
      ) : null}
    </div>
  );
}
