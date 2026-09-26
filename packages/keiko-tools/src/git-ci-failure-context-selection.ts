import { isGitPullRequestIdentity } from "@oscharko-dev/keiko-contracts/runtime/git-pull-request";
import { gitDeliveryObservationFailure } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import { assessGitCiFacts } from "./git-ci-assessment.js";
import type { GitCiProviderFacts } from "./git-ci-facts.js";
import {
  GIT_CI_FAILURE_MAX_SOURCES,
  GitCiFailureContextError,
  ciFailureCompleted,
  ciFailureObject,
  ciFailurePositive,
  type GitCiFailureSource,
} from "./git-ci-failure-context-types.js";
import type { GitCiCheckEvidence } from "./git-ci-checks.js";

export function selectGitCiFailureSources(
  facts: GitCiProviderFacts,
): readonly GitCiFailureSource[] {
  if (
    !isGitPullRequestIdentity(facts.identity) ||
    facts.identity.state !== "open" ||
    !ciFailurePositive(facts.repositoryId)
  )
    throw new TypeError("Invalid CI diagnostic binding");
  const checks = observedChecks(facts);
  const sources = new Map<string, GitCiFailureSource>();
  for (const required of checks.required) {
    if (required.classification !== "failed") continue;
    for (const evidence of required.evidence) {
      const source = selectSource(facts, evidence);
      if (source !== undefined) sources.set(`${source.kind}:${String(source.id)}`, source);
    }
  }
  if (sources.size > GIT_CI_FAILURE_MAX_SOURCES)
    throw new RangeError("CI diagnostic source bound exhausted");
  return [...sources.values()];
}
function observedChecks(
  facts: GitCiProviderFacts,
): Extract<ReturnType<typeof assessGitCiFacts>["checks"], { status: "observed" }> {
  if (facts.requirements.status === "unknown")
    throw new GitCiFailureContextError(facts.requirements.failure);
  if (facts.workflowDefinitions.status === "unknown")
    throw new GitCiFailureContextError(facts.workflowDefinitions.failure);
  const assessment = assessGitCiFacts(facts);
  if (!assessment.complete || assessment.checks.status !== "observed")
    throw new TypeError("Incomplete CI diagnostic assessment");
  if (assessment.checks.required.some((value) => value.evidenceTruncated))
    throw new RangeError("Incomplete CI diagnostic evidence");
  return assessment.checks;
}

function selectSource(
  facts: GitCiProviderFacts,
  evidence: GitCiCheckEvidence,
): GitCiFailureSource | undefined {
  if (evidence.kind === "commit-status") {
    legacySource(facts, evidence.id);
    return undefined;
  }
  const kind = evidence.kind;
  const page = facts.lists[kind === "check-run" ? "check-runs" : "workflow-runs"];
  const candidates = page.values.filter(
    (value) => ciFailureObject(value) && value.id === evidence.id,
  );
  const metadata = candidates[0];
  if (candidates.length !== 1 || !ciFailureObject(metadata))
    throw new TypeError("Missing observed CI source");
  if (!ciFailureCompleted(metadata)) return undefined;
  if (metadata.headSha !== facts.identity.headSha) throw new TypeError("Stale CI source");
  const attempt = kind === "check-run" ? 1 : metadata.runAttempt;
  if (!ciFailurePositive(attempt)) throw new TypeError("Invalid CI run attempt");
  return { kind, id: evidence.id, attempt, metadata };
}

function legacySource(facts: GitCiProviderFacts, id: number): undefined {
  const legacy = facts.lists["commit-statuses"].values.find(
    (value) => ciFailureObject(value) && value.id === id,
  );
  if (
    ciFailureObject(legacy) &&
    typeof legacy.state === "string" &&
    new Set(["failure", "error"]).has(legacy.state)
  )
    throw new GitCiFailureContextError(gitDeliveryObservationFailure("visibility-unknown"));
  return undefined;
}
