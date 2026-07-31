// Prompt Enhancer validate stage (Epic #1307, Issue #1313; ADR-0044 §4/§5/§7).
//
// The validate stage is the authority gate of the enhancer lifecycle. It composes two deterministic
// signals into one wire-safe `PromptSafetyAssessment`:
//   1. the STRUCTURAL assessment from `keiko-contracts` (required safeguards present; AC1/AC2/AC5,
//      no-authority, no-disclosure, output validation; trusted-section defense in depth), and
//   2. the AUTHORITATIVE text-level detection from `keiko-security` (`detectPromptInjectionSignals`)
//      run over (a) the candidate's TRUSTED sections — any injected/override/authority/secret content
//      there is a blocking rejection (AC3), and (b) the UNTRUSTED user input — recorded for the audit
//      trail and escalated to human review when an attack is detected, but never blocking, because the
//      generated prompt isolates the input as data (AC2: untrusted content cannot override).
//
// Two entry points, one rule set. `assessPromptSafety` assesses a structured candidate;
// `assessPromptTextSafety` assesses a prompt that exists only as text (a model-refined prompt), so the
// stage can always run on the artefact that is actually RETURNED rather than on a candidate a later
// stage supersedes (ADR-0044 §5). Both share `assessTrustedProjection`, so neither can be served by a
// weaker variant of the trusted-channel scan.
//
// The model gateway is allowed to depend on {contracts, security} (ADR-0019), so this is the natural
// home for the stage that needs both — mirroring how the QI dispatch primitives live here. The stage
// makes NO model call and grants NO authority (ADR-0044 §4): it produces an assessment artefact only.
//
// Determinism: pure. No IO, clock, or randomness.

import {
  assessEnhancedPromptStructuralSafety,
  collectProhibitedPromptTextFindings,
  leastPrivilegeForAnalysis,
  requiresHumanReviewForAnalysis,
  summarizePromptSafety,
  PROMPT_ENHANCER_SCHEMA_VERSION,
  PROMPT_SAFETY_VIOLATION_DETAILS,
  type EnhancedPrompt,
  type EnhancedPromptId,
  type LeastPrivilegeConstraint,
  type PromptSafetyAssessment,
  type PromptSafetyFinding,
  type PromptSafetyRuleId,
  type PromptSafetySeverity,
  type PromptSafetyViolationCode,
  type PromptTaskAnalysis,
  type RawPromptInput,
} from "@oscharko-dev/keiko-contracts";
import {
  detectPromptInjectionSignals,
  type PromptInjectionSignal,
  type PromptInjectionSignalCode,
} from "@oscharko-dev/keiko-security";
import type { PromptCandidate } from "./candidates.js";

// How each injection signal maps onto the shared safety-finding vocabulary.
interface SignalMapping {
  readonly code: PromptSafetyViolationCode;
  readonly ruleId: PromptSafetyRuleId;
}

const SIGNAL_MAPPING: Readonly<Record<PromptInjectionSignalCode, SignalMapping>> = {
  "instruction-override": {
    code: "untrusted-instruction-override",
    ruleId: "no-manipulative-or-injected-instructions",
  },
  "system-prompt-disclosure": {
    code: "system-prompt-disclosure",
    ruleId: "no-secret-or-system-prompt-disclosure",
  },
  "secret-exfiltration": {
    code: "secret-request",
    ruleId: "no-secret-or-system-prompt-disclosure",
  },
  "tool-authority-request": { code: "capability-grant-claim", ruleId: "no-authority-grant" },
  "egress-request": { code: "capability-grant-claim", ruleId: "no-authority-grant" },
  "manipulative-framing": {
    code: "manipulative-instruction",
    ruleId: "no-manipulative-or-injected-instructions",
  },
  "embedded-secret-material": {
    code: "secret-request",
    ruleId: "no-secret-or-system-prompt-disclosure",
  },
};

const SEVERITY_RANK: Readonly<Record<PromptSafetySeverity, number>> = {
  info: 0,
  warning: 1,
  blocking: 2,
};

export interface AssessPromptSafetyArgs {
  readonly prompt: EnhancedPrompt;
  readonly analysis: PromptTaskAnalysis;
  // The original untrusted draft. Scanned for injection signals recorded as audit evidence; never
  // interpolated into the trusted sections (the generator already isolated it).
  readonly input: RawPromptInput;
}

// The trusted instruction sections of a prompt, joined for the security scan. Excludes `input`, which
// is the untrusted channel scanned separately.
function trustedSectionsText(prompt: EnhancedPrompt): string {
  return [
    prompt.role,
    prompt.goal,
    ...prompt.context,
    ...prompt.taskDecomposition,
    ...prompt.constraints,
    ...prompt.groundingRules,
    ...prompt.qualityCriteria,
    ...prompt.uncertaintyHandling,
    ...prompt.safetyRules,
  ].join("\n");
}

function findingFor(
  signal: PromptInjectionSignal,
  severity: PromptSafetySeverity,
): PromptSafetyFinding {
  const mapping = SIGNAL_MAPPING[signal.code];
  return {
    code: mapping.code,
    ruleId: mapping.ruleId,
    severity,
    detail: PROMPT_SAFETY_VIOLATION_DETAILS[mapping.code],
  };
}

// Deduplicate findings by violation code, keeping the most severe instance. Keeps the assessment
// auditable without redundant rows when both the structural and security passes flag the same concern.
function dedupeFindings(findings: readonly PromptSafetyFinding[]): readonly PromptSafetyFinding[] {
  const byCode = new Map<PromptSafetyViolationCode, PromptSafetyFinding>();
  for (const finding of findings) {
    const existing = byCode.get(finding.code);
    if (
      existing === undefined ||
      SEVERITY_RANK[finding.severity] > SEVERITY_RANK[existing.severity]
    ) {
      byCode.set(finding.code, finding);
    }
  }
  return [...byCode.values()];
}

// One trusted-channel projection of a prompt, plus the untrusted draft it was derived from. The single
// implementation of the validate stage's two text passes, shared by every entry point below so no
// caller can be served by a weaker variant of the rule set.
interface TrustedProjectionArgs {
  readonly promptId: EnhancedPromptId;
  // Everything the downstream assistant will read as instructions.
  readonly trustedText: string;
  // Findings already established about the artefact (structural safeguards, prohibited claims).
  readonly priorFindings: readonly PromptSafetyFinding[];
  readonly requiresReview: boolean;
  readonly leastPrivilege: readonly LeastPrivilegeConstraint[];
  readonly input: RawPromptInput;
}

function assessTrustedProjection(args: TrustedProjectionArgs): PromptSafetyAssessment {
  // (a) Trusted-channel scan: any unsafe signal here is a blocking rejection (a safe prompt never
  // contains it; a forged, tampered, or model-authored candidate can).
  const trustedFindings = detectPromptInjectionSignals(args.trustedText).map((signal) =>
    findingFor(signal, "blocking"),
  );

  // (b) Untrusted-input scan: recorded for the audit trail. Critical attack attempts escalate to human
  // review; nothing here is blocking because the prompt isolates the input as data.
  const inputSignals = detectPromptInjectionSignals(args.input.text);
  const inputFindings = inputSignals.map((signal) =>
    findingFor(signal, signal.severity === "critical" ? "warning" : "info"),
  );
  const inputAttackDetected = inputSignals.some((signal) => signal.severity === "critical");

  const findings = dedupeFindings([...args.priorFindings, ...trustedFindings, ...inputFindings]);
  const requiresHumanReview = args.requiresReview || inputAttackDetected;
  const { decision, verificationStatus } = summarizePromptSafety(findings, requiresHumanReview);

  return {
    schemaVersion: PROMPT_ENHANCER_SCHEMA_VERSION,
    promptId: args.promptId,
    decision,
    requiresHumanReview,
    verificationStatus,
    findings,
    leastPrivilege: withHumanApproval(args.leastPrivilege, requiresHumanReview),
  };
}

/**
 * Assess the safety of one Enhanced Prompt against the full validate-stage rule set. Pure. Combines
 * the contracts structural assessment with the keiko-security text detector over the trusted sections
 * (blocking on any injected/authority/secret content — AC3) and over the untrusted input (recorded as
 * audit evidence; escalates to human review on a critical attack but never blocks — AC2). Returns a
 * wire-safe `PromptSafetyAssessment` that is content-free and grants no authority.
 */
export function assessPromptSafety(args: AssessPromptSafetyArgs): PromptSafetyAssessment {
  const { prompt, analysis, input } = args;
  const structural = assessEnhancedPromptStructuralSafety(prompt, analysis);
  return assessTrustedProjection({
    promptId: prompt.promptId,
    trustedText: trustedSectionsText(prompt),
    priorFindings: structural.findings,
    requiresReview: structural.requiresHumanReview,
    leastPrivilege: structural.leastPrivilege,
    input,
  });
}

export interface AssessPromptTextSafetyArgs {
  // The id of the artefact the assessment describes; it MUST be the id the surface reports for the
  // text below, so an assessment can never be read as evidence about a different prompt.
  readonly promptId: EnhancedPromptId;
  // The exact prompt text that will be returned to the user and persisted as evidence.
  readonly promptText: string;
  readonly analysis: PromptTaskAnalysis;
  // The original untrusted draft, scanned exactly as in `assessPromptSafety`.
  readonly input: RawPromptInput;
}

/**
 * Assess the safety of a prompt that exists only as TEXT — a model-refined prompt with no section
 * structure to walk. Pure.
 *
 * ADR-0044 §5 requires the validate stage to reject a prompt that claims tool/secret/egress authority,
 * and states that redaction never substitutes for it. The stage must therefore run on the text that is
 * actually handed to the user: a structured candidate that a later stage supersedes proves nothing
 * about what was returned. Because unstructured text carries no marked untrusted region, ALL of it is
 * the trusted channel and is held to exactly the trusted-channel standard `assessPromptSafety` applies
 * — the same detector, the same blocking severity, the same cue vocabulary. Structural safeguard
 * presence is not asserted here: it is a property of the generator's own output shape, which this text
 * does not have. Human-review and least-privilege posture come from the analysis, so a risky task keeps
 * its review requirement no matter who wrote the words.
 */
export function assessPromptTextSafety(args: AssessPromptTextSafetyArgs): PromptSafetyAssessment {
  return assessTrustedProjection({
    promptId: args.promptId,
    trustedText: args.promptText,
    priorFindings: collectProhibitedPromptTextFindings(args.promptText),
    requiresReview: requiresHumanReviewForAnalysis(args.analysis),
    leastPrivilege: leastPrivilegeForAnalysis(args.analysis),
    input: args.input,
  });
}

function withHumanApproval(
  base: readonly LeastPrivilegeConstraint[],
  requiresHumanReview: boolean,
): readonly LeastPrivilegeConstraint[] {
  if (!requiresHumanReview || base.includes("require-human-approval")) {
    return base;
  }
  return [...base, "require-human-approval"];
}

export interface ScreenedPromptCandidate {
  readonly candidate: PromptCandidate;
  readonly assessment: PromptSafetyAssessment;
}

export interface CandidateSafetyScreen {
  // Candidates whose assessment is not `rejected` (accepted or requires-human-review). Usable, with
  // any review requirement carried on the assessment.
  readonly safe: readonly ScreenedPromptCandidate[];
  // Candidates rejected by the validate stage (a blocking safety finding); excluded from selection (AC3).
  readonly rejected: readonly ScreenedPromptCandidate[];
}

/**
 * Screen a generated candidate set through the validate stage (AC3 — candidates that add hidden
 * assumptions, unapproved tool actions, secret requests, or manipulative instructions are rejected).
 * Pure. Each candidate is assessed independently; the result partitions them into a usable `safe` set
 * (decision !== "rejected") and a `rejected` set, each carrying its assessment for the audit trail.
 */
export function screenCandidatesForSafety(
  candidates: readonly PromptCandidate[],
  analysis: PromptTaskAnalysis,
  input: RawPromptInput,
): CandidateSafetyScreen {
  const safe: ScreenedPromptCandidate[] = [];
  const rejected: ScreenedPromptCandidate[] = [];
  for (const candidate of candidates) {
    const assessment = assessPromptSafety({ prompt: candidate.prompt, analysis, input });
    const screened: ScreenedPromptCandidate = { candidate, assessment };
    if (assessment.decision === "rejected") {
      rejected.push(screened);
    } else {
      safe.push(screened);
    }
  }
  return { safe, rejected };
}
