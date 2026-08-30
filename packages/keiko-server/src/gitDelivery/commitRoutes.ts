// Governed local Git commit routes: read-only preview + governed execute (Issue #475, Epic #470).
//
//   * POST /api/git-delivery/commit/preview  — READ-ONLY. Builds the pre-commit verification context:
//       staged scope, commit-intent quality warnings (mixed-scope / WIP / large-change), message-policy
//       validation of the draft, preflight findings, and the policy decision. Never mutates, never
//       records evidence.
//   * POST /api/git-delivery/commit/execute  — Governed. Enforces the message policy FIRST (the kernel
//       only sees a byte length, so message rules are evaluated here with the pure contract validator);
//       a violation blocks the commit with typed codes BEFORE the kernel runs. SECOND, refuses to
//       commit staged content that still contains an unresolved merge-conflict marker (`git add`
//       clears git's own "unmerged path" state the moment a conflicted file is staged, so nothing
//       downstream — the worktree snapshot, the kernel's preflight, the commit adapter — would
//       otherwise ever notice a conflicted file whose markers were staged without being resolved; the
//       commit would silently bake the literal marker lines into history). A message that passes both
//       gates drives executeGovernedMutation (preflight + policy + approval + execute) and appends
//       evidence.
//
// Logs and evidence stay content-free: counts, structural area tokens, typed
// warning/violation/finding codes, never the message body, diff, or raw paths. The UI-facing draft
// suggestion is an editable convenience built from bounded structural path labels and is never
// persisted as evidence.

import type { IncomingMessage } from "node:http";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type {
  GitCommitChangeSummary,
  GitCommitIntentAnalysis,
  GitCommitMessagePolicy,
  GitCommitMessageValidation,
  GitDeliveryResolvedInputs,
} from "@oscharko-dev/keiko-contracts";
import {
  analyzeGitCommitIntent,
  suggestGitCommitMessage,
} from "@oscharko-dev/keiko-contracts/runtime/git-commit-intent";
import {
  evaluateGitDeliveryEffectivePolicy,
  evaluateGitPolicy,
} from "@oscharko-dev/keiko-contracts/runtime/git-delivery-policy";
import { gitDeliveryRiskClassForInputs } from "@oscharko-dev/keiko-contracts/runtime/git-delivery";
import { validateGitCommitMessage } from "@oscharko-dev/keiko-contracts/runtime/git-commit-policy";
import {
  evaluateGitPreflight,
  summarizeStagedChangeset,
  type GitWorktreeSnapshot,
} from "@oscharko-dev/keiko-tools";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import type { ServerLogSink } from "../observability/server-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import { gitDeliveryAuthorityDenial } from "./requestPreparation.js";
import {
  parseGitDeliveryApprovalRequest,
  resolveGitDeliveryApprovalRequirement,
  type ParsedGitDeliveryApprovalRequest,
} from "./approvalStore.js";
import {
  executeGovernedMutation,
  gitDeliveryMutationResponse,
  gitDeliveryTerminationHandler,
  KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK,
  readStagedConflictMarkerFileCountFor,
  readStagedPathsFor,
  readWorktreeSnapshotFor,
  resolveProjectWorkspace,
  type GitDeliveryExecutionSeams,
} from "./execution.js";
import {
  hasOnlyAllowedKeys,
  isNonEmptyString,
  isPlainObject,
  readParsedGitDeliveryBody,
  scanForbiddenStrings,
  scanUnsafeFormatChars,
  type GitDeliveryParsedBody,
} from "./requestGuards.js";
import { resolveGovernedCommitMessagePolicy } from "./commitPolicySettings.js";
import { defaultMintableRepoPack } from "./policyPackMintability.js";
import {
  createTrustedGitDeliveryBranchProtectionReader,
  signatureRequirementOf,
  type GitDeliverySignatureRequirement,
} from "./branchProtectionPreflight.js";

// ─── Error envelope ───────────────────────────────────────────────────────────────────────────

export type GitDeliveryCommitErrorCode =
  | "GIT_DELIVERY_COMMIT_BAD_REQUEST"
  | "GIT_DELIVERY_COMMIT_PAYLOAD_TOO_LARGE"
  | "GIT_DELIVERY_COMMIT_FORBIDDEN_PAYLOAD"
  | "GIT_DELIVERY_COMMIT_UNKNOWN_PROJECT"
  | "GIT_DELIVERY_COMMIT_WORKTREE_UNAVAILABLE";

const SAFE_MESSAGES: Readonly<Record<GitDeliveryCommitErrorCode, string>> = {
  GIT_DELIVERY_COMMIT_BAD_REQUEST: "The request body is not a valid governed commit request.",
  GIT_DELIVERY_COMMIT_PAYLOAD_TOO_LARGE: "The governed commit request exceeds the maximum size.",
  GIT_DELIVERY_COMMIT_FORBIDDEN_PAYLOAD:
    "The request contained a forbidden field. Requests may not carry credentials, headers, or URLs.",
  GIT_DELIVERY_COMMIT_UNKNOWN_PROJECT: "The requested project is not a known workspace.",
  GIT_DELIVERY_COMMIT_WORKTREE_UNAVAILABLE:
    "The repository worktree could not be inspected. Confirm the project is a Git repository.",
};

const errResult = (status: number, code: GitDeliveryCommitErrorCode): RouteResult => ({
  status,
  body: { error: { code, message: SAFE_MESSAGES[code] } },
});

const UTF8 = new TextEncoder();

// ─── Options ────────────────────────────────────────────────────────────────────────────────

export interface GitDeliveryCommitRouteOptions {
  readonly execution?: GitDeliveryExecutionSeams;
  // Test/deployment override. Production resolves the persisted governed setting for the workspace.
  readonly messagePolicy?: GitCommitMessagePolicy;
  // Test seam. Production writes content-free preview evidence through the process activity log.
  readonly activityLog?: ServerLogSink;
}

const readParsed = (req: IncomingMessage): Promise<GitDeliveryParsedBody<RouteResult>> =>
  readParsedGitDeliveryBody(
    req,
    () => errResult(413, "GIT_DELIVERY_COMMIT_PAYLOAD_TOO_LARGE"),
    () => errResult(400, "GIT_DELIVERY_COMMIT_BAD_REQUEST"),
  );

// Envelope pre-checks shared by both handlers. Returns the validated object or an error RouteResult.
function preValidate(
  parsed: unknown,
  allowed: ReadonlySet<string>,
):
  | { readonly ok: true; readonly obj: Record<string, unknown> }
  | { readonly ok: false; readonly result: RouteResult } {
  const bad = { ok: false as const, result: errResult(400, "GIT_DELIVERY_COMMIT_BAD_REQUEST") };
  if (!isPlainObject(parsed) || !hasOnlyAllowedKeys(parsed, allowed)) return bad;
  if (parsed.schemaVersion !== "1" || !isNonEmptyString(parsed.projectId)) return bad;
  if (scanForbiddenStrings(parsed)) {
    return { ok: false, result: errResult(400, "GIT_DELIVERY_COMMIT_FORBIDDEN_PAYLOAD") };
  }
  if (scanUnsafeFormatChars(parsed)) return bad;
  return { ok: true, obj: parsed };
}

// ─── Preview (read-only) ──────────────────────────────────────────────────────────────────────

const PREVIEW_KEYS: ReadonlySet<string> = new Set(["schemaVersion", "projectId", "messageDraft"]);

export interface GitDeliveryCommitPreviewBody {
  readonly schemaVersion: "1";
  readonly summary: GitCommitChangeSummary;
  readonly intent: GitCommitIntentAnalysis;
  readonly messageValidation: GitCommitMessageValidation;
  readonly preflightFindingCodes: readonly string[];
  readonly signatureRequirement: GitDeliverySignatureRequirement;
  readonly policyOutcome: string;
  readonly suggestedMessage?: string;
  readonly policyBlockReason?: string;
}

interface DraftPathFacts {
  readonly labels: readonly string[];
  readonly allConfig: boolean;
  readonly allDocs: boolean;
  readonly allTests: boolean;
  readonly hasTests: boolean;
  readonly scope: string | undefined;
}

type DraftPathCategory = "config" | "docs" | "source" | "test";

const TEST_PATH_PATTERN = /(?:^|\/)(?:__tests__\/|[^/]+\.(?:spec|test)\.[^/]+$)/iu;
const DOC_PATH_PATTERN = /\.(?:md|mdx|rst|txt)$/iu;
const CONFIG_FILE_NAMES: ReadonlySet<string> = new Set([
  "dockerfile",
  "makefile",
  "package-lock.json",
  "package.json",
]);
const CONFIG_FILE_EXTENSIONS: ReadonlySet<string> = new Set(["toml", "yaml", "yml"]);
const DRAFT_SCOPE_CONTAINERS: ReadonlySet<string> = new Set(["apps", "packages", "services"]);

function normalizeDraftPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function isConfigPath(path: string): boolean {
  const fileName = path.split("/").at(-1)?.toLowerCase() ?? "";
  if (CONFIG_FILE_NAMES.has(fileName)) return true;
  if (fileName === "tsconfig.json") return true;
  if (fileName.startsWith("tsconfig.") && fileName.endsWith(".json")) return true;
  const segments = fileName.split(".");
  const extension = segments.at(-1);
  if (extension !== undefined && CONFIG_FILE_EXTENSIONS.has(extension)) return true;
  return segments.length >= 3 && segments.at(-2) === "config";
}

function draftPathCategory(path: string): DraftPathCategory {
  if (TEST_PATH_PATTERN.test(path)) return "test";
  if (path.startsWith("docs/") || DOC_PATH_PATTERN.test(path)) return "docs";
  if (isConfigPath(path)) return "config";
  return "source";
}

function readableDraftToken(value: string): string {
  const token = value
    .replace(/\.(?:spec|test)$/iu, "")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[^A-Za-z0-9]+/gu, " ")
    .trim()
    .toLowerCase()
    .slice(0, 48);
  return token.length > 1 ? token : "";
}

function labelForDraftPath(path: string): string {
  const category = draftPathCategory(path);
  if (category === "docs") return "documentation";
  if (category === "test") return "test coverage";
  if (category === "config") return "configuration";
  const segments = path.split("/");
  const fileName = segments.at(-1) ?? "";
  const stem = fileName.replace(/\.[^.]+$/u, "");
  const candidate = stem === "index" ? (segments.at(-2) ?? stem) : stem;
  return readableDraftToken(candidate) || "selected files";
}

function uniqueLimitedLabels(paths: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const path of paths) {
    const label = labelForDraftPath(path);
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
    if (labels.length === 4) return labels;
  }
  return labels;
}

function draftScopeCandidate(segments: readonly string[]): string | undefined {
  const containerIndex = segments.findIndex((segment) => DRAFT_SCOPE_CONTAINERS.has(segment));
  if (containerIndex >= 0) {
    const packageSegment = segments[containerIndex + 1];
    return packageSegment?.startsWith("@") ? segments[containerIndex + 2] : packageSegment;
  }
  return segments.length > 1 ? segments[0] : undefined;
}

function trimHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (value[start] === "-") start += 1;
  while (end > start && value[end - 1] === "-") end -= 1;
  return value.slice(start, end);
}

function draftScope(paths: readonly string[]): string | undefined {
  const candidates = paths.map((path): string | undefined => {
    const segments = path.split("/");
    const raw = draftScopeCandidate(segments);
    if (raw === undefined) return undefined;
    const normalized = raw
      .toLowerCase()
      .replace(/^keiko-/u, "")
      .replace(/[^a-z0-9-]+/gu, "-");
    return trimHyphens(normalized).slice(0, 32) || undefined;
  });
  const first = candidates[0];
  return first !== undefined && candidates.every((candidate) => candidate === first)
    ? first
    : undefined;
}

function collectDraftPathFacts(stagedPaths: readonly string[]): DraftPathFacts {
  const paths = stagedPaths.map(normalizeDraftPath);
  const categories = paths.map(draftPathCategory);
  return {
    labels: uniqueLimitedLabels(paths),
    allConfig: categories.every((category) => category === "config"),
    allDocs: categories.every((category) => category === "docs"),
    allTests: categories.every((category) => category === "test"),
    hasTests: categories.includes("test"),
    scope: draftScope(paths),
  };
}

function humanList(labels: readonly string[]): string {
  if (labels.length === 0) return "selected changes";
  if (labels.length === 1) return labels[0] ?? "selected changes";
  if (labels.length === 2) return `${labels[0] ?? ""} and ${labels[1] ?? ""}`;
  const head = labels.slice(0, -1).join(", ");
  return `${head}, and ${labels.at(-1) ?? "selected changes"}`;
}

function preferredDraftType(facts: DraftPathFacts): string {
  if (facts.allDocs) return "docs";
  if (facts.allTests) return "test";
  return "chore";
}

function allowedDraftType(
  preferredType: string,
  intent: GitCommitIntentAnalysis,
  policy: GitCommitMessagePolicy,
): string | undefined {
  if (!policy.conventionalCommit.enabled) return undefined;
  const candidates = [
    preferredType,
    intent.suggestedType,
    "chore",
    policy.conventionalCommit.allowedTypes[0],
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && policy.conventionalCommit.allowedTypes.includes(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function capitalizeDraftSubject(phrase: string): string {
  const first = phrase[0];
  if (first === undefined) return phrase;
  return `${first.toUpperCase()}${phrase.slice(1)}`;
}

function draftSubjectPhrase(facts: DraftPathFacts): string {
  if (facts.allDocs) return "update documentation";
  if (facts.allTests) return "update test coverage";
  if (facts.allConfig) return "update configuration";
  if (facts.labels.length > 2)
    return `update ${facts.labels[0] ?? "selected files"} and related changes`;
  return `update ${humanList(facts.labels)}`;
}

function buildDraftSubject(
  facts: DraftPathFacts,
  intent: GitCommitIntentAnalysis,
  policy: GitCommitMessagePolicy,
): string | undefined {
  const phrase = draftSubjectPhrase(facts);
  const type = allowedDraftType(preferredDraftType(facts), intent, policy);
  if (type === undefined) {
    const plain = capitalizeDraftSubject(phrase);
    return plain.length <= policy.subjectMaxLength ? plain : undefined;
  }
  const candidates = [
    ...(facts.scope === undefined ? [] : [`${type}(${facts.scope}): ${phrase}`]),
    `${type}: ${phrase}`,
    `${type}: update staged changes`,
  ];
  return candidates.find((candidate) => candidate.length <= policy.subjectMaxLength);
}

function buildSpecificDraftBody(facts: DraftPathFacts, summary: GitCommitChangeSummary): string {
  const lines = [
    `Update the staged ${humanList(facts.labels)}.`,
    "Keep the commit limited to the selected staged files.",
  ];
  if (summary.touchesTests || facts.hasTests) {
    lines.push("Includes related test coverage.");
  }
  return lines.join("\n");
}

function suggestSpecificCommitMessage(
  stagedPaths: readonly string[],
  summary: GitCommitChangeSummary,
  intent: GitCommitIntentAnalysis,
  policy: GitCommitMessagePolicy,
): string | undefined {
  if (summary.stagedFileCount === 0 || stagedPaths.length === 0) return undefined;
  const facts = collectDraftPathFacts(stagedPaths);
  const subject = buildDraftSubject(facts, intent, policy);
  if (subject === undefined) return suggestGitCommitMessage(intent, policy, summary);
  const message = `${subject}\n\n${buildSpecificDraftBody(facts, summary)}`;
  return validateGitCommitMessage(message, policy).ok
    ? message
    : suggestGitCommitMessage(intent, policy, summary);
}

interface PreviewBodyInput {
  readonly summary: GitCommitChangeSummary;
  readonly stagedPaths: readonly string[];
  readonly messageDraft: string;
  readonly policy: GitCommitMessagePolicy;
  readonly preflightCodes: readonly string[];
  readonly signatureRequirement: GitDeliverySignatureRequirement;
  readonly policyOutcome: string;
  readonly policyBlockReason: string | undefined;
}

function buildPreviewBody(input: PreviewBodyInput): GitDeliveryCommitPreviewBody {
  const intent = analyzeGitCommitIntent({ summary: input.summary, message: input.messageDraft });
  const suggestedMessage = suggestSpecificCommitMessage(
    input.stagedPaths,
    input.summary,
    intent,
    input.policy,
  );
  return {
    schemaVersion: "1",
    summary: input.summary,
    intent,
    messageValidation: validateGitCommitMessage(input.messageDraft, input.policy),
    preflightFindingCodes: input.preflightCodes,
    signatureRequirement: input.signatureRequirement,
    policyOutcome: input.policyOutcome,
    ...(suggestedMessage !== undefined ? { suggestedMessage } : {}),
    ...(input.policyBlockReason !== undefined
      ? { policyBlockReason: input.policyBlockReason }
      : {}),
  };
}

function logCommitPreview(
  log: ServerLogSink,
  correlationId: string | undefined,
  body: GitDeliveryCommitPreviewBody,
): void {
  log.write({
    category: "diagnostic",
    op: "git.commit.preview.completed",
    correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
    status: 200,
    extra: {
      stagedFileCount: body.summary.stagedFileCount,
      areaCount: body.summary.areaCount,
      touchesTests: body.summary.touchesTests,
      draftSuggested: body.suggestedMessage !== undefined,
      policyOutcome: body.policyOutcome,
    },
  });
}

type CommitFailureDetails = Omit<Parameters<typeof serverDiagnosticFromError>[0], "operation">;

function commitFailureDetails(correlationId: string, error: unknown): CommitFailureDetails {
  return {
    correlationId,
    source: "git-delivery.commit-routes",
    error,
    summary: "server-operation-failed",
    redact: (): string => "server-operation-failed",
  } as const;
}

function reportBranchProtectionFailure(
  deps: Pick<UiHandlerDeps, "diagnostics">,
  correlationId: string,
  error: unknown,
): void {
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      ...commitFailureDetails(correlationId, error),
      operation: "git.commit.preview.branch-protection",
    }),
  );
}

function reportPreviewWorktreeFailure(
  deps: Pick<UiHandlerDeps, "diagnostics">,
  correlationId: string,
  error: unknown,
): void {
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      ...commitFailureDetails(correlationId, error),
      operation: "git.commit.preview.worktree",
    }),
  );
}

function reportConflictScanFailure(
  deps: Pick<UiHandlerDeps, "diagnostics">,
  correlationId: string,
  error: unknown,
): void {
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      ...commitFailureDetails(correlationId, error),
      operation: "git.commit.execute.conflict-scan",
    }),
  );
}

function reportCommitMutationFailure(
  deps: Pick<UiHandlerDeps, "diagnostics">,
  correlationId: string,
  error: unknown,
): void {
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      ...commitFailureDetails(correlationId, error),
      operation: "git.commit.execute.mutation",
    }),
  );
}

function preferredRemoteAlias(snapshot: GitWorktreeSnapshot): string | undefined {
  return snapshot.remoteAliases.includes("origin") ? "origin" : snapshot.remoteAliases[0];
}

async function commitSignatureRequirement(
  workspace: WorkspaceInfo,
  snapshot: GitWorktreeSnapshot,
  seams: GitDeliveryExecutionSeams,
  correlationId: string,
  reportFailure: (error: unknown) => void,
): Promise<GitDeliverySignatureRequirement> {
  const branchName = snapshot.currentBranchName;
  const remoteAlias = preferredRemoteAlias(snapshot);
  if (branchName === undefined || remoteAlias === undefined) return "unavailable";
  const reader =
    seams.branchProtectionReader ??
    createTrustedGitDeliveryBranchProtectionReader(
      gitDeliveryTerminationHandler(seams, correlationId),
    );
  try {
    return signatureRequirementOf(await reader(workspace, remoteAlias, branchName));
  } catch (error) {
    reportFailure(error);
    return "unavailable";
  }
}

function signatureFinding(requirement: GitDeliverySignatureRequirement): readonly string[] {
  if (requirement === "required") return ["signed-commits-required"];
  return requirement === "unavailable" ? ["branch-protection-unavailable"] : [];
}

function previewEffectivePolicy(
  snapshot: GitWorktreeSnapshot,
  commitInputs: GitDeliveryResolvedInputs,
  seams: GitDeliveryExecutionSeams,
): ReturnType<typeof evaluateGitDeliveryEffectivePolicy> {
  const packs = seams.policyPacks ?? defaultMintableRepoPack(KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK);
  const targetBranchName = snapshot.currentBranchName;
  const decision = evaluateGitPolicy(packs.orgPack, packs.repoPack, {
    actionKind: "commit",
    ...(targetBranchName === undefined ? {} : { targetBranchName }),
    activeProviderCapabilities: [],
  });
  return evaluateGitDeliveryEffectivePolicy(decision, {
    riskClass: gitDeliveryRiskClassForInputs(commitInputs),
    targetBranchName,
    activeProviderCapabilities: [],
  });
}

// Reads the live worktree and assembles the read-only preview. May throw if the worktree cannot be
// inspected (not a git repository); the handler maps that to a typed content-free error.
async function computePreview(
  workspace: WorkspaceInfo,
  messageDraft: string,
  policy: GitCommitMessagePolicy,
  seams: GitDeliveryExecutionSeams,
  now: () => number,
  correlationId: string,
  reportFailure: (error: unknown) => void,
): Promise<GitDeliveryCommitPreviewBody> {
  const snapshot = await readWorktreeSnapshotFor(workspace, seams, now, correlationId);
  const stagedPaths = await readStagedPathsFor(workspace, seams, now, correlationId);
  const summary = summarizeStagedChangeset(stagedPaths);
  const commitInputs: GitDeliveryResolvedInputs = {
    kind: "commit",
    messageByteLength: UTF8.encode(messageDraft).length,
    // The path read is the exact selection summarized and drafted below. Using the independently
    // sampled snapshot count here could make policy and preflight describe a different selection.
    stagedPathCount: stagedPaths.length,
    allowEmptyCommit: false,
  };
  const previewSnapshot = { ...snapshot, stagedFileCount: stagedPaths.length };
  const preflight = evaluateGitPreflight(commitInputs, previewSnapshot);
  const signatureRequirement = await commitSignatureRequirement(
    workspace,
    snapshot,
    seams,
    correlationId,
    reportFailure,
  );
  const effectivePolicy = previewEffectivePolicy(snapshot, commitInputs, seams);
  return buildPreviewBody({
    summary,
    stagedPaths,
    messageDraft,
    policy,
    preflightCodes: [
      ...preflight.findings.map((finding) => finding.code),
      ...signatureFinding(signatureRequirement),
    ],
    signatureRequirement,
    policyOutcome: effectivePolicy.outcome,
    policyBlockReason:
      effectivePolicy.outcome === "blocked" ? effectivePolicy.blockReason : undefined,
  });
}

export const createHandleCommitPreview = (
  options: GitDeliveryCommitRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  // ONE resolved sink for both the preview line and the termination callbacks inside `seams`.
  // They used to resolve separately: preview logging honoured `options.activityLog`, while the
  // termination evidence read `seams.activityLog` and fell back to the global
  // `processServerLogSink()`. A caller that set only `options.activityLog` — every test that
  // injects a sink to observe this route — therefore saw its preview lines but never the
  // termination evidence, which went somewhere it was not looking. The more specific
  // `execution.activityLog` still wins when a caller sets both.
  const activityLog =
    options.execution?.activityLog ?? options.activityLog ?? processServerLogSink();
  const seams = { ...options.execution, activityLog };
  const now = (): number => (seams.now ?? Date.now)();
  return async (ctx, deps): Promise<RouteResult> => {
    const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
    const read = await readParsed(ctx.req);
    if (!read.ok) return read.result;
    const pre = preValidate(read.value, PREVIEW_KEYS);
    if (!pre.ok) return pre.result;
    const messageDraft = typeof pre.obj.messageDraft === "string" ? pre.obj.messageDraft : "";
    const workspace = resolveProjectWorkspace(deps, pre.obj.projectId as string);
    if (workspace === undefined) return errResult(404, "GIT_DELIVERY_COMMIT_UNKNOWN_PROJECT");
    const policy = await resolveGovernedCommitMessagePolicy(
      deps,
      workspace.root,
      options.messagePolicy,
    );
    let body: GitDeliveryCommitPreviewBody;
    try {
      body = await computePreview(
        workspace,
        messageDraft,
        policy,
        seams,
        now,
        correlationId,
        (error) => {
          reportBranchProtectionFailure(deps, correlationId, error);
        },
      );
    } catch (error) {
      reportPreviewWorktreeFailure(deps, correlationId, error);
      return errResult(409, "GIT_DELIVERY_COMMIT_WORKTREE_UNAVAILABLE");
    }
    logCommitPreview(activityLog, correlationId, body);
    return { status: 200, body: deps.redactor(body) };
  };
};

// ─── Execute (governed, with message-policy gate) ───────────────────────────────────────────────

const EXECUTE_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "projectId",
  "message",
  "allowEmpty",
  "approval",
]);

interface ExecuteRequest {
  readonly projectId: string;
  readonly message: string;
  readonly allowEmpty: boolean;
  readonly approval: ParsedGitDeliveryApprovalRequest;
}

function validateExecute(obj: Record<string, unknown>): ExecuteRequest | undefined {
  if (!isNonEmptyString(obj.message)) return undefined;
  if (obj.allowEmpty !== undefined && typeof obj.allowEmpty !== "boolean") return undefined;
  const approval = parseGitDeliveryApprovalRequest(obj.approval);
  if (approval === undefined) return undefined;
  return {
    projectId: obj.projectId as string,
    message: obj.message,
    allowEmpty: obj.allowEmpty === true,
    approval,
  };
}

interface PreparedCommitExecution {
  readonly request: ExecuteRequest;
  readonly workspace: WorkspaceInfo;
  readonly policy: GitCommitMessagePolicy;
}

type CommitExecutionPreparation =
  | { readonly ok: true; readonly value: PreparedCommitExecution }
  | { readonly ok: false; readonly result: RouteResult };

async function prepareCommitExecution(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  messagePolicy: GitCommitMessagePolicy | undefined,
): Promise<CommitExecutionPreparation> {
  const read = await readParsed(ctx.req);
  if (!read.ok) return read;
  const pre = preValidate(read.value, EXECUTE_KEYS);
  if (!pre.ok) return pre;
  const request = validateExecute(pre.obj);
  if (request === undefined)
    return { ok: false, result: errResult(400, "GIT_DELIVERY_COMMIT_BAD_REQUEST") };
  const workspace = resolveProjectWorkspace(deps, request.projectId);
  if (workspace === undefined)
    return { ok: false, result: errResult(404, "GIT_DELIVERY_COMMIT_UNKNOWN_PROJECT") };
  const policy = await resolveGovernedCommitMessagePolicy(deps, workspace.root, messagePolicy);
  return { ok: true, value: { request, workspace, policy } };
}

// Message-policy gate (AC2): a policy-violating message blocks the commit BEFORE the kernel runs.
// Returns undefined when the message is clean (proceed).
function messagePolicyBlockResult(
  message: string,
  policy: GitCommitMessagePolicy,
  deps: Pick<UiHandlerDeps, "redactor">,
): RouteResult | undefined {
  const validation = validateGitCommitMessage(message, policy);
  if (validation.ok) return undefined;
  return {
    status: 200,
    body: deps.redactor({
      schemaVersion: "1",
      status: "blocked",
      actionKind: "commit",
      blockReason: "message-policy",
      messageViolations: validation.violations,
    }),
  };
}

// Unresolved-conflict-marker gate: refuses to commit staged content that still contains a
// `<<<<<<<`/`=======`/`>>>>>>>` marker git-add-ed without being resolved. Runs BEFORE the kernel — by
// the time `git add` has staged the file, git's OWN "unmerged path" tracking for it is already
// cleared, so nothing downstream would otherwise ever notice. A read failure here (e.g. the worktree
// is not inspectable) fails closed to WORKTREE_UNAVAILABLE, same as every other worktree read this
// route performs. Returns undefined when nothing was flagged (proceed).
async function conflictMarkerBlockResult(
  workspace: WorkspaceInfo,
  seams: GitDeliveryExecutionSeams,
  correlationId: string,
  deps: Pick<UiHandlerDeps, "redactor">,
  reportFailure: (error: unknown) => void,
): Promise<RouteResult | undefined> {
  let conflictMarkerFileCount: number;
  try {
    conflictMarkerFileCount = await readStagedConflictMarkerFileCountFor(
      workspace,
      seams,
      seams.now ?? Date.now,
      correlationId,
    );
  } catch (error) {
    reportFailure(error);
    return errResult(409, "GIT_DELIVERY_COMMIT_WORKTREE_UNAVAILABLE");
  }
  if (conflictMarkerFileCount === 0) return undefined;
  return {
    status: 200,
    body: deps.redactor({
      schemaVersion: "1",
      status: "blocked",
      actionKind: "commit",
      blockReason: "unresolved-conflict-markers",
      conflictMarkerFileCount,
    }),
  };
}

// Builds the typed commit command, resolves the approval requirement, drives the kernel, and
// projects the content-free response. Extracted from createHandleCommitExecute's returned handler
// purely to stay under the function-length budget (AGENTS.md §6) — no behavioral seam of its own.
async function runCommitMutation(
  req: ExecuteRequest,
  workspace: WorkspaceInfo,
  seams: GitDeliveryExecutionSeams,
  correlationId: string,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const command = { kind: "commit" as const, message: req.message, allowEmpty: req.allowEmpty };
  const verifiedApproval = resolveGitDeliveryApprovalRequirement(req.approval, {
    store: seams.approvalStore,
    binding: { projectId: req.projectId, operation: "commit", command },
    nowMs: (seams.now ?? Date.now)(),
  });
  if (verifiedApproval === undefined) return errResult(400, "GIT_DELIVERY_COMMIT_BAD_REQUEST");
  try {
    const result = await executeGovernedMutation(
      command,
      verifiedApproval,
      workspace,
      deps,
      seams,
      correlationId,
    );
    return { status: 200, body: deps.redactor(gitDeliveryMutationResponse(result)) };
  } catch (error) {
    reportCommitMutationFailure(deps, correlationId, error);
    return errResult(409, "GIT_DELIVERY_COMMIT_WORKTREE_UNAVAILABLE");
  }
}

export const createHandleCommitExecute = (
  options: GitDeliveryCommitRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  // Same single resolution as the preview handler above, for the same reason: a caller that sets
  // only `options.activityLog` must still see this route's termination evidence.
  const seams = {
    ...options.execution,
    activityLog: options.execution?.activityLog ?? options.activityLog ?? processServerLogSink(),
  };
  return async (ctx, deps): Promise<RouteResult> => {
    const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
    const prepared = await prepareCommitExecution(ctx, deps, options.messagePolicy);
    if (!prepared.ok) return prepared.result;
    const { request: req, workspace, policy } = prepared.value;
    const authorityDenial = gitDeliveryAuthorityDenial(
      ctx,
      deps,
      req.projectId,
      workspace,
      "commit",
    );
    if (authorityDenial !== undefined) return authorityDenial;

    const messageBlock = messagePolicyBlockResult(req.message, policy, deps);
    if (messageBlock !== undefined) return messageBlock;

    const conflictBlock = await conflictMarkerBlockResult(
      workspace,
      seams,
      correlationId,
      deps,
      (error) => {
        reportConflictScanFailure(deps, correlationId, error);
      },
    );
    if (conflictBlock !== undefined) return conflictBlock;

    return runCommitMutation(req, workspace, seams, correlationId, deps);
  };
};

// ─── Route group ───────────────────────────────────────────────────────────────────────────────

export const createGitDeliveryCommitRouteGroup = (
  options: GitDeliveryCommitRouteOptions = {},
): readonly RouteDefinition[] => [
  {
    method: "POST",
    pattern: "/api/git-delivery/commit/preview",
    handler: createHandleCommitPreview(options),
  },
  {
    method: "POST",
    pattern: "/api/git-delivery/commit/execute",
    handler: createHandleCommitExecute(options),
  },
];

export const GIT_DELIVERY_COMMIT_ROUTE_GROUP: readonly RouteDefinition[] =
  createGitDeliveryCommitRouteGroup();
