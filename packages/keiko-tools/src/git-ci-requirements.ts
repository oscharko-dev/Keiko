import {
  gitDeliveryObservationFailure,
  isGitDeliveryReadCompleteness,
  type GitDeliveryObservationFailure,
} from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import {
  isGitObjectId,
  isSafeGitRefName,
} from "@oscharko-dev/keiko-contracts/runtime/git-repository";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import type { GitCiProtectionFacts } from "./git-ci-facts.js";
import type { GitProviderPageResult } from "./git-provider-observation.js";

export type GitCiRequirementSource =
  | { readonly kind: "branch-protection" }
  | {
      readonly kind: "ruleset";
      readonly id: number;
      readonly sourceType: "Repository" | "Organization" | "Enterprise";
    };
interface RequirementSource {
  readonly sources: readonly GitCiRequirementSource[];
}
export interface GitCiStatusRequirement extends RequirementSource {
  readonly kind: "status-context";
  readonly context: string;
  readonly appId: number | null;
}
export interface GitCiWorkflowRequirement extends RequirementSource {
  readonly kind: "workflow";
  readonly repositoryId: number;
  readonly path: string;
  readonly ref: string | null;
  readonly sha: string | null;
}
export type GitCiRequirement = GitCiStatusRequirement | GitCiWorkflowRequirement;
export type GitCiRequirementsResult =
  | {
      readonly status: "observed";
      readonly requirements: readonly GitCiRequirement[];
      readonly strict: boolean;
      readonly digest: string;
    }
  | { readonly status: "unknown"; readonly failure: GitDeliveryObservationFailure };
interface Input {
  readonly protection: GitCiProtectionFacts;
  readonly rules: GitProviderPageResult;
}
interface State {
  readonly requirements: GitCiRequirement[];
  strict: boolean;
}

const NON_CI_RULES = new Set([
  "creation",
  "update",
  "deletion",
  "required_linear_history",
  "required_signatures",
  "pull_request",
  "non_fast_forward",
  "commit_message_pattern",
  "commit_author_email_pattern",
  "committer_email_pattern",
  "branch_name_pattern",
  "tag_name_pattern",
  "file_path_restriction",
  "max_file_path_length",
  "file_extension_restriction",
  "max_file_size",
  "copilot_code_review",
]);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function name(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}
function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 500)
    throw new TypeError("Invalid CI requirements list");
  return value as unknown[];
}
function appId(value: unknown, legacy: boolean): number | null {
  if (value === undefined || value === null || (legacy && value === -1)) return null;
  if (!positive(value)) throw new TypeError("Invalid CI application identity");
  return value;
}
function contextRequirement(
  value: unknown,
  source: GitCiRequirementSource,
  key: "app_id" | "integration_id",
): GitCiStatusRequirement {
  if (!object(value) || !name(value.context)) throw new TypeError("Invalid CI context requirement");
  return {
    kind: "status-context",
    context: value.context,
    appId: appId(value[key], key === "app_id"),
    sources: [source],
  };
}
function legacyRequirements(state: State, protection: GitCiProtectionFacts): void {
  if (protection.outcome !== "protected") return;
  const value = protection.value;
  if (typeof value.strict !== "boolean") throw new TypeError("Invalid CI protection policy");
  state.strict = value.strict;
  if (value.checks === null) return;
  const details = legacyChecks(value.checks, value.strict);
  const source = { kind: "branch-protection" } as const;
  const checks = list(details.checks ?? []).map((check) =>
    contextRequirement(check, source, "app_id"),
  );
  const contexts = list(details.contexts ?? []);
  for (const context of contexts) {
    if (!name(context)) throw new TypeError("Invalid legacy CI context");
    if (!checks.some((check) => check.context === context))
      checks.push({ kind: "status-context", context, appId: null, sources: [source] });
  }
  append(state, checks);
}
function legacyChecks(value: unknown, strict: boolean): Record<string, unknown> {
  if (!object(value)) throw new TypeError("Invalid CI protection requirements");
  if (!Object.hasOwn(value, "checks") && !Object.hasOwn(value, "contexts"))
    throw new TypeError("Missing CI protection contexts");
  if (typeof value.strict === "boolean" && value.strict !== strict)
    throw new TypeError("Inconsistent CI strict protection");
  return value;
}
function optionalWorkflowRef(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !isSafeGitRefName(value))
    throw new TypeError("Invalid required workflow ref");
  return value;
}
function optionalWorkflowSha(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!isGitObjectId(value)) throw new TypeError("Invalid required workflow revision");
  return value;
}
function append(state: State, values: readonly GitCiRequirement[]): void {
  if (state.requirements.length + values.length > 500)
    throw new TypeError("Too many CI requirements");
  state.requirements.push(...values);
}
function ruleSource(rule: Record<string, unknown>): GitCiRequirementSource {
  const sourceType = rule.ruleset_source_type;
  if (
    !positive(rule.ruleset_id) ||
    (sourceType !== "Repository" && sourceType !== "Organization" && sourceType !== "Enterprise")
  )
    throw new TypeError("Invalid CI ruleset identity");
  return { kind: "ruleset", id: rule.ruleset_id, sourceType };
}
function workflowRequirement(
  value: unknown,
  source: GitCiRequirementSource,
): GitCiWorkflowRequirement {
  if (!object(value) || !positive(value.repository_id) || !name(value.path))
    throw new TypeError("Invalid required workflow identity");
  if (!/^\.github\/workflows\/[^/@]+\.ya?ml$/u.test(value.path) || value.path.includes(".."))
    throw new TypeError("Invalid required workflow path");
  const ref = optionalWorkflowRef(value.ref);
  const sha = optionalWorkflowSha(value.sha);
  return {
    kind: "workflow",
    repositoryId: value.repository_id,
    path: value.path,
    ref,
    sha,
    sources: [source],
  };
}
function ruleRequirements(state: State, value: unknown): void {
  if (!object(value) || typeof value.type !== "string") throw new TypeError("Invalid CI rule");
  const source = ruleSource(value);
  if (NON_CI_RULES.has(value.type)) return;
  if (!object(value.parameters)) throw new TypeError("Invalid CI rule parameters");
  if (value.type === "required_status_checks") {
    const strict = value.parameters.strict_required_status_checks_policy;
    if (typeof strict !== "boolean") throw new TypeError("Invalid CI strict status policy");
    state.strict ||= strict;
    append(
      state,
      list(value.parameters.required_status_checks).map((item) =>
        contextRequirement(item, source, "integration_id"),
      ),
    );
  } else if (value.type === "workflows") {
    append(
      state,
      list(value.parameters.workflows).map((item) => workflowRequirement(item, source)),
    );
  } else throw new TypeError("Unknown CI rule");
}
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}
function normalized(state: State): GitCiRequirementsResult {
  if (state.requirements.length > 500) throw new TypeError("Too many CI requirements");
  const byKey = new Map<string, GitCiRequirement>();
  for (const requirement of state.requirements) {
    const { sources, ...identity } = requirement;
    const key = canonicalise(identity);
    const previous = byKey.get(key);
    const merged = new Map(
      [...(previous?.sources ?? []), ...sources].map((source) => [canonicalise(source), source]),
    );
    byKey.set(key, {
      ...requirement,
      sources: Object.freeze(
        [...merged]
          .sort(([a], [b]) => compareKeys(a, b))
          .map(([, source]) => Object.freeze(source)),
      ),
    });
  }
  const requirements = [...byKey]
    .sort(([a], [b]) => compareKeys(a, b))
    .map(([, value]) => Object.freeze(value));
  const digest = sha256Hex(canonicalise(["keiko-ci-requirements-v1", state.strict, requirements]));
  return {
    status: "observed",
    requirements: Object.freeze(requirements),
    strict: state.strict,
    digest,
  };
}

/** The branch-rules endpoint has already selected active rules across every applicable scope. */
export function collectGitCiRequirements(input: Input): GitCiRequirementsResult {
  if (input.protection.outcome === "unknown")
    return { status: "unknown", failure: input.protection.failure };
  const complete = input.rules.completeness;
  if (!isGitDeliveryReadCompleteness(complete))
    return { status: "unknown", failure: gitDeliveryObservationFailure("malformed-response") };
  if (!complete.complete) return { status: "unknown", failure: complete.failure };
  if (complete.pages > 5 || complete.bytes > 1_048_576)
    return { status: "unknown", failure: gitDeliveryObservationFailure("requirements-ambiguous") };
  try {
    if (complete.entries !== input.rules.values.length)
      throw new TypeError("Incomplete CI rule list");
    const state: State = { requirements: [], strict: false };
    legacyRequirements(state, input.protection);
    for (const rule of list(input.rules.values)) ruleRequirements(state, rule);
    return normalized(state);
  } catch {
    return { status: "unknown", failure: gitDeliveryObservationFailure("requirements-ambiguous") };
  }
}
