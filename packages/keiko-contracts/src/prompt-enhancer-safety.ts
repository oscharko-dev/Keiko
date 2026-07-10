// Prompt Enhancer safety annotations and the deterministic validate-stage rule model
// (Epic #1307, Issue #1313; ADR-0044 §4/§5/§7).
//
// This module owns the machine-readable safety-annotation shapes and the STRUCTURAL half of the
// validate stage: a pure, deterministic assessment of whether an `EnhancedPrompt` upholds the safety
// invariants the enhancer must never relax — trusted/untrusted channel separation (AC1), untrusted
// content marked and unable to override instructions (AC2), no capability-grant / secret-disclosure
// claims, a human-confirmed authority + least-privilege posture for risky agentic tasks (AC5), and an
// output-validation expectation for structured outputs. The result is a wire-safe
// `PromptSafetyAssessment` the evidence model (#1313, keiko-evidence) and the server (#1314) can
// transmit, persist, and render.
//
// Split of responsibility (ADR-0044 §5 — redaction is distinct from validation): this leaf module
// performs the STRUCTURAL validation derivable from the prompt + analysis alone (presence of required
// safeguards, absence of authority-grant claims in the trusted sections). The AUTHORITATIVE text-level
// detection of prompt injection, secret-exfiltration, and manipulative content in untrusted input
// lives in `keiko-security` and is composed over this assessment by the gateway validate stage
// (`keiko-model-gateway/src/promptEnhancer/validate.ts`); the leaf-package rule (ADR-0019 direction 1)
// forbids importing it here. The findings vocabulary below is the shared closed set both layers emit.
//
// Determinism: pure. No IO, clock, crypto, or randomness. No raw user input is echoed — every finding
// `detail` is a fixed, content-free template. A generated prompt is data, never a capability grant
// (ADR-0044 §4): nothing here can encode or confer tool, secret, egress, or patch authority.

import { stripUnsafeFormatChars } from "./text-safety.js";
import {
  PROMPT_ENHANCER_SCHEMA_VERSION,
  validatePromptEnhancerIdString,
  type EnhancedPrompt,
  type EnhancedPromptId,
  type PromptTaskAnalysis,
} from "./prompt-enhancer.js";
import type { PromptEnhancerValidation } from "./prompt-enhancer-validation.js";

// ─── Safety rules (the validate-stage rule set) ────────────────────────────────────
// The closed set of safety rules the validate stage enforces. Each rule maps to one or more issue
// acceptance criteria and is proved (or violated) by the structural assessor / security detector.
export type PromptSafetyRuleId =
  // AC1 — user input, external context, and tool output are kept in a separate, untrusted channel
  // from trusted instructions and clearly labelled as data.
  | "trusted-untrusted-separation"
  // AC2 — external/retrieved content is marked untrusted and cannot override instructions.
  | "untrusted-content-marked"
  // ADR-0044 §4 — the prompt grants no tool, file, network, or secret authority.
  | "no-authority-grant"
  // Scope — the prompt never discloses secrets, credentials, or system/developer instructions.
  | "no-secret-or-system-prompt-disclosure"
  // AC5 — risky agentic tasks require human review before bounded runtime authority is established.
  | "human-review-for-risky-actions"
  // AC5 — risky tasks carry least-privilege constraints (no self-authorized tool/file/egress/secret use).
  | "least-privilege-tool-access"
  // Scope — structured outputs carry an explicit output-validation expectation.
  | "output-validation-required"
  // AC3 — the trusted sections contain no manipulative, injected, or override instructions.
  | "no-manipulative-or-injected-instructions";

export const PROMPT_SAFETY_RULE_IDS: readonly PromptSafetyRuleId[] = [
  "trusted-untrusted-separation",
  "untrusted-content-marked",
  "no-authority-grant",
  "no-secret-or-system-prompt-disclosure",
  "human-review-for-risky-actions",
  "least-privilege-tool-access",
  "output-validation-required",
  "no-manipulative-or-injected-instructions",
] as const;

// ─── Violation codes (findings vocabulary) ─────────────────────────────────────────
// Closed vocabulary of safety findings. "missing-*" codes mark an ABSENT required safeguard; the
// remaining codes mark a PRESENT prohibited pattern. Shared by the contracts structural assessor and
// the keiko-security text detector so a finding from either layer is uniformly typed and auditable.
export type PromptSafetyViolationCode =
  | "missing-channel-separation"
  | "missing-untrusted-marker"
  | "missing-authority-restriction"
  | "missing-secrecy-rule"
  | "missing-human-review"
  | "missing-least-privilege"
  | "missing-output-validation"
  | "capability-grant-claim"
  | "secret-request"
  | "system-prompt-disclosure"
  | "untrusted-instruction-override"
  | "manipulative-instruction"
  | "hidden-assumption";

export const PROMPT_SAFETY_VIOLATION_CODES: readonly PromptSafetyViolationCode[] = [
  "missing-channel-separation",
  "missing-untrusted-marker",
  "missing-authority-restriction",
  "missing-secrecy-rule",
  "missing-human-review",
  "missing-least-privilege",
  "missing-output-validation",
  "capability-grant-claim",
  "secret-request",
  "system-prompt-disclosure",
  "untrusted-instruction-override",
  "manipulative-instruction",
  "hidden-assumption",
] as const;

export const isPromptSafetyViolationCode = (value: unknown): value is PromptSafetyViolationCode =>
  typeof value === "string" && (PROMPT_SAFETY_VIOLATION_CODES as readonly string[]).includes(value);

// ─── Severity ──────────────────────────────────────────────────────────────────────
// `blocking` rejects the artefact (validation fail); `warning` is recorded and may down-rank a
// candidate; `info` is recorded for the audit trail only.
export type PromptSafetySeverity = "info" | "warning" | "blocking";

export const PROMPT_SAFETY_SEVERITIES: readonly PromptSafetySeverity[] = [
  "info",
  "warning",
  "blocking",
] as const;

// ─── Least-privilege constraints ────────────────────────────────────────────────────
// Machine-readable, server-enforceable authorities the prompt is NOT permitted to imply. A generated
// prompt always denies all of these by default (ADR-0044 §4); risky agentic tasks additionally require
// human review before a runtime mode and Authority Envelope can authorize side effects (AC5).
export type LeastPrivilegeConstraint =
  | "no-tool-execution"
  | "no-file-write"
  | "no-network-egress"
  | "no-secret-access"
  | "require-human-approval";

export const LEAST_PRIVILEGE_CONSTRAINTS: readonly LeastPrivilegeConstraint[] = [
  "no-tool-execution",
  "no-file-write",
  "no-network-egress",
  "no-secret-access",
  "require-human-approval",
] as const;

// The baseline deny-all posture every generated prompt carries (least privilege by default).
const BASELINE_LEAST_PRIVILEGE: readonly LeastPrivilegeConstraint[] = [
  "no-tool-execution",
  "no-file-write",
  "no-network-egress",
  "no-secret-access",
] as const;

// ─── Decision + verification status ──────────────────────────────────────────────────
export type PromptSafetyDecision = "accepted" | "requires-human-review" | "rejected";

export const PROMPT_SAFETY_DECISIONS: readonly PromptSafetyDecision[] = [
  "accepted",
  "requires-human-review",
  "rejected",
] as const;

// Coarse pass/fail status for the audit trail (AC4 — "verification status"). Derived from `decision`.
export type PromptSafetyVerificationStatus = "passed" | "passed-with-review" | "failed";

export const PROMPT_SAFETY_VERIFICATION_STATUSES: readonly PromptSafetyVerificationStatus[] = [
  "passed",
  "passed-with-review",
  "failed",
] as const;

// ─── Finding + assessment shapes ─────────────────────────────────────────────────────
const SAFETY_DETAIL_MAX_CHARS = 400;

// One safety finding. `detail` is a fixed, content-free template string — it never echoes raw user
// input, retrieved text, or matched secret material (safe-error discipline, ADR-0044 §5).
export interface PromptSafetyFinding {
  readonly code: PromptSafetyViolationCode;
  readonly ruleId: PromptSafetyRuleId;
  readonly severity: PromptSafetySeverity;
  readonly detail: string;
}

// The wire-safe result of the validate stage for one Enhanced Prompt. Provider-neutral and
// content-free by construction; nothing here grants authority.
export interface PromptSafetyAssessment {
  readonly schemaVersion: typeof PROMPT_ENHANCER_SCHEMA_VERSION;
  readonly promptId: EnhancedPromptId;
  readonly decision: PromptSafetyDecision;
  readonly requiresHumanReview: boolean;
  readonly verificationStatus: PromptSafetyVerificationStatus;
  readonly findings: readonly PromptSafetyFinding[];
  readonly leastPrivilege: readonly LeastPrivilegeConstraint[];
}

// Fixed, content-free detail templates keyed by violation code. Stable strings so the audit trail and
// UI render consistent, never-echoing explanations.
export const PROMPT_SAFETY_VIOLATION_DETAILS: Readonly<Record<PromptSafetyViolationCode, string>> =
  {
    "missing-channel-separation":
      "The prompt does not instruct the model to treat the user Input section as data rather than instructions.",
    "missing-untrusted-marker":
      "The grounding plan does not mark external and retrieved content as untrusted.",
    "missing-authority-restriction":
      "The prompt does not state that it grants no tool, file, network, or secret authority.",
    "missing-secrecy-rule":
      "The prompt does not forbid disclosing secrets, credentials, or system instructions.",
    "missing-human-review":
      "A risky agentic prompt does not require human-confirmed runtime authority and policy-driven approval for side effects.",
    "missing-least-privilege":
      "A risky agentic prompt does not constrain the model to least-privilege, approval-gated actions.",
    "missing-output-validation":
      "A structured-output prompt does not require the response to conform to the declared format.",
    "capability-grant-claim":
      "A trusted section appears to grant the model tool, file, network, or secret authority.",
    "secret-request":
      "Content requests secrets, credentials, environment values, or system instructions.",
    "system-prompt-disclosure": "Content requests disclosure of the system or developer prompt.",
    "untrusted-instruction-override":
      "Content attempts to override or ignore the trusted instructions.",
    "manipulative-instruction":
      "Content uses manipulative framing or role reassignment to alter the model's behaviour.",
    "hidden-assumption":
      "A trusted section introduces an unstated assumption not derived from the analysis.",
  };

// ─── Pure predicates ─────────────────────────────────────────────────────────────────
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isMember = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === "string" && (allowed as readonly string[]).includes(value);

const isBoundedSafeText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max && stripUnsafeFormatChars(value) === value;

const containsAll = (haystack: string, needles: readonly string[]): boolean =>
  needles.every((needle) => haystack.includes(needle));

const containsAny = (haystack: string, needles: readonly string[]): boolean =>
  needles.some((needle) => haystack.includes(needle));

// ─── Required-safeguard predicates over the trusted sections ──────────────────────────
// These confirm a generated prompt actually carries the safeguard. They match on robust concept
// keywords, not brittle exact strings, so wording can evolve while the safeguard stays detectable.
const marksInputAsData = (context: readonly string[]): boolean => {
  const text = context.join(" \n ").toLowerCase();
  return containsAll(text, ["input", "data"]) && containsAny(text, ["instruction", "directions"]);
};

const assertsNoAuthority = (safetyRules: readonly string[]): boolean => {
  const text = safetyRules.join(" \n ").toLowerCase();
  return (
    text.includes("not an authorization") ||
    (text.includes("grant") && containsAny(text, ["no tool", "no secret", "no access"]))
  );
};

const forbidsSecretDisclosure = (safetyRules: readonly string[]): boolean => {
  const text = safetyRules.join(" \n ").toLowerCase();
  return (
    containsAny(text, ["do not reveal", "never reveal", "do not disclose"]) &&
    containsAny(text, ["secret", "credential", "system instruction", "system prompt"])
  );
};

const requiresHumanApprovalRule = (safetyRules: readonly string[]): boolean => {
  const text = safetyRules.join(" \n ").toLowerCase();
  return containsAny(text, ["human approval", "explicit approval", "explicit human"]);
};

// Distinct from the human-approval rule: the least-privilege constraint instructs the model not to
// *assume* tool/file/network authority in the first place. Matched on its own phrasing so the two
// safeguards are checked independently (a tampered prompt could drop one but keep the other).
const carriesLeastPrivilegeConstraint = (
  constraints: readonly string[],
  safetyRules: readonly string[],
): boolean => {
  const text = [...constraints, ...safetyRules].join(" \n ").toLowerCase();
  return (
    text.includes("do not assume authority") ||
    text.includes("least privilege") ||
    text.includes("least-privilege")
  );
};

const requiresOutputConformance = (
  constraints: readonly string[],
  qualityCriteria: readonly string[],
): boolean => {
  const text = [...constraints, ...qualityCriteria].join(" \n ").toLowerCase();
  return containsAny(text, ["required output format", "required format", "conform"]);
};

// ─── Prohibited-pattern predicates over the trusted sections (defense in depth, AC3) ──
// A correctly generated prompt never contains these in its TRUSTED sections; a forged or tampered
// candidate would. The authoritative detection over UNTRUSTED input lives in keiko-security.
const TRUSTED_AUTHORITY_GRANT_CUES: readonly string[] = [
  "grant yourself",
  "give yourself access",
  "you may run any",
  "you are authorized to run",
  "you can execute any",
];
const TRUSTED_OVERRIDE_CUES: readonly string[] = [
  "ignore previous instructions",
  "ignore all previous",
  "disregard previous",
  "disregard the above",
  "ignore the above",
  "ignore the safety rules",
];
const TRUSTED_DISCLOSURE_CUES: readonly string[] = [
  "reveal the system prompt",
  "print the system prompt",
  "reveal your system prompt",
  "disclose the system prompt",
];
const TRUSTED_ASSUMPTION_PREFIX = "Assumption: ";

// ─── Human-review derivation ──────────────────────────────────────────────────────────
/**
 * Derive whether a task is risky enough to require human review before bounded runtime authority is
 * established (AC5). Pure. A task is risky when it is agentic, requests tool/egress authority, or
 * is critical.
 */
export function requiresHumanReviewForAnalysis(analysis: PromptTaskAnalysis): boolean {
  return (
    analysis.criticality === "critical" ||
    analysis.taskClass === "agentic-tool-use" ||
    analysis.riskFlags.includes("tool-authority-requested") ||
    analysis.riskFlags.includes("egress-requested")
  );
}

/**
 * Reduce a finding set and the human-review flag to the decision + verification status. Pure. Shared
 * by the structural assessor and the gateway validate stage (which adds security findings first).
 */
export function summarizePromptSafety(
  findings: readonly PromptSafetyFinding[],
  requiresHumanReview: boolean,
): {
  readonly decision: PromptSafetyDecision;
  readonly verificationStatus: PromptSafetyVerificationStatus;
} {
  if (findings.some((finding) => finding.severity === "blocking")) {
    return { decision: "rejected", verificationStatus: "failed" };
  }
  if (requiresHumanReview) {
    return { decision: "requires-human-review", verificationStatus: "passed-with-review" };
  }
  return { decision: "accepted", verificationStatus: "passed" };
}

/**
 * Compute the least-privilege constraint set for a task. Pure. Always denies tool/file/egress/secret
 * authority (least privilege by default); risky tasks additionally require human-confirmed runtime
 * authority (AC5).
 */
export function leastPrivilegeForAnalysis(
  analysis: PromptTaskAnalysis,
): readonly LeastPrivilegeConstraint[] {
  return requiresHumanReviewForAnalysis(analysis)
    ? [...BASELINE_LEAST_PRIVILEGE, "require-human-approval"]
    : [...BASELINE_LEAST_PRIVILEGE];
}

function finding(
  code: PromptSafetyViolationCode,
  ruleId: PromptSafetyRuleId,
  severity: PromptSafetySeverity,
): PromptSafetyFinding {
  return { code, ruleId, severity, detail: PROMPT_SAFETY_VIOLATION_DETAILS[code] };
}

// Baseline safeguards required of EVERY generated prompt (AC1/AC2, no-authority, no-disclosure).
function collectBaselineSafeguardFindings(prompt: EnhancedPrompt): PromptSafetyFinding[] {
  const findings: PromptSafetyFinding[] = [];
  // AC2 — untrusted content must be marked. `untrustedContent` is pinned to `true` in the type, but a
  // forged/cast object can violate it, so the runtime check is load-bearing.
  if ((prompt.groundingPlan as { readonly untrustedContent?: unknown }).untrustedContent !== true) {
    findings.push(finding("missing-untrusted-marker", "untrusted-content-marked", "blocking"));
  }
  // AC1 — the Input section must be labelled as data, not instructions.
  if (!marksInputAsData(prompt.context)) {
    findings.push(
      finding("missing-channel-separation", "trusted-untrusted-separation", "blocking"),
    );
  }
  // ADR-0044 §4 — no authority grant.
  if (!assertsNoAuthority(prompt.safetyRules)) {
    findings.push(finding("missing-authority-restriction", "no-authority-grant", "blocking"));
  }
  // Scope — no secret / system-prompt disclosure.
  if (!forbidsSecretDisclosure(prompt.safetyRules)) {
    findings.push(
      finding("missing-secrecy-rule", "no-secret-or-system-prompt-disclosure", "blocking"),
    );
  }
  return findings;
}

// Conditional safeguards: human review + least privilege for risky tasks (AC5), and an output-
// validation expectation for structured outputs.
function collectConditionalSafeguardFindings(
  prompt: EnhancedPrompt,
  requiresReview: boolean,
): PromptSafetyFinding[] {
  const findings: PromptSafetyFinding[] = [];
  if (requiresReview && !requiresHumanApprovalRule(prompt.safetyRules)) {
    findings.push(finding("missing-human-review", "human-review-for-risky-actions", "blocking"));
  }
  if (requiresReview && !carriesLeastPrivilegeConstraint(prompt.constraints, prompt.safetyRules)) {
    findings.push(finding("missing-least-privilege", "least-privilege-tool-access", "blocking"));
  }
  if (
    prompt.outputSchema.structured &&
    !requiresOutputConformance(prompt.constraints, prompt.qualityCriteria)
  ) {
    findings.push(finding("missing-output-validation", "output-validation-required", "warning"));
  }
  return findings;
}

function collectStructuralFindings(
  prompt: EnhancedPrompt,
  requiresReview: boolean,
): PromptSafetyFinding[] {
  return [
    ...collectBaselineSafeguardFindings(prompt),
    ...collectConditionalSafeguardFindings(prompt, requiresReview),
  ];
}

function trustedEntries(prompt: EnhancedPrompt): readonly string[] {
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
  ];
}

function collectHiddenAssumptionFindings(
  prompt: EnhancedPrompt,
  analysis: PromptTaskAnalysis,
): PromptSafetyFinding[] {
  const allowed = new Set(
    analysis.missingContext
      .filter((item) => item.kind === "assumption")
      .map((item) => `${TRUSTED_ASSUMPTION_PREFIX}${item.statement}`),
  );
  const hasHiddenAssumption = trustedEntries(prompt)
    .flatMap((entry) => entry.split(/\r?\n/u).map((line) => line.trim()))
    .some((entry) => entry.startsWith(TRUSTED_ASSUMPTION_PREFIX) && !allowed.has(entry));
  return hasHiddenAssumption
    ? [finding("hidden-assumption", "no-manipulative-or-injected-instructions", "blocking")]
    : [];
}

function collectProhibitedTrustedFindings(
  prompt: EnhancedPrompt,
  analysis: PromptTaskAnalysis,
): PromptSafetyFinding[] {
  const trusted = [...trustedEntries(prompt)].join(" \n ").toLowerCase();
  const findings: PromptSafetyFinding[] = [];
  if (containsAny(trusted, TRUSTED_AUTHORITY_GRANT_CUES)) {
    findings.push(finding("capability-grant-claim", "no-authority-grant", "blocking"));
  }
  if (containsAny(trusted, TRUSTED_OVERRIDE_CUES)) {
    findings.push(
      finding(
        "untrusted-instruction-override",
        "no-manipulative-or-injected-instructions",
        "blocking",
      ),
    );
  }
  if (containsAny(trusted, TRUSTED_DISCLOSURE_CUES)) {
    findings.push(
      finding("system-prompt-disclosure", "no-secret-or-system-prompt-disclosure", "blocking"),
    );
  }
  findings.push(...collectHiddenAssumptionFindings(prompt, analysis));
  return findings;
}

/**
 * Deterministically assess the STRUCTURAL safety of an `EnhancedPrompt` against the validate-stage
 * rule set. Pure. Confirms the required safeguards are present (AC1/AC2/AC5, no-authority,
 * no-disclosure, output validation) and that the trusted sections carry no authority-grant, override,
 * or disclosure claim (AC3 defense in depth). The authoritative text-level detection over untrusted
 * input is layered on top by the gateway validate stage; this function never inspects raw input.
 */
export function assessEnhancedPromptStructuralSafety(
  prompt: EnhancedPrompt,
  analysis: PromptTaskAnalysis,
): PromptSafetyAssessment {
  const requiresReview = requiresHumanReviewForAnalysis(analysis);
  const findings = [
    ...collectStructuralFindings(prompt, requiresReview),
    ...collectProhibitedTrustedFindings(prompt, analysis),
  ];
  const { decision, verificationStatus } = summarizePromptSafety(findings, requiresReview);
  return {
    schemaVersion: PROMPT_ENHANCER_SCHEMA_VERSION,
    promptId: prompt.promptId,
    decision,
    requiresHumanReview: requiresReview,
    verificationStatus,
    findings,
    leastPrivilege: leastPrivilegeForAnalysis(analysis),
  };
}

// ─── Wire validator ────────────────────────────────────────────────────────────────
const ASSESSMENT_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "promptId",
  "decision",
  "requiresHumanReview",
  "verificationStatus",
  "findings",
  "leastPrivilege",
]);
const FINDING_KEYS: ReadonlySet<string> = new Set(["code", "ruleId", "severity", "detail"]);
const ASSESSMENT_FINDINGS_MAX = 256;

const VERIFICATION_BY_DECISION: Readonly<
  Record<PromptSafetyDecision, PromptSafetyVerificationStatus>
> = {
  accepted: "passed",
  "requires-human-review": "passed-with-review",
  rejected: "failed",
};

function validateFinding(value: unknown, index: number, errors: string[]): boolean {
  const label = `assessment.findings[${String(index)}]`;
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  let ok = true;
  if (Object.keys(value).some((key) => !FINDING_KEYS.has(key))) {
    errors.push(`${label} must not contain unknown fields`);
    ok = false;
  }
  if (!isPromptSafetyViolationCode(value.code)) {
    errors.push(`${label}.code must be a known violation code`);
    ok = false;
  }
  if (!isMember(value.ruleId, PROMPT_SAFETY_RULE_IDS)) {
    errors.push(`${label}.ruleId must be a known safety rule id`);
    ok = false;
  }
  const isBlocking = value.severity === "blocking";
  if (!isMember(value.severity, PROMPT_SAFETY_SEVERITIES)) {
    errors.push(`${label}.severity must be a known severity`);
    ok = false;
  }
  if (!isBoundedSafeText(value.detail, SAFETY_DETAIL_MAX_CHARS)) {
    errors.push(`${label}.detail must be a bounded, control-free string`);
    ok = false;
  }
  return ok && isBlocking;
}

function validateAssessmentScalars(input: Record<string, unknown>, errors: string[]): void {
  if (Object.keys(input).some((key) => !ASSESSMENT_KEYS.has(key))) {
    errors.push("assessment must not contain unknown fields");
  }
  if (input.schemaVersion !== PROMPT_ENHANCER_SCHEMA_VERSION) {
    errors.push(`assessment.schemaVersion must be "${PROMPT_ENHANCER_SCHEMA_VERSION}"`);
  }
  const promptIdResult = validatePromptEnhancerIdString(input.promptId, "EnhancedPromptId");
  if (!promptIdResult.ok) errors.push(`assessment.promptId: ${promptIdResult.reason}`);
  if (!isMember(input.decision, PROMPT_SAFETY_DECISIONS)) {
    errors.push(`assessment.decision must be one of ${PROMPT_SAFETY_DECISIONS.join("|")}`);
  }
  if (typeof input.requiresHumanReview !== "boolean") {
    errors.push("assessment.requiresHumanReview must be a boolean");
  }
  if (!isMember(input.verificationStatus, PROMPT_SAFETY_VERIFICATION_STATUSES)) {
    errors.push(
      `assessment.verificationStatus must be one of ${PROMPT_SAFETY_VERIFICATION_STATUSES.join("|")}`,
    );
  }
}

// Validate the findings array; returns the number of well-formed blocking findings (or -1 when the
// array itself is malformed, so the caller can skip the blocking-count cross-checks).
function validateAssessmentFindings(input: Record<string, unknown>, errors: string[]): number {
  if (!Array.isArray(input.findings) || input.findings.length > ASSESSMENT_FINDINGS_MAX) {
    errors.push(
      `assessment.findings must be an array of at most ${String(ASSESSMENT_FINDINGS_MAX)} entries`,
    );
    return -1;
  }
  let blockingCount = 0;
  input.findings.forEach((entry, index) => {
    if (validateFinding(entry, index, errors)) blockingCount += 1;
  });
  return blockingCount;
}

function isValidLeastPrivilege(value: unknown): value is readonly LeastPrivilegeConstraint[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => isMember(entry, LEAST_PRIVILEGE_CONSTRAINTS)) &&
    new Set(value).size === value.length
  );
}

function validateDecisionConsistency(
  input: Record<string, unknown>,
  blockingCount: number,
  errors: string[],
): void {
  if (!isMember(input.decision, PROMPT_SAFETY_DECISIONS) || blockingCount < 0) return;
  if (input.verificationStatus !== VERIFICATION_BY_DECISION[input.decision]) {
    errors.push("assessment.verificationStatus must match the decision");
  }
  if (input.decision === "rejected" && blockingCount === 0) {
    errors.push("assessment.decision rejected requires at least one blocking finding");
  }
  if (input.decision !== "rejected" && blockingCount > 0) {
    errors.push("assessment.decision must be rejected when a blocking finding is present");
  }
}

function validateHumanReviewConstraint(
  input: Record<string, unknown>,
  leastPrivilegeOk: boolean,
  errors: string[],
): void {
  if (input.decision === "accepted" && input.requiresHumanReview !== false) {
    errors.push("assessment.decision accepted requires requiresHumanReview to be false");
  }
  if (input.decision === "requires-human-review" && input.requiresHumanReview !== true) {
    errors.push(
      "assessment.decision requires-human-review requires requiresHumanReview to be true",
    );
  }
  if (
    input.requiresHumanReview === true &&
    leastPrivilegeOk &&
    !(input.leastPrivilege as readonly LeastPrivilegeConstraint[]).includes(
      "require-human-approval",
    )
  ) {
    errors.push(
      "assessment.leastPrivilege must include require-human-approval when human review is required",
    );
  }
}

function validateAssessmentCrossFields(
  input: Record<string, unknown>,
  blockingCount: number,
  leastPrivilegeOk: boolean,
  errors: string[],
): void {
  validateDecisionConsistency(input, blockingCount, errors);
  validateHumanReviewConstraint(input, leastPrivilegeOk, errors);
}

/**
 * Validate a `PromptSafetyAssessment`. Pure; returns a discriminated result and never throws. Checks
 * structural well-formedness and the cross-field invariants that make the assessment trustworthy: the
 * verification status matches the decision, a `rejected` decision carries at least one blocking
 * finding, and a human-review requirement implies the `require-human-approval` least-privilege
 * constraint.
 */
export function validatePromptSafetyAssessment(
  input: unknown,
): PromptEnhancerValidation<PromptSafetyAssessment> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["assessment must be an object"] };
  }
  const errors: string[] = [];
  validateAssessmentScalars(input, errors);
  const blockingCount = validateAssessmentFindings(input, errors);
  const leastPrivilegeOk = isValidLeastPrivilege(input.leastPrivilege);
  if (!leastPrivilegeOk) {
    errors.push("assessment.leastPrivilege must be an array of unique least-privilege constraints");
  }
  validateAssessmentCrossFields(input, blockingCount, leastPrivilegeOk, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as PromptSafetyAssessment };
}
