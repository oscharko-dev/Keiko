import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import { gitDeliveryObservationFailure } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import { classifyGitProviderReadFailure } from "./git-provider-observation.js";
import type { GitCiProviderFacts } from "./git-ci-facts.js";
import { selectGitCiFailureSources } from "./git-ci-failure-context-selection.js";
import { GitCiFailureReader, failure } from "./git-ci-failure-context-reader.js";
import {
  addGitCiAnnotation,
  addGitCiCheckSummary,
  addGitCiJob,
} from "./git-ci-failure-context-content.js";
import {
  GIT_CI_FAILURE_MAX_BYTES,
  GitCiFailureContextError,
  ciFailureObject,
  ciFailurePositive,
  type BoundedGitCiFailureContext,
  type GitCiFailureCollection,
  type GitCiFailureContextInput,
  type GitCiFailureContextResult,
  type GitCiFailureSource,
} from "./git-ci-failure-context-types.js";

export type {
  BoundedGitCiFailureContext,
  GitCiFailureContextEntry,
  GitCiFailureContextInput,
  GitCiFailureContextResult,
} from "./git-ci-failure-context-types.js";
function capture(request: GitCiFailureContextInput): GitCiFailureContextInput {
  const json = JSON.stringify(request.facts);
  if (Buffer.byteLength(json, "utf8") > 1_048_576) failure("output-truncated");
  // Detach all caller-owned source arrays before the first await; this is not a durable snapshot.
  return Object.freeze({ ...request, facts: JSON.parse(json) as GitCiProviderFacts });
}
function validateJob(
  raw: unknown,
  source: GitCiFailureSource,
  input: GitCiFailureContextInput,
): Record<string, unknown> {
  if (!ciFailureObject(raw) || !ciFailurePositive(raw.id)) failure("malformed-response");
  const url = `https://api.github.com/repos/${input.facts.identity.repository}/actions/jobs/${String(raw.id)}`;
  if (raw.runId !== source.id || raw.headSha !== input.facts.identity.headSha || raw.url !== url)
    failure("revision-changed");
  return raw;
}
function addEntries(
  values: readonly unknown[],
  source: GitCiFailureSource,
  input: GitCiFailureContextInput,
  collection: GitCiFailureCollection,
): void {
  const identities = new Set<string>();
  for (const value of values) {
    const raw = source.kind === "workflow-run" ? validateJob(value, source, input) : value;
    const identity =
      source.kind === "workflow-run" && ciFailureObject(raw) ? String(raw.id) : canonicalise(raw);
    if (identities.has(identity)) failure("malformed-response");
    identities.add(identity);
    if (source.kind === "check-run") addGitCiAnnotation(raw, source, input, collection);
    else if (ciFailureObject(raw)) addGitCiJob(raw, source, input, collection);
  }
}
async function readSource(
  reader: GitCiFailureReader,
  source: GitCiFailureSource,
  input: GitCiFailureContextInput,
  collection: GitCiFailureCollection,
): Promise<void> {
  const before = await reader.source(source);
  const values = await reader.entries(source);
  if (source.kind === "check-run") addGitCiCheckSummary(before, source, input, collection);
  addEntries(values, source, input, collection);
  const after = await reader.source(source);
  if (canonicalise(before) !== canonicalise(after)) failure("revision-changed");
}
function context(
  input: GitCiFailureContextInput,
  reader: GitCiFailureReader,
  collection: GitCiFailureCollection,
  sourceCount: number,
): BoundedGitCiFailureContext {
  const identity = input.facts.identity;
  const base = {
    schemaVersion: "1" as const,
    trust: "untrusted-provider-content" as const,
    usage: "diagnostic-data-only" as const,
    repository: identity.repository,
    prNumber: identity.number,
    headSha: identity.headSha,
    baseSha: identity.baseSha,
    sourceCount,
  };
  const make = (): BoundedGitCiFailureContext => ({
    ...base,
    entries: [...collection.entries],
    completeness: {
      pages: reader.calls,
      entries: collection.entries.length,
      bytes: reader.bytes,
      ...(collection.truncated
        ? { complete: false as const, failure: gitDeliveryObservationFailure("output-truncated") }
        : { complete: true as const }),
    },
  });
  let result = make();
  while (Buffer.byteLength(JSON.stringify(result), "utf8") > GIT_CI_FAILURE_MAX_BYTES) {
    collection.entries.pop();
    collection.truncated = true;
    result = make();
  }
  return result;
}
function unavailable(error: unknown): GitCiFailureContextResult {
  if (error instanceof GitCiFailureContextError)
    return { status: "unavailable", failure: error.failure };
  const reason = error instanceof RangeError ? "pagination-exhausted" : "malformed-response";
  const known =
    error instanceof TypeError || error instanceof RangeError || !(error instanceof Error)
      ? undefined
      : classifyGitProviderReadFailure(error);
  return { status: "unavailable", failure: known ?? gitDeliveryObservationFailure(reason) };
}
/** Reads only assessment-selected failed required sources; text is inert, transient model data. */
export async function readGitCiFailureContext(
  request: GitCiFailureContextInput,
): Promise<GitCiFailureContextResult> {
  try {
    const input = capture(request);
    const reader = new GitCiFailureReader(input);
    reader.admit();
    const sources = selectGitCiFailureSources(input.facts);
    const collection: GitCiFailureCollection = { entries: [], truncated: false };
    if (sources.length > 0) {
      await reader.checkPullRequest();
      for (const source of sources) await readSource(reader, source, input, collection);
      await reader.checkPullRequest();
    }
    const result = context(input, reader, collection, sources.length);
    reader.admit();
    return { status: "observed", context: result };
  } catch (error) {
    return unavailable(error);
  }
}
