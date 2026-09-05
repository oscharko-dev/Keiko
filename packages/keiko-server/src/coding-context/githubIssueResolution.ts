// Server-side GitHub issue resolution for the Coding Workbench (#3385, Epic #3384).
//
// The browser hands over two things and nothing else: the repository it is working in (already
// validated as a registered project by the route) and the raw text the user pasted. Everything
// that binds a run to an issue is resolved HERE, server-side, from that: the checkout's own
// remote (the only repository a reference may name), the per-checkout reader grant, the issue's
// immutable identity, state and provenance as the provider reports them, and the checkout's
// default branch. The result is either a content-free `CodingWorkbenchIssueBinding` plus a
// bounded, untrusted preview, or one member of the closed failure vocabulary — never a guess.
//
// Every outcome leaves exactly one body-free line on the activity log (ADR-0173): the outcome,
// the issue number, the content-free repository id and — on a fault — the closed error kind.
// Never the reference text, the remote, the root, the title or the body.

import type {
  CodingWorkbenchIssueBinding,
  CodingWorkbenchIssueBindingFailure,
  CodingWorkbenchIssuePreview,
} from "@oscharko-dev/keiko-contracts";
import {
  CODING_WORKBENCH_ISSUE_PREVIEW_EXCERPT_MAX_CHARS,
  CODING_WORKBENCH_ISSUE_PREVIEW_TITLE_MAX_CHARS,
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  canonicalGitHubOwnerAndRepo,
  parseGitHubIssueReference,
  sameGitHubOwnerAndRepo,
  type GitHubIssueReferenceRejection,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts/runtime/text-safety";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { readGitDefaultBranch } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";

import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type { UiHandlerDeps } from "../deps.js";
import type { ServerLogLevel, ServerLogSink } from "../observability/index.js";
import { errorKindOf } from "../observability/server-log.js";
import { causeChain, keikoStackFrames } from "../observability/stack-frames.js";
import { logCommandTermination, processServerLogSink } from "../process-log-sink.js";
import {
  buildGitHubCodeContextArgv,
  buildGitHubCodeContextCommentsArgv,
  codeContextContentDigest,
  gitHubCodeContextRawObjectFrom,
  type CodeContextRawObject,
  type GitHubCodeContextRef,
} from "./codeContextConnector.js";
import type { GitHubCodeContextApiPort } from "./githubCodeContextConnector.js";
import {
  gitHubCodeContextPortFor,
  githubIssueReaderRepositoryId,
  githubRemoteOwnerAndRepoFor,
  isGitHubIssueReaderAuthorized,
} from "./githubIssueReaderAuthorization.js";

export interface GitHubIssueResolutionInput {
  /** Server-resolved checkout root, already canonical (realpath'd by the caller). */
  readonly repositoryRoot: string;
  /** Raw user text: an issue URL, `owner/repo#n`, or `#n` relative to the checkout's remote. */
  readonly issueRef: string;
  readonly correlationId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export type GitHubIssueResolution =
  | {
      readonly ok: true;
      readonly binding: CodingWorkbenchIssueBinding;
      readonly preview: CodingWorkbenchIssuePreview;
      /** Transient, server-private source for the existing context-pack builder. */
      readonly contextObject: CodeContextRawObject;
    }
  | {
      readonly ok: false;
      readonly failure: CodingWorkbenchIssueBindingFailure;
      /** Internal classification; HTTP owners project only the established public failure. */
      readonly failureReason?: GitHubIssueResolutionReason;
    };

export type GitHubIssueResolutionDeps = Pick<
  UiHandlerDeps,
  "store" | "env" | "codingContextGitHubPort" | "codingContextGitHubRemoteResolver" | "activityLog"
>;

export type GitHubIssueResolver = (
  deps: GitHubIssueResolutionDeps,
  input: GitHubIssueResolutionInput,
) => Promise<GitHubIssueResolution>;

/**
 * The one effect this module performs that has no seam on `UiHandlerDeps`: reading the checkout's
 * default branch. Production binds keiko-tools' `readGitDefaultBranch`; a test binds a function.
 */
export interface GitHubIssueResolverPorts {
  readonly readDefaultBranch: (
    repositoryRoot: string,
    context: {
      readonly env: UiHandlerDeps["env"];
      readonly signal: AbortSignal | undefined;
      readonly activityLog: ServerLogSink;
      readonly correlationId: string;
    },
  ) => Promise<string | undefined>;
}

/**
 * Why a resolution ended where it did, one level finer than the closed failure the caller sees.
 * Closed as well, so the activity line can say WHICH `issue-unavailable` this was (a closed issue,
 * a pull request, a transfer) without ever carrying text from the provider.
 */
export type GitHubIssueResolutionReason =
  | GitHubIssueReferenceRejection
  | "repository-unresolved"
  | "remote-unresolved"
  | "reference-names-other-repository"
  | "no-grant"
  | "reader-unavailable"
  | "read-failed"
  | "identity-missing"
  | "state-unknown"
  | "pull-request-as-issue"
  | "closed"
  | "provenance-unreadable"
  | "transferred"
  | "renumbered"
  | "default-branch-read-failed"
  | "default-branch-unresolved"
  | "aborted";

// ─── digests ───────────────────────────────────────────────────────────────────────────────

/**
 * The binding digest formula, exported so a downstream stage (#3386, #3387) re-derives it from the
 * producer rather than restating it: sha256 over the canonical JSON of every other binding field.
 */
export function codingWorkbenchIssueBindingDigest(
  fields: Omit<CodingWorkbenchIssueBinding, "bindingDigest">,
): string {
  return sha256Hex(canonicalise(fields));
}

/** Digest of the canonical host/owner/repository identity, shared by all remote URL spellings. */
export function codingWorkbenchRemoteDigest(ownerAndRepo: string): string {
  return sha256Hex(`github.com/${canonicalGitHubOwnerAndRepo(ownerAndRepo)}`);
}

// ─── the resolution ────────────────────────────────────────────────────────────────────────

interface ResolutionContext {
  readonly deps: GitHubIssueResolutionDeps;
  readonly input: GitHubIssueResolutionInput;
  readonly ports: GitHubIssueResolverPorts;
  readonly activityLog: ServerLogSink;
  readonly correlationId: string;
}

interface Refusal {
  readonly failure: CodingWorkbenchIssueBindingFailure;
  readonly reason: GitHubIssueResolutionReason;
  readonly errorKind?: string | undefined;
  readonly frames?: readonly string[] | undefined;
  readonly causeChain?: ReturnType<typeof causeChain> | undefined;
  /** Present once the reference parsed: evidence of WHICH issue was refused, never its text. */
  readonly issueNumber?: number | undefined;
}

// A step either produces its value or the refusal that ends the resolution.
type Step<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: Refusal };

function refuse(
  failure: CodingWorkbenchIssueBindingFailure,
  reason: GitHubIssueResolutionReason,
  error?: unknown,
): Step<never> {
  return {
    ok: false,
    refusal: {
      failure,
      reason,
      ...(error === undefined
        ? {}
        : {
            errorKind: errorKindOf(error),
            frames: keikoStackFrames(error),
            causeChain: causeChain(error),
          }),
    },
  };
}

function produce<T>(value: T): Step<T> {
  return { ok: true, value };
}

// A refusal after the reference parsed carries the issue number it was about.
function numbered<T>(step: Step<T>, issueNumber: number): Step<T> {
  return step.ok ? step : { ok: false, refusal: { ...step.refusal, issueNumber } };
}

function cancelledIfAborted(signal: AbortSignal | undefined): Step<undefined> {
  return signal?.aborted === true ? refuse("cancelled", "aborted") : produce(undefined);
}

// The content-free workspace view `git` is given for one checkout — the same literal the
// authorization module builds for its own reads.
function workspaceViewFor(repositoryRoot: string): WorkspaceInfo {
  return {
    root: repositoryRoot,
    selectedRoot: repositoryRoot,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

const PRODUCTION_PORTS: GitHubIssueResolverPorts = {
  readDefaultBranch: (repositoryRoot, context) =>
    readGitDefaultBranch({
      workspace: workspaceViewFor(repositoryRoot),
      processEnv: context.env,
      signal: context.signal,
      onTerminated: (evidence): void => {
        logCommandTermination(context.activityLog, context.correlationId, evidence);
      },
    }),
};

// Step 1: the checkout's own remote is the ONLY repository a reference may name, and the bound
// repository a bare `#n` resolves against. A checkout with no readable GitHub remote resolves to
// nothing, and the user is asked to switch, open or clone rather than have a repository guessed.
async function resolveRemote(ctx: ResolutionContext): Promise<Step<string>> {
  const remote = await githubRemoteOwnerAndRepoFor(
    ctx.input.repositoryRoot,
    ctx.deps.env,
    ctx.deps.codingContextGitHubRemoteResolver,
    { correlationId: ctx.correlationId, activityLog: ctx.activityLog, signal: ctx.input.signal },
  );
  const aborted = cancelledIfAborted(ctx.input.signal);
  if (!aborted.ok) return aborted;
  return remote === undefined
    ? refuse("repository-mismatch", "remote-unresolved")
    : produce(remote);
}

// Step 2: parse, then pin the reference to the checkout. A reference naming another repository
// is a mismatch to be resolved explicitly, never a redirect.
function resolveReference(
  ctx: ResolutionContext,
  remote: string,
): Step<{ readonly ownerAndRepo: string; readonly issueNumber: number }> {
  const parsed = parseGitHubIssueReference(ctx.input.issueRef, { boundOwnerAndRepo: remote });
  if (!parsed.ok) return refuse("invalid-reference", parsed.rejection);
  if (!sameGitHubOwnerAndRepo(parsed.reference.ownerAndRepo, remote)) {
    return numbered(
      refuse("repository-mismatch", "reference-names-other-repository"),
      parsed.reference.issueNumber,
    );
  }
  return produce({ ownerAndRepo: remote, issueNumber: parsed.reference.issueNumber });
}

// Step 3: the per-checkout grant, then the reader it admits. Neither a request field nor the
// issue text can reach either decision.
function resolveReader(ctx: ResolutionContext): Step<GitHubCodeContextApiPort> {
  const authorized = isGitHubIssueReaderAuthorized(ctx.deps, ctx.input.repositoryRoot, {
    correlationId: ctx.correlationId,
    activityLog: ctx.activityLog,
  });
  if (!authorized) return refuse("auth-required", "no-grant");
  const port =
    ctx.deps.codingContextGitHubPort ??
    gitHubCodeContextPortFor(ctx.input.repositoryRoot, ctx.deps.env);
  return port === undefined ? refuse("auth-required", "reader-unavailable") : produce(port);
}

// Step 4: the read itself, through the same two projections the context pack uses.
async function readIssue(
  ctx: ResolutionContext,
  port: GitHubCodeContextApiPort,
  ref: GitHubCodeContextRef,
): Promise<Step<CodeContextRawObject>> {
  let raw: CodeContextRawObject;
  try {
    const [objectJson, commentsJson] = await Promise.all([
      port.readJson(buildGitHubCodeContextArgv(ref), {
        signal: ctx.input.signal,
        correlationId: ctx.correlationId,
      }),
      port.readJson(buildGitHubCodeContextCommentsArgv(ref), {
        signal: ctx.input.signal,
        correlationId: ctx.correlationId,
      }),
    ]);
    raw = gitHubCodeContextRawObjectFrom(ref, objectJson, commentsJson);
  } catch (error) {
    if (ctx.input.signal?.aborted === true) return refuse("cancelled", "aborted");
    return refuse("issue-unavailable", "read-failed", error);
  }
  const aborted = cancelledIfAborted(ctx.input.signal);
  return aborted.ok ? produce(raw) : aborted;
}

// Step 5: what the provider reported must be an OPEN ISSUE that still lives at the reference.
// GitHub answers a transferred issue's old address with the issue at its new one, so the
// provider's own URL is parsed by the same parser and compared against the checkout's remote;
// an issue that moved or was renumbered is refused, never silently rebound.
function issueUnavailableReason(
  raw: CodeContextRawObject,
  ownerAndRepo: string,
  issueNumber: number,
): GitHubIssueResolutionReason | undefined {
  if (raw.providerNodeId === undefined) return "identity-missing";
  if (raw.isPullRequest === undefined || raw.state === undefined) return "state-unknown";
  if (raw.isPullRequest) return "pull-request-as-issue";
  if (raw.state !== "open") return "closed";
  const provenance = parseGitHubIssueReference(raw.url ?? "");
  if (!provenance.ok) return "provenance-unreadable";
  if (!sameGitHubOwnerAndRepo(provenance.reference.ownerAndRepo, ownerAndRepo))
    return "transferred";
  if (provenance.reference.issueNumber !== issueNumber) return "renumbered";
  return undefined;
}

// Step 6: the server-resolved default branch — the run envelope's base ref. A checkout that does
// not record one is an incomplete clone, so that is the state it is refused with.
async function resolveDefaultBranch(ctx: ResolutionContext): Promise<Step<string>> {
  let branch: string | undefined;
  try {
    branch = await ctx.ports.readDefaultBranch(ctx.input.repositoryRoot, {
      env: ctx.deps.env,
      signal: ctx.input.signal,
      activityLog: ctx.activityLog,
      correlationId: ctx.correlationId,
    });
  } catch (error) {
    const aborted = cancelledIfAborted(ctx.input.signal);
    if (!aborted.ok) return aborted;
    return refuse("clone-failed", "default-branch-read-failed", error);
  }
  const aborted = cancelledIfAborted(ctx.input.signal);
  if (!aborted.ok) return aborted;
  return branch === undefined
    ? refuse("clone-failed", "default-branch-unresolved")
    : produce(branch);
}

function bindingFor(
  repositoryId: string,
  ownerAndRepo: string,
  issueNumber: number,
  raw: CodeContextRawObject,
  defaultBaseRef: string,
): CodingWorkbenchIssueBinding {
  const fields = {
    schemaVersion: CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
    repositoryId,
    remoteDigest: codingWorkbenchRemoteDigest(ownerAndRepo),
    issueNumber,
    issueIdDigest: sha256Hex(raw.providerNodeId ?? ""),
    defaultBaseRef,
    contentRevisionDigest: codeContextContentDigest(raw),
  };
  return { ...fields, bindingDigest: codingWorkbenchIssueBindingDigest(fields) };
}

function boundedText(
  value: string,
  maxChars: number,
): { readonly text: string; readonly truncated: boolean } {
  const safe = stripUnsafeFormatChars(value);
  return safe.length <= maxChars
    ? { text: safe, truncated: false }
    : { text: safe.slice(0, maxChars), truncated: true };
}

function previewFor(
  ownerAndRepo: string,
  issueNumber: number,
  raw: CodeContextRawObject,
): CodingWorkbenchIssuePreview {
  const excerpt = boundedText(raw.body, CODING_WORKBENCH_ISSUE_PREVIEW_EXCERPT_MAX_CHARS);
  return {
    untrusted: true,
    title: boundedText(raw.title, CODING_WORKBENCH_ISSUE_PREVIEW_TITLE_MAX_CHARS).text,
    bodyExcerpt: excerpt.text,
    bodyExcerptTruncated: excerpt.truncated,
    commentCount: raw.commentCount ?? raw.comments.length,
    comments: raw.comments.slice(0, 8).map((comment) => boundedText(comment.body, 1_024).text),
    commentsTruncated:
      (raw.commentCount ?? raw.comments.length) > 8 ||
      raw.comments.slice(0, 8).some((comment) => boundedText(comment.body, 1_024).truncated),
    state: "open",
    provenance: {
      ownerAndRepo,
      issueNumber,
      // Server-constructed from the resolved repository, never the provider's URL echoed back.
      url: `https://github.com/${ownerAndRepo}/issues/${String(issueNumber)}`,
    },
  };
}

// Success is debug (a healthy deployment does not pay for a line per preview), an expected
// refusal is information, and a fault someone has to look at is a warning.
function levelFor(
  outcome: CodingWorkbenchIssueBindingFailure | "resolved",
  errorKind: string | undefined,
): ServerLogLevel {
  if (outcome === "resolved") return "debug";
  return errorKind === undefined ? "info" : "warn";
}

function record(
  ctx: ResolutionContext,
  outcome: CodingWorkbenchIssueBindingFailure | "resolved",
  detail: {
    readonly reason?: GitHubIssueResolutionReason | undefined;
    readonly errorKind?: string | undefined;
    readonly frames?: readonly string[] | undefined;
    readonly causeChain?: ReturnType<typeof causeChain> | undefined;
    readonly issueNumber?: number | undefined;
    readonly repositoryId?: string | undefined;
  },
): void {
  ctx.activityLog.write({
    level: levelFor(outcome, detail.errorKind),
    category: "security",
    op: "coding-workbench.issue.resolved",
    correlationId: ctx.correlationId,
    ...(detail.errorKind === undefined ? {} : { errorKind: detail.errorKind }),
    extra: {
      outcome,
      ...(detail.issueNumber === undefined ? {} : { issueNumber: detail.issueNumber }),
      ...(detail.repositoryId === undefined ? {} : { repositoryId: detail.repositoryId }),
      ...(detail.reason === undefined ? {} : { reason: detail.reason }),
      ...(detail.frames === undefined
        ? {}
        : { frames: detail.frames, causeChain: detail.causeChain }),
    },
  });
}

interface Resolved {
  readonly binding: CodingWorkbenchIssueBinding;
  readonly preview: CodingWorkbenchIssuePreview;
  readonly issueNumber: number;
  readonly contextObject: CodeContextRawObject;
}

// The steps in order; each one ends the resolution with its refusal or hands its value on.
async function runSteps(ctx: ResolutionContext, repositoryId: string): Promise<Step<Resolved>> {
  const started = cancelledIfAborted(ctx.input.signal);
  if (!started.ok) return started;
  const remote = await resolveRemote(ctx);
  if (!remote.ok) return remote;
  const reference = resolveReference(ctx, remote.value);
  if (!reference.ok) return reference;
  const { ownerAndRepo, issueNumber } = reference.value;
  if (ctx.input.signal?.aborted === true)
    return numbered(refuse("cancelled", "aborted"), issueNumber);
  const reader = resolveReader(ctx);
  if (!reader.ok) return numbered(reader, issueNumber);
  const ref: GitHubCodeContextRef = {
    source: "github",
    objectKind: "issue",
    ownerAndRepo,
    objectId: String(issueNumber),
  };
  const raw = await readIssue(ctx, reader.value, ref);
  if (!raw.ok) return numbered(raw, issueNumber);
  const unavailable = issueUnavailableReason(raw.value, ownerAndRepo, issueNumber);
  if (unavailable !== undefined) {
    return numbered(refuse(failureForReason(unavailable), unavailable), issueNumber);
  }
  const defaultBaseRef = await resolveDefaultBranch(ctx);
  if (!defaultBaseRef.ok) return numbered(defaultBaseRef, issueNumber);
  return produce({
    binding: bindingFor(repositoryId, ownerAndRepo, issueNumber, raw.value, defaultBaseRef.value),
    preview: previewFor(ownerAndRepo, issueNumber, raw.value),
    issueNumber,
    contextObject: raw.value,
  });
}

function failureForReason(reason: GitHubIssueResolutionReason): CodingWorkbenchIssueBindingFailure {
  if (reason === "pull-request-as-issue") return "invalid-reference";
  return reason === "transferred" ? "repository-mismatch" : "issue-unavailable";
}

/**
 * Build a resolver. Production callers use `resolveGitHubIssue` below; a test binds its own
 * default-branch reader here and injects the GitHub port and remote resolver through `deps`.
 */
export function createGitHubIssueResolver(
  ports: GitHubIssueResolverPorts = PRODUCTION_PORTS,
): GitHubIssueResolver {
  return async (deps, input): Promise<GitHubIssueResolution> => {
    const ctx: ResolutionContext = {
      deps,
      input,
      ports,
      activityLog: deps.activityLog ?? processServerLogSink(),
      correlationId: input.correlationId ?? UNKNOWN_CORRELATION_ID,
    };
    const repositoryId = githubIssueReaderRepositoryId(input.repositoryRoot);
    if (repositoryId === undefined) {
      record(ctx, "repository-mismatch", { reason: "repository-unresolved" });
      return { ok: false, failure: "repository-mismatch", failureReason: "repository-unresolved" };
    }
    const outcome = await runSteps(ctx, repositoryId);
    if (outcome.ok) {
      record(ctx, "resolved", { issueNumber: outcome.value.issueNumber, repositoryId });
      return {
        ok: true,
        binding: outcome.value.binding,
        preview: outcome.value.preview,
        contextObject: outcome.value.contextObject,
      };
    }
    record(ctx, outcome.refusal.failure, {
      reason: outcome.refusal.reason,
      errorKind: outcome.refusal.errorKind,
      issueNumber: outcome.refusal.issueNumber,
      repositoryId,
    });
    return { ok: false, failure: outcome.refusal.failure, failureReason: outcome.refusal.reason };
  };
}

/** The production resolver: keiko-tools reads the default branch, `deps` supplies everything else. */
export const resolveGitHubIssue: GitHubIssueResolver = createGitHubIssueResolver();
