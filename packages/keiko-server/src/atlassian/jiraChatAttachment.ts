import { createHash } from "node:crypto";
import {
  readJiraAttachmentLimit,
  type JiraAttachmentArguments,
  type JiraAttachmentSource,
  type JiraAttachmentSourceRequest,
  type JiraAttachmentSourceResult,
} from "@oscharko-dev/keiko-connectors";
import type { ChatConnectedScope } from "@oscharko-dev/keiko-contracts/bff-wire";
import type {
  ChatToolWriteApprovalView,
  EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import {
  JIRA_ATTACHMENT_MAX_BYTES,
  isJiraAvatarUploadOperation,
  isJiraAttachmentName,
  type AtlassianConnectorWriteFailureReason,
  type JiraAttachmentPreview,
  type JiraFieldValidationFailure,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  activityLogEvent,
  defineActivityLogOperation,
  recordActivityLogLoss,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { UiHandlerDeps } from "../deps.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import { FilesError, readConnectedFileBytes } from "../files.js";
import { processServerLogSink } from "../process-log-sink.js";
import { currentRedactionSecrets } from "../redaction-secrets.js";
import { admitAttachmentContent, admitJiraAvatarImage } from "./jiraAttachmentContentPolicy.js";
import { inspectJiraEmailTemplateArchive } from "./jiraEmailTemplateArchive.js";
import {
  resolveCurrentJiraChatAuthority,
  type JiraChatAuthorityDeps,
} from "./jiraChatAuthority.js";

/**
 * Where an attachment's bytes come from (#4176): a file inside a folder or file selection the
 * human connected to this Chat, admitted exactly like a Files read. The model names a path; it
 * never names a host location, and nothing outside the connected scopes is ever read. The bytes
 * must pass the credential floor before a human reviews them and again before they are sent, and
 * when the human reviewed the file, the file sent must match the one reviewed.
 */
export type JiraChatAttachmentDeps = Pick<
  UiHandlerDeps,
  "store" | "redactor" | "managedTaskWorkspaceRoot" | "env" | "config" | "gatewayConfig" | "egress"
>;

const REFUSALS = [
  "no-connected-folder",
  "outside-connected-scope",
  "not-found",
  "denied",
  "not-a-file",
  "too-large",
  "empty",
  "invalid-name",
  "changed-after-review",
  "unreviewed",
  "unstable",
  "contains-credential",
  "unscannable",
  "limit-unavailable",
  "failed",
] as const;
type Refusal = (typeof REFUSALS)[number];

const SOURCE_READ = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "jira.attachment.source",
  category: "process",
  owner: "keiko-server",
  emitter: "atlassian.jiraChatAttachment.recordJiraAttachmentSource",
  fields: {
    stage: { type: "string", dataClass: "closed-enum", required: true, values: ["review", "send"] },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["read", "refused"],
    },
    refusal: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...REFUSALS, "none"],
    },
    sizeBytes: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["atlassian-action-execution"],
  proofIds: ["jira.attachment.source.line"],
  releaseImpact: "patch",
});

type Stage = "review" | "send";
function recordJiraAttachmentSource(
  correlationId: string,
  stage: Stage,
  refusal: Refusal | undefined,
  sizeBytes: number,
): void {
  try {
    processServerLogSink().write(
      activityLogEvent(
        SOURCE_READ,
        { correlationId, level: refusal === undefined ? "info" : "warn" },
        {
          stage,
          outcome: refusal === undefined ? "read" : "refused",
          refusal: refusal ?? "none",
          sizeBytes,
          completeness: "complete",
          loss: "none",
        },
      ),
    );
  } catch (error) {
    recordActivityLogLoss("port-sink-failed");
    emitServerDiagnostic(
      undefined,
      serverDiagnosticFromError({
        correlationId,
        operation: "jira.attachment.source-log-failed",
        source: "jira-chat-attachment",
        error,
        redact: () => "server-operation-failed",
      }),
    );
  }
}

interface RefusalProjection {
  readonly reason: AtlassianConnectorWriteFailureReason;
  readonly validation: JiraFieldValidationFailure;
  readonly message: string;
}
const PROJECTION: Readonly<Record<Refusal, RefusalProjection>> = {
  "no-connected-folder": {
    reason: "field-validation",
    validation: "invalid-field",
    message: "No folder is connected to this Chat; connect the folder that holds the file.",
  },
  "outside-connected-scope": {
    reason: "field-validation",
    validation: "invalid-field",
    message:
      "The path is not inside a connected folder or file selection; give it relative to a connected folder.",
  },
  "not-found": {
    reason: "not-found",
    validation: "invalid-field",
    message: "The file was not found in the connected folder.",
  },
  denied: {
    reason: "permission-denied",
    validation: "invalid-field",
    message: "Keiko does not read that path.",
  },
  "not-a-file": {
    reason: "field-validation",
    validation: "invalid-field",
    message: "The path is not a file.",
  },
  "too-large": {
    reason: "bounds-exceeded",
    validation: "bounds-exceeded",
    message: "The file is larger than the attachment limit.",
  },
  empty: {
    reason: "field-validation",
    validation: "invalid-field",
    message: "The file is empty and cannot be attached.",
  },
  "invalid-name": {
    reason: "field-validation",
    validation: "invalid-field",
    message: "The attachment name must be a plain file name without separators or quotes.",
  },
  "changed-after-review": {
    reason: "conflict",
    validation: "invalid-field",
    message:
      "The file changed after it was reviewed. Request the attachment again to review the current file.",
  },
  unreviewed: {
    reason: "conflict",
    validation: "invalid-field",
    message: "The approval does not cover a reviewed file. Request the attachment again.",
  },
  "contains-credential": {
    reason: "permission-denied",
    validation: "invalid-field",
    message:
      "The file contains a credential (a key, token, password or configured secret) and cannot be attached.",
  },
  unscannable: {
    reason: "field-validation",
    validation: "invalid-field",
    message:
      "Keiko cannot check this kind of file for credentials. Attach a text, PDF, Word, Excel or common image file; archives, databases, key stores and executables are refused.",
  },
  "limit-unavailable": {
    reason: "unavailable",
    validation: "invalid-field",
    message: "The Jira instance does not accept attachments or its upload limit could not be read.",
  },
  unstable: {
    reason: "unavailable",
    validation: "invalid-field",
    message: "The file changed while it was being read. Try again.",
  },
  failed: {
    reason: "unavailable",
    validation: "invalid-field",
    message: "The file could not be read.",
  },
};
const EMAIL_TEMPLATE_GUIDANCE: Partial<Readonly<Record<Refusal, string>>> = {
  unreviewed:
    "No server-owned integrity snapshot covers this email-template ZIP. Inspect the connected file through the current task authority; retain the existing approval only where the selected mode requires it.",
  "changed-after-review":
    "The email-template ZIP changed after its integrity snapshot. Refresh the connected-file snapshot and, when required by the existing mode, its review before uploading.",
  "too-large":
    "The email-template ZIP exceeds the existing 20 MiB file limit. Supply a smaller complete pack; entries are never silently omitted.",
  unscannable:
    "The email-template ZIP must contain a complete bounded set of regular, unambiguous portable entries whose contents pass the existing credential scan. Encrypted, aliased, linked, malformed or unscannable entries are refused.",
};
const AVATAR_GUIDANCE: Partial<Readonly<Record<Refusal, string>>> = {
  unreviewed:
    "No server-owned integrity snapshot covers this avatar image. Read the connected PNG/JPEG through the current task authority; keep the existing review only when the selected mode requires it.",
  "changed-after-review":
    "The avatar image changed after its exact-byte snapshot. Refresh the connected-file snapshot and any required review before uploading.",
  "too-large":
    "The avatar image exceeds the existing 20 MiB connected-file limit. Supply a smaller PNG or JPEG.",
  unscannable:
    "The avatar image must be a complete PNG or JPEG whose structure and text carriers pass the existing credential floor. Other formats, malformed images and trailing content are refused.",
};
function purposeGuidance(
  refusal: Refusal,
  purpose: JiraAttachmentSourceRequest["purpose"],
  fallback: string,
): string {
  if (purpose === "jira-email-template-pack") return EMAIL_TEMPLATE_GUIDANCE[refusal] ?? fallback;
  return purpose === "jira-avatar-image" ? (AVATAR_GUIDANCE[refusal] ?? fallback) : fallback;
}
function refused(
  refusal: Refusal,
  purpose?: JiraAttachmentSourceRequest["purpose"],
): Extract<JiraAttachmentSourceResult, { ok: false }> {
  const { reason, validation, message } = PROJECTION[refusal];
  const guidance = purposeGuidance(refusal, purpose, message);
  return { ok: false, reason, detail: { fieldId: "source", validation, messages: [guidance] } };
}

const FILES_ERROR_REFUSAL: Readonly<Record<string, Refusal>> = {
  NOT_FOUND: "not-found",
  DENIED: "denied",
  PATH_ESCAPE: "denied",
  BAD_PATH: "denied",
  NOT_FILE: "not-a-file",
  PAYLOAD_TOO_LARGE: "too-large",
  STALE_PATH: "unstable",
  STALE_SESSION: "unstable",
};
function refusalFor(error: unknown): Refusal {
  return error instanceof FilesError ? (FILES_ERROR_REFUSAL[error.code] ?? "failed") : "failed";
}

/** A read failure Files does not classify keeps its correlated, redacted stack on the diagnostic log. */
function reportUnexpectedFailure(correlationId: string, error: unknown): void {
  emitServerDiagnostic(
    undefined,
    serverDiagnosticFromError({
      correlationId,
      operation: "jira.attachment.source-read-failed",
      source: "jira-chat-attachment",
      error,
      redact: () => "server-operation-failed",
    }),
  );
}

function connectedScopes(
  deps: JiraChatAttachmentDeps,
  chatId: string,
): readonly { readonly root: string; readonly scope: ChatConnectedScope }[] {
  const chat = deps.store.findChatById(chatId);
  if (chat === undefined) return [];
  const scopes = chat.connectedScopes ?? (chat.connectedScope ? [chat.connectedScope] : []);
  return scopes.map((scope) => ({ root: scope.root ?? chat.projectPath, scope }));
}
/**
 * A lexical comparison form only: no `.` or `..` segment, no absolute or drive-lettered path. The
 * read itself is admitted again by the Files containment, which owns the real guarantee.
 */
function normalized(path: string): string | undefined {
  let trimmed = path.replaceAll("\\", "/").replace(/^(?:\.\/)+/u, "");
  while (trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
  const unsafe =
    trimmed.startsWith("/") ||
    trimmed.includes("\0") ||
    /^[A-Za-z]:/u.test(trimmed) ||
    trimmed.split("/").some((segment) => segment === ".." || segment === ".");
  return unsafe ? undefined : trimmed;
}
/** A directory selection covers what is inside it; a files selection only the files it lists. */
function scopeCovers(scope: ChatConnectedScope, path: string): boolean {
  if (scope.kind === "workspace-root") return true;
  const selected = scope.relativePaths.map((path) => normalized(path));
  if (scope.kind === "files") return selected.includes(path);
  return selected.some(
    (directory) =>
      directory !== undefined &&
      (directory === "" || path === directory || path.startsWith(`${directory}/`)),
  );
}

type Candidate = Awaited<ReturnType<typeof readConnectedFileBytes>>;
type Located =
  | { readonly ok: true; readonly file: Candidate }
  | { readonly ok: false; readonly refusal: Refusal };
async function locate(
  deps: JiraChatAttachmentDeps,
  chatId: string,
  path: string,
  maxBytes: number,
  correlationId: string,
): Promise<Located> {
  const scopes = connectedScopes(deps, chatId);
  if (scopes.length === 0) return { ok: false, refusal: "no-connected-folder" };
  const relative = normalized(path);
  const covering =
    relative === undefined ? [] : scopes.filter(({ scope }) => scopeCovers(scope, relative));
  if (relative === undefined || covering.length === 0)
    return { ok: false, refusal: "outside-connected-scope" };
  let failure: Refusal = "not-found";
  for (const { root, scope } of covering) {
    try {
      // Roots are tried in order and only the first readable one answers.
      const file = await readConnectedFileBytes(deps, root, relative, maxBytes); // NOSONAR typescript:S9382 -- ordered fallback across connected roots
      // The selection was matched lexically; a link inside it may lead outside it, so the place
      // the bytes really came from is matched again.
      if (scopeCovers(scope, file.realRelativePath)) return { ok: true, file };
      failure = "outside-connected-scope";
    } catch (error) {
      failure = refusalFor(error);
      if (failure === "failed") reportUnexpectedFailure(correlationId, error);
      if (failure !== "not-found") return { ok: false, refusal: failure };
    }
  }
  return { ok: false, refusal: failure };
}

interface ContentWithPreview {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}
type Content =
  | { readonly ok: true; readonly content: ContentWithPreview }
  | { readonly ok: false; readonly refusal: Refusal };
async function attachmentContent(
  deps: JiraChatAttachmentDeps,
  file: Candidate,
  name: string | undefined,
  purpose?: JiraAttachmentSourceRequest["purpose"],
  signal?: AbortSignal,
): Promise<Content> {
  const finalName = name ?? file.name;
  if (!isJiraAttachmentName(finalName)) return { ok: false, refusal: "invalid-name" };
  if (file.bytes.length === 0) return { ok: false, refusal: "empty" };
  const bytes = new Uint8Array(file.bytes.buffer, file.bytes.byteOffset, file.bytes.length);
  const refusal = await contentRefusal(deps, bytes, finalName, purpose, signal);
  if (refusal !== undefined) return { ok: false, refusal };
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { ok: true, content: { name: finalName, bytes, sha256 } };
}
async function contentRefusal(
  deps: JiraChatAttachmentDeps,
  bytes: Uint8Array,
  name: string,
  purpose: JiraAttachmentSourceRequest["purpose"],
  signal: AbortSignal | undefined,
): Promise<Refusal | undefined> {
  const secrets = currentRedactionSecrets(deps);
  if (purpose === "jira-email-template-pack") {
    const inspected = await inspectJiraEmailTemplateArchive(bytes, {
      secrets,
      ...(signal === undefined ? {} : { signal }),
    });
    if (inspected.ok) return undefined;
    return (
      inspected.contentRefusal ??
      (inspected.reason === "bounds-exceeded" ? "too-large" : "unscannable")
    );
  }
  const input = { bytes, name, secrets, ...(signal === undefined ? {} : { signal }) };
  const verdict =
    purpose === "jira-avatar-image"
      ? await admitJiraAvatarImage(input)
      : await admitAttachmentContent(input);
  return verdict.ok ? undefined : verdict.refusal;
}
function previewOf(content: ContentWithPreview): JiraAttachmentPreview {
  return { name: content.name, sizeBytes: content.bytes.length, sha256: content.sha256 };
}

async function readContent(
  deps: JiraChatAttachmentDeps,
  chatId: string,
  request: Pick<JiraAttachmentSourceRequest, "path" | "name" | "maxBytes" | "purpose">,
  correlationId: string,
  signal?: AbortSignal,
): Promise<Content> {
  const located = await locate(deps, chatId, request.path, request.maxBytes, correlationId);
  return located.ok
    ? attachmentContent(deps, located.file, request.name, request.purpose, signal)
    : located;
}

/**
 * The upload limit the instance reports, lowered to Keiko's ceiling; undefined when the instance
 * accepts no attachments or the limit cannot be read, so no file is offered for review.
 */
export async function jiraChatAttachmentLimit(
  deps: JiraChatAuthorityDeps & Pick<UiHandlerDeps, "atlassianConnectorCredentials">,
  options: {
    readonly chatId: string;
    readonly authorityReference: EditorAgentGovernedAuthorityReference;
    readonly signal: AbortSignal;
    readonly correlationId: string;
    /** Every source of a combined turn still admits this metadata read. */
    readonly readAllowed?: () => boolean;
  },
): Promise<number | undefined> {
  const { chatId, authorityReference, signal, correlationId } = options;
  const allowed = (): boolean => {
    if (signal.aborted) return false;
    if (options.readAllowed === undefined) return true;
    const admitted: unknown = options.readAllowed();
    return admitted === true;
  };
  const current = resolveCurrentJiraChatAuthority(
    deps,
    chatId,
    authorityReference,
    new Date().toISOString(),
    correlationId,
  );
  const credentials = deps.atlassianConnectorCredentials;
  if (!current.ok || credentials === undefined || !allowed()) return undefined;
  const http = credentials.httpBodyPortFactory(current.credential, correlationId, {
    beforeDispatch: (request) => request.method === "GET" && allowed(),
  });
  const limit = await readJiraAttachmentLimit(
    { baseUrl: current.credential.baseUrl, deployment: current.credential.deployment, http },
    {
      invocationId: "attachment-limit",
      correlationId,
      signal,
      beforeEffect: allowed,
    },
  );
  return allowed() && limit.ok ? limit.maxBytes : undefined;
}

/**
 * What the human is shown before approving: name, size and digest of the file as it is now. The
 * file is held to the same bound the send will use, `maxBytes` (the instance's own limit, lowered
 * to Keiko's ceiling), so an approved file is never refused afterwards as too large.
 */
export async function previewJiraChatAttachment(
  deps: JiraChatAttachmentDeps,
  chatId: string,
  args: JiraAttachmentArguments,
  correlationId: string,
  maxBytes: number | undefined,
): Promise<JiraAttachmentPreview | undefined> {
  if (maxBytes === undefined) {
    recordJiraAttachmentSource(correlationId, "review", "limit-unavailable", 0);
    return undefined;
  }
  const read = await readContent(
    deps,
    chatId,
    {
      path: args.path,
      maxBytes: Math.min(maxBytes, JIRA_ATTACHMENT_MAX_BYTES),
      ...(args.name === undefined ? {} : { name: args.name }),
    },
    correlationId,
  );
  recordJiraAttachmentSource(
    correlationId,
    "review",
    read.ok ? undefined : read.refusal,
    read.ok ? read.content.bytes.length : 0,
  );
  return read.ok ? previewOf(read.content) : undefined;
}
/** Server-minted file integrity snapshot through the same connected scope and content floor.
 * This is not an authority grant: the caller retains the existing mode/approval decision. */
export async function previewJiraEmailTemplatePack(
  deps: JiraChatAttachmentDeps,
  chatId: string,
  path: string,
  correlationId: string,
  signal?: AbortSignal,
): Promise<JiraAttachmentPreview | undefined> {
  return previewPurposeFile(deps, chatId, path, correlationId, "jira-email-template-pack", signal);
}
export async function previewJiraAvatarImage(
  deps: JiraChatAttachmentDeps,
  chatId: string,
  path: string,
  correlationId: string,
  signal?: AbortSignal,
): Promise<JiraAttachmentPreview | undefined> {
  return previewPurposeFile(deps, chatId, path, correlationId, "jira-avatar-image", signal);
}
async function previewPurposeFile(
  deps: JiraChatAttachmentDeps,
  chatId: string,
  path: string,
  correlationId: string,
  purpose: NonNullable<JiraAttachmentSourceRequest["purpose"]>,
  signal?: AbortSignal,
): Promise<JiraAttachmentPreview | undefined> {
  const read = await readContent(
    deps,
    chatId,
    { path, maxBytes: JIRA_ATTACHMENT_MAX_BYTES, purpose },
    correlationId,
    signal,
  );
  recordJiraAttachmentSource(
    correlationId,
    "review",
    read.ok ? undefined : read.refusal,
    read.ok ? read.content.bytes.length : 0,
  );
  return read.ok ? Object.freeze(previewOf(read.content)) : undefined;
}

/** Read-only preflight source. The composing owner supplies this ONLY to check=true; it grants
 * neither upload nor approval. Requiring the future approval here would prevent its own card. */
export function jiraChatEmailTemplatePreviewSource(
  deps: JiraChatAttachmentDeps,
  options: {
    readonly chatId: string;
    readonly correlationId: string;
    readonly signal?: AbortSignal;
  },
): JiraAttachmentSource {
  return purposePreviewSource(deps, options, "jira-email-template-pack");
}
export function jiraChatAvatarPreviewSource(
  deps: JiraChatAttachmentDeps,
  options: {
    readonly chatId: string;
    readonly correlationId: string;
    readonly signal?: AbortSignal;
  },
): JiraAttachmentSource {
  return purposePreviewSource(deps, options, "jira-avatar-image");
}
function purposePreviewSource(
  deps: JiraChatAttachmentDeps,
  options: {
    readonly chatId: string;
    readonly correlationId: string;
    readonly signal?: AbortSignal;
  },
  purpose: NonNullable<JiraAttachmentSourceRequest["purpose"]>,
): JiraAttachmentSource {
  return async (request) => {
    if (request.purpose !== purpose) return refused("unscannable");
    const read = await readContent(
      deps,
      options.chatId,
      { ...request, maxBytes: Math.min(request.maxBytes, JIRA_ATTACHMENT_MAX_BYTES) },
      options.correlationId,
      options.signal,
    );
    recordJiraAttachmentSource(
      options.correlationId,
      "review",
      read.ok ? undefined : read.refusal,
      read.ok ? read.content.bytes.length : 0,
    );
    return read.ok ? { ok: true, content: read.content } : refused(read.refusal, request.purpose);
  };
}

/**
 * Whether policy requires a human review of this attachment and, if so, the file that was
 * reviewed. Review required with no reviewed file (an approval that expired or never carried one)
 * is a refusal, never a pass.
 */
export type JiraChatAttachmentReview =
  | { readonly required: false }
  | { readonly required: true; readonly reviewed: JiraAttachmentPreview | undefined };

/**
 * What policy and the approval registry say about this attachment. Only an explicit `allowed`
 * needs no review; any other disposition requires one, and a missing, expired or foreign approval
 * leaves nothing reviewed, which the send refuses.
 */
export function attachmentReviewFor(
  policy: string,
  approval: ChatToolWriteApprovalView | undefined,
  expectedOperation?: string,
): JiraChatAttachmentReview {
  if (policy === "allowed") return { required: false };
  return {
    required: true,
    reviewed:
      approval?.kind === "jira-chat-write" &&
      fileApprovalOperation(approval.operation) &&
      (expectedOperation === undefined || approval.operation === expectedOperation)
        ? approval.attachment
        : undefined,
  };
}
function fileApprovalOperation(operation: string): boolean {
  return (
    operation === "jira.attach" ||
    operation === "jira.upload-email-template-pack" ||
    isJiraAvatarUploadOperation(operation)
  );
}

function samePreview(left: JiraAttachmentPreview, right: JiraAttachmentPreview): boolean {
  return (
    left.name === right.name && left.sizeBytes === right.sizeBytes && left.sha256 === right.sha256
  );
}

/**
 * The source port the connector reads through at send time. A reviewed file is re-read and must
 * match its approved name, size and digest exactly; a drifted or unreviewed file is refused before
 * a single byte leaves the machine.
 */
export function jiraChatAttachmentSource(
  deps: JiraChatAttachmentDeps,
  options: {
    readonly chatId: string;
    readonly correlationId: string;
    readonly review: () => JiraChatAttachmentReview;
    /** Private server-minted byte snapshot for an already allowed email-template operation. */
    readonly emailTemplateSnapshot?: JiraAttachmentPreview;
    /** Private actual-byte snapshot for already allowed avatar uploads, never a grant by itself. */
    readonly avatarSnapshot?: JiraAttachmentPreview;
    readonly signal?: AbortSignal;
  },
): JiraAttachmentSource {
  const templateSnapshot =
    options.emailTemplateSnapshot === undefined
      ? undefined
      : Object.freeze({ ...options.emailTemplateSnapshot });
  const avatarSnapshot =
    options.avatarSnapshot === undefined ? undefined : Object.freeze({ ...options.avatarSnapshot });
  return async (request): Promise<JiraAttachmentSourceResult> => {
    const read = await readContent(
      deps,
      options.chatId,
      request,
      options.correlationId,
      options.signal,
    );
    const review = options.review();
    // A required integrity snapshot never upgrades policy or creates a fresh approval prompt.
    const integrityReview = purposeIntegrityReview(
      request.purpose,
      review,
      templateSnapshot,
      avatarSnapshot,
    );
    const refusal = read.ok ? reviewRefusal(integrityReview, read.content) : read.refusal;
    recordJiraAttachmentSource(
      options.correlationId,
      "send",
      refusal,
      read.ok ? read.content.bytes.length : 0,
    );
    return !read.ok || refusal !== undefined
      ? refused(refusal ?? "failed", request.purpose)
      : { ok: true, content: read.content };
  };
}
function purposeIntegrityReview(
  purpose: JiraAttachmentSourceRequest["purpose"],
  review: JiraChatAttachmentReview,
  template: JiraAttachmentPreview | undefined,
  avatar: JiraAttachmentPreview | undefined,
): JiraChatAttachmentReview {
  if (purpose === undefined) return review;
  return {
    required: true,
    reviewed: review.required
      ? review.reviewed
      : purpose === "jira-email-template-pack"
        ? template
        : avatar,
  };
}
function reviewRefusal(
  review: JiraChatAttachmentReview,
  content: ContentWithPreview,
): Refusal | undefined {
  if (!review.required) return undefined;
  if (review.reviewed === undefined) return "unreviewed";
  return samePreview(review.reviewed, previewOf(content)) ? undefined : "changed-after-review";
}
