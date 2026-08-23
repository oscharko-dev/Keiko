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
import {
  analyzeGitCommitIntent,
  evaluateGitDeliveryEffectivePolicy,
  evaluateGitPolicy,
  gitDeliveryRiskClassForInputs,
  suggestGitCommitMessage,
  validateGitCommitMessage,
  type GitCommitChangeSummary,
  type GitCommitIntentAnalysis,
  type GitCommitMessagePolicy,
  type GitCommitMessageValidation,
  type GitDeliveryResolvedInputs,
} from "@oscharko-dev/keiko-contracts";
import {
  evaluateGitPreflight,
  summarizeStagedChangeset,
  type GitWorktreeSnapshot,
} from "@oscharko-dev/keiko-tools";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import type { ServerLogSink } from "../observability/server-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import {
  parseGitDeliveryApprovalRequest,
  resolveGitDeliveryApprovalRequirement,
  type ParsedGitDeliveryApprovalRequest,
} from "./approvalStore.js";
import {
  executeGovernedMutation,
  gitDeliveryMutationResponse,
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
import {
  readTrustedGitDeliveryBranchProtection,
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
  readonly hasCodingRuntime: boolean;
  readonly hasDocs: boolean;
  readonly hasGitDraft: boolean;
  readonly hasModelGateway: boolean;
  readonly hasTests: boolean;
  readonly hasUi: boolean;
}

interface DraftLabelRule {
  readonly fragment: string;
  readonly label: string;
}

interface DraftSubjectRule {
  readonly preferredType: string;
  readonly scope: string;
  readonly phrase: string;
  readonly matches: (facts: DraftPathFacts) => boolean;
}

const DRAFT_LABEL_RULES: readonly DraftLabelRule[] = [
  { fragment: "git-commit-intent", label: "commit intent heuristics" },
  { fragment: "commitRoutes", label: "commit preview routing" },
  { fragment: "CommitComposer", label: "commit composer draft review" },
  { fragment: "GitClientWindow", label: "Git client workspace" },
  { fragment: "git-client-styles", label: "Git client layout styles" },
  { fragment: "coding-workbench-runtime", label: "coding workbench runtime API" },
  { fragment: "keiko-model-gateway/src/config", label: "model gateway configuration" },
  { fragment: "keiko-contracts/src/gateway", label: "gateway contracts" },
  { fragment: ".test.", label: "related test coverage" },
];

const DRAFT_SUBJECT_RULES: readonly DraftSubjectRule[] = [
  {
    preferredType: "feat",
    scope: "coding",
    phrase: "align runtime model settings",
    matches: (facts): boolean => facts.hasCodingRuntime && facts.hasModelGateway,
  },
  {
    preferredType: "feat",
    scope: "coding",
    phrase: "update coding workbench runtime",
    matches: (facts): boolean => facts.hasCodingRuntime,
  },
  {
    preferredType: "feat",
    scope: "models",
    phrase: "update model gateway configuration",
    matches: (facts): boolean => facts.hasModelGateway,
  },
  {
    preferredType: "fix",
    scope: "git",
    phrase: "improve git commit draft workflow",
    matches: (facts): boolean => facts.hasGitDraft,
  },
  {
    preferredType: "fix",
    scope: "ui",
    phrase: "improve ui workflow",
    matches: (facts): boolean => facts.hasUi,
  },
  {
    preferredType: "docs",
    scope: "docs",
    phrase: "update documentation",
    matches: (facts): boolean => facts.hasDocs,
  },
];

function normalizeDraftPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function hasPathFragment(paths: readonly string[], fragment: string): boolean {
  return paths.some((path): boolean => path.includes(fragment));
}

function fallbackDraftLabel(path: string): string {
  if (path.startsWith("docs/")) return "documentation";
  if (path.includes("packages/keiko-ui/")) return "UI files";
  if (path.includes("packages/keiko-server/")) return "server routes";
  if (path.includes("packages/keiko-contracts/")) return "shared contracts";
  const fileName = path.split("/").at(-1) ?? "selected files";
  return fileName.replace(/\.[^.]+$/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function labelForDraftPath(path: string): string {
  const match = DRAFT_LABEL_RULES.find((rule): boolean => path.includes(rule.fragment));
  return match?.label ?? fallbackDraftLabel(path);
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

function collectDraftPathFacts(stagedPaths: readonly string[]): DraftPathFacts {
  const paths = stagedPaths.map(normalizeDraftPath);
  return {
    labels: uniqueLimitedLabels(paths),
    hasCodingRuntime: hasPathFragment(paths, "coding-workbench-runtime"),
    hasDocs: paths.some((path): boolean => path.startsWith("docs/")),
    hasGitDraft:
      hasPathFragment(paths, "git-commit-intent") || hasPathFragment(paths, "git-client"),
    hasModelGateway: hasPathFragment(paths, "keiko-model-gateway/"),
    hasTests: hasPathFragment(paths, ".test."),
    hasUi: hasPathFragment(paths, "packages/keiko-ui/"),
  };
}

function humanList(labels: readonly string[]): string {
  if (labels.length === 0) return "selected changes";
  if (labels.length === 1) return labels[0] ?? "selected changes";
  if (labels.length === 2) return `${labels[0] ?? ""} and ${labels[1] ?? ""}`;
  const head = labels.slice(0, -1).join(", ");
  return `${head}, and ${labels.at(-1) ?? "selected changes"}`;
}

function fallbackSubjectRule(): DraftSubjectRule {
  return {
    preferredType: "chore",
    scope: "workspace",
    phrase: "align staged repository changes",
    matches: (): boolean => true,
  };
}

function selectDraftSubjectRule(facts: DraftPathFacts): DraftSubjectRule {
  return DRAFT_SUBJECT_RULES.find((rule): boolean => rule.matches(facts)) ?? fallbackSubjectRule();
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

function buildDraftSubject(
  rule: DraftSubjectRule,
  intent: GitCommitIntentAnalysis,
  policy: GitCommitMessagePolicy,
): string | undefined {
  const type = allowedDraftType(rule.preferredType, intent, policy);
  if (type === undefined) return capitalizeDraftSubject(rule.phrase);
  const scoped = `${type}(${rule.scope}): ${rule.phrase}`;
  if (scoped.length <= policy.subjectMaxLength) return scoped;
  const unscoped = `${type}: ${rule.phrase}`;
  return unscoped.length <= policy.subjectMaxLength ? unscoped : undefined;
}

function draftBodyVerb(rule: DraftSubjectRule): string {
  if (rule.phrase.startsWith("improve")) return "Improve";
  if (rule.phrase.startsWith("align")) return "Align";
  return "Update";
}

function buildSpecificDraftBody(
  facts: DraftPathFacts,
  rule: DraftSubjectRule,
  summary: GitCommitChangeSummary,
): string {
  const lines = [
    `${draftBodyVerb(rule)} the staged ${humanList(facts.labels)}.`,
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
  if (summary.stagedFileCount === 0) return undefined;
  const facts = collectDraftPathFacts(stagedPaths);
  const rule = selectDraftSubjectRule(facts);
  const subject = buildDraftSubject(rule, intent, policy);
  if (subject === undefined) return suggestGitCommitMessage(intent, policy, summary);
  const message = `${subject}\n\n${buildSpecificDraftBody(facts, rule, summary)}`;
  return validateGitCommitMessage(message, policy).ok
    ? message
    : suggestGitCommitMessage(intent, policy, summary);
}

function buildPreviewBody(
  summary: GitCommitChangeSummary,
  stagedPaths: readonly string[],
  messageDraft: string,
  policy: GitCommitMessagePolicy,
  preflightCodes: readonly string[],
  signatureRequirement: GitDeliverySignatureRequirement,
  policyOutcome: string,
  policyBlockReason: string | undefined,
): GitDeliveryCommitPreviewBody {
  const intent = analyzeGitCommitIntent({ summary, message: messageDraft });
  const suggestedMessage = suggestSpecificCommitMessage(stagedPaths, summary, intent, policy);
  return {
    schemaVersion: "1",
    summary,
    intent,
    messageValidation: validateGitCommitMessage(messageDraft, policy),
    preflightFindingCodes: preflightCodes,
    signatureRequirement,
    policyOutcome,
    ...(suggestedMessage !== undefined ? { suggestedMessage } : {}),
    ...(policyBlockReason !== undefined ? { policyBlockReason } : {}),
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

function preferredRemoteAlias(snapshot: GitWorktreeSnapshot): string | undefined {
  return snapshot.remoteAliases.includes("origin") ? "origin" : snapshot.remoteAliases[0];
}

async function commitSignatureRequirement(
  workspace: WorkspaceInfo,
  snapshot: GitWorktreeSnapshot,
  seams: GitDeliveryExecutionSeams,
): Promise<GitDeliverySignatureRequirement> {
  const branchName = snapshot.currentBranchName;
  const remoteAlias = preferredRemoteAlias(snapshot);
  if (branchName === undefined || remoteAlias === undefined) return "unavailable";
  const reader = seams.branchProtectionReader ?? readTrustedGitDeliveryBranchProtection;
  try {
    return signatureRequirementOf(await reader(workspace, remoteAlias, branchName));
  } catch {
    return "unavailable";
  }
}

function signatureFinding(requirement: GitDeliverySignatureRequirement): readonly string[] {
  if (requirement === "required") return ["signed-commits-required"];
  return requirement === "unavailable" ? ["branch-protection-unavailable"] : [];
}

// Reads the live worktree and assembles the read-only preview. May throw if the worktree cannot be
// inspected (not a git repository); the handler maps that to a typed content-free error.
async function computePreview(
  workspace: WorkspaceInfo,
  messageDraft: string,
  policy: GitCommitMessagePolicy,
  seams: GitDeliveryExecutionSeams,
  now: () => number,
): Promise<GitDeliveryCommitPreviewBody> {
  const snapshot = await readWorktreeSnapshotFor(workspace, seams, now);
  const stagedPaths = await readStagedPathsFor(workspace, seams, now);
  const summary = summarizeStagedChangeset(stagedPaths);
  const commitInputs: GitDeliveryResolvedInputs = {
    kind: "commit",
    messageByteLength: UTF8.encode(messageDraft).length,
    stagedPathCount: snapshot.stagedFileCount,
    allowEmptyCommit: false,
  };
  const preflight = evaluateGitPreflight(commitInputs, snapshot);
  const signatureRequirement = await commitSignatureRequirement(workspace, snapshot, seams);
  const packs = seams.policyPacks ?? { repoPack: KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK };
  const targetBranchName = snapshot.currentBranchName;
  const decision = evaluateGitPolicy(packs.orgPack, packs.repoPack, {
    actionKind: "commit",
    ...(targetBranchName !== undefined ? { targetBranchName } : {}),
    activeProviderCapabilities: [],
  });
  const effectivePolicy = evaluateGitDeliveryEffectivePolicy(decision, {
    riskClass: gitDeliveryRiskClassForInputs(commitInputs),
    targetBranchName,
    activeProviderCapabilities: [],
  });
  return buildPreviewBody(
    summary,
    stagedPaths,
    messageDraft,
    policy,
    [...preflight.findings.map((f) => f.code), ...signatureFinding(signatureRequirement)],
    signatureRequirement,
    effectivePolicy.outcome,
    effectivePolicy.outcome === "blocked" ? effectivePolicy.blockReason : undefined,
  );
}

export const createHandleCommitPreview = (
  options: GitDeliveryCommitRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  const seams = options.execution ?? {};
  const activityLog = options.activityLog ?? processServerLogSink();
  const now = (): number => (seams.now ?? Date.now)();
  return async (ctx, deps): Promise<RouteResult> => {
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
      body = await computePreview(workspace, messageDraft, policy, seams, now);
    } catch {
      return errResult(409, "GIT_DELIVERY_COMMIT_WORKTREE_UNAVAILABLE");
    }
    logCommitPreview(activityLog, ctx.correlationId, body);
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
  deps: Pick<UiHandlerDeps, "redactor">,
): Promise<RouteResult | undefined> {
  let conflictMarkerFileCount: number;
  try {
    conflictMarkerFileCount = await readStagedConflictMarkerFileCountFor(
      workspace,
      seams,
      seams.now ?? Date.now,
    );
  } catch {
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

export const createHandleCommitExecute = (
  options: GitDeliveryCommitRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  const seams = options.execution ?? {};
  return async (ctx, deps): Promise<RouteResult> => {
    const read = await readParsed(ctx.req);
    if (!read.ok) return read.result;
    const pre = preValidate(read.value, EXECUTE_KEYS);
    if (!pre.ok) return pre.result;
    const req = validateExecute(pre.obj);
    if (req === undefined) return errResult(400, "GIT_DELIVERY_COMMIT_BAD_REQUEST");
    const workspace = resolveProjectWorkspace(deps, req.projectId);
    if (workspace === undefined) return errResult(404, "GIT_DELIVERY_COMMIT_UNKNOWN_PROJECT");

    const policy = await resolveGovernedCommitMessagePolicy(
      deps,
      workspace.root,
      options.messagePolicy,
    );

    const messageBlock = messagePolicyBlockResult(req.message, policy, deps);
    if (messageBlock !== undefined) return messageBlock;

    const conflictBlock = await conflictMarkerBlockResult(workspace, seams, deps);
    if (conflictBlock !== undefined) return conflictBlock;

    const command = { kind: "commit" as const, message: req.message, allowEmpty: req.allowEmpty };
    const verifiedApproval = resolveGitDeliveryApprovalRequirement(req.approval, {
      store: seams.approvalStore,
      binding: { projectId: req.projectId, operation: "commit", command },
      nowMs: (seams.now ?? Date.now)(),
    });
    if (verifiedApproval === undefined) return errResult(400, "GIT_DELIVERY_COMMIT_BAD_REQUEST");
    let result;
    try {
      result = await executeGovernedMutation(command, verifiedApproval, workspace, deps, seams);
    } catch {
      return errResult(409, "GIT_DELIVERY_COMMIT_WORKTREE_UNAVAILABLE");
    }
    return { status: 200, body: deps.redactor(gitDeliveryMutationResponse(result)) };
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
