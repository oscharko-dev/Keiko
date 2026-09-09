import { join } from "node:path";
import type { CodingWorkbenchIssueBinding } from "@oscharko-dev/keiko-contracts";
import { validateCodingWorkbenchIssueBinding } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import { hasIssueClosingDirective } from "@oscharko-dev/keiko-contracts/runtime/issue-closing-directive";
import {
  containsPrDescriptionMarker,
  framePrDescriptionRegion,
} from "@oscharko-dev/keiko-contracts/runtime/pr-description-region";
import {
  hasControlCharacter,
  stripUnsafeFormatChars,
} from "@oscharko-dev/keiko-contracts/runtime/text-safety";
import { redact, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  FileTooLargeError,
  readWorkspaceFile,
  type WorkspaceFs,
  type WorkspaceInfo,
  type WorkspaceDirEntry,
} from "@oscharko-dev/keiko-workspace";
import {
  nodeWorkspaceFs,
  WorkspaceDescriptorReadError,
} from "@oscharko-dev/keiko-workspace/internal/fs";
import { describeError } from "../diagnostics-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { ServerLogSink } from "../observability/server-log.js";

// Three fixed GitHub default locations, no recursive enumeration or model-selected template.
// One sentinel entry makes discovery overflow explicit instead of selecting an arbitrary prefix.
export const DRAFT_DELIVERY_TEMPLATE_DIRECTORY_MAX_ENTRIES = 1024;
export const DRAFT_DELIVERY_TEMPLATE_MAX_BYTES = 32_768;
const DEFAULT_NAME = /^pull_request_template(?:\..+)?$/iu;
const SUPPORTED_NAME = /^pull_request_template(?:\.(?:md|txt))?$/iu;
const DEFAULT_DIRECTORIES = [".github", "docs"] as const;

export type DraftDeliveryTemplateFailure =
  | "invalid-issue-binding"
  | "title-invalid"
  | "issue-directive"
  | "managed-region-marker"
  | "template-ambiguous"
  | "template-too-large"
  | "template-unreadable"
  | "template-unsafe"
  | "template-unsupported"
  | "template-discovery-limit";

export type DraftDeliveryTemplateResult =
  | {
      readonly status: "ready";
      readonly title: string;
      readonly titleDigest: string;
      readonly body: string;
      readonly bodyDigest: string;
      readonly templateBytes: number;
      readonly templateDigest?: string;
    }
  | { readonly status: "blocked"; readonly reason: DraftDeliveryTemplateFailure };

export interface DraftDeliveryTemplateInput {
  readonly workspace: WorkspaceInfo;
  /** Accepted server-owned binding, never an issue number supplied by authored metadata. */
  readonly issueBinding: CodingWorkbenchIssueBinding;
  readonly title: string;
  readonly correlationId: string;
  readonly fs?: WorkspaceFs;
  readonly activityLog?: ServerLogSink;
}

class TemplateResolutionError extends Error {
  public constructor(public readonly reason: DraftDeliveryTemplateFailure) {
    super(reason);
    this.name = "TemplateResolutionError";
  }
}

function validateAuthoredMetadata(text: string): void {
  if (containsPrDescriptionMarker(text)) throw new TemplateResolutionError("managed-region-marker");
  if (hasIssueClosingDirective(text)) throw new TemplateResolutionError("issue-directive");
}

function validateInput(input: DraftDeliveryTemplateInput): void {
  if (!validateCodingWorkbenchIssueBinding(input.issueBinding).ok)
    throw new TemplateResolutionError("invalid-issue-binding");
  const title = input.title;
  if (
    title.trim().length === 0 ||
    title.length > 256 ||
    hasControlCharacter(title) ||
    stripUnsafeFormatChars(title) !== title ||
    redact(title) !== title
  )
    throw new TemplateResolutionError("title-invalid");
  validateAuthoredMetadata(title);
}

function boundedDirectory(fs: WorkspaceFs, absolutePath: string): readonly WorkspaceDirEntry[] {
  const entries = fs.readDir(absolutePath, DRAFT_DELIVERY_TEMPLATE_DIRECTORY_MAX_ENTRIES + 1);
  if (entries.length > DRAFT_DELIVERY_TEMPLATE_DIRECTORY_MAX_ENTRIES)
    throw new TemplateResolutionError("template-discovery-limit");
  return entries;
}

function directoryCandidates(entries: readonly WorkspaceDirEntry[], prefix: string): string[] {
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!DEFAULT_NAME.test(entry.name)) continue;
    if (entry.isSymbolicLink) throw new TemplateResolutionError("template-unreadable");
    // A named template collection is not a default. Selecting one requires a separate user choice.
    if (entry.isDirectory && entry.name.toLowerCase() === "pull_request_template") continue;
    if (!entry.isFile) throw new TemplateResolutionError("template-unreadable");
    if (!SUPPORTED_NAME.test(entry.name)) throw new TemplateResolutionError("template-unsupported");
    candidates.push(prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`);
  }
  return candidates;
}

function resolveDefaultPath(fs: WorkspaceFs, root: string): string | undefined {
  const entries = boundedDirectory(fs, root);
  const candidates = directoryCandidates(entries, "");
  for (const directory of DEFAULT_DIRECTORIES) {
    const entry = entries.find((item) => item.name === directory);
    if (entry === undefined) continue;
    if (!entry.isDirectory || entry.isSymbolicLink)
      throw new TemplateResolutionError("template-unreadable");
    candidates.push(...directoryCandidates(boundedDirectory(fs, join(root, directory)), directory));
  }
  if (candidates.length > 1) throw new TemplateResolutionError("template-ambiguous");
  return candidates[0];
}

function readTemplate(input: DraftDeliveryTemplateInput, fs: WorkspaceFs, path: string): string {
  const descriptorRead = fs.readFileUtf8WithinRootSameDescriptor;
  if (descriptorRead === undefined) throw new TemplateResolutionError("template-unreadable");
  const canonicalRoot = fs.realPath(input.workspace.root);
  let originalText: string | undefined;
  // Keep the public governed deny/root/redaction guard chain and strengthen its descriptor read.
  // A redacted or undecodable template is refused; it is never silently rewritten for publication.
  const read = readWorkspaceFile(
    input.workspace,
    path,
    { maxBytes: DRAFT_DELIVERY_TEMPLATE_MAX_BYTES },
    {
      ...fs,
      readFileUtf8SameDescriptor: (absolutePath, maxBytes) => {
        const value = descriptorRead.call(
          fs,
          canonicalRoot,
          absolutePath,
          maxBytes,
          "reject",
          "complete",
        );
        originalText = value.rawText;
        return value;
      },
    },
  );
  if (
    read.truncated ||
    originalText === undefined ||
    read.text !== originalText ||
    read.text.includes("\ufffd") ||
    Buffer.byteLength(read.text, "utf8") !== read.sizeBytes ||
    stripUnsafeFormatChars(read.text) !== read.text
  )
    throw new TemplateResolutionError("template-unsafe");
  validateAuthoredMetadata(read.text);
  return read.text;
}

function compose(
  input: DraftDeliveryTemplateInput,
): Extract<DraftDeliveryTemplateResult, { status: "ready" }> {
  validateInput(input);
  const fs = input.fs ?? nodeWorkspaceFs;
  const path = resolveDefaultPath(fs, input.workspace.root);
  const template = path === undefined ? "" : readTemplate(input, fs, path);
  if (resolveDefaultPath(fs, input.workspace.root) !== path)
    throw new TemplateResolutionError("template-unreadable");
  const prefix = template.length === 0 ? "" : `${template}\n\n`;
  const body = `${prefix}Closes #${String(input.issueBinding.issueNumber)}\n\n${framePrDescriptionRegion("")}`;
  return {
    status: "ready",
    title: input.title,
    titleDigest: sha256Hex(input.title),
    body,
    bodyDigest: sha256Hex(body),
    templateBytes: Buffer.byteLength(template, "utf8"),
    ...(path === undefined ? {} : { templateDigest: sha256Hex(template) }),
  };
}

function failureReason(error: unknown): DraftDeliveryTemplateFailure {
  if (error instanceof TemplateResolutionError) return error.reason;
  if (
    error instanceof FileTooLargeError ||
    (error instanceof WorkspaceDescriptorReadError && error.reason === "too-large")
  )
    return "template-too-large";
  return "template-unreadable";
}

/** Pure local preparation only. The delivery owner must bind/recheck this exact payload at dispatch. */
export function resolveDraftDeliveryTemplate(
  input: DraftDeliveryTemplateInput,
): DraftDeliveryTemplateResult {
  const activityLog = input.activityLog ?? processServerLogSink();
  try {
    const result = compose(input);
    activityLog.write({
      category: "process",
      op: "git.draft-template",
      correlationId: input.correlationId,
      extra: {
        state: result.status,
        titleDigest: result.titleDigest,
        bodyDigest: result.bodyDigest,
        templateBytes: result.templateBytes,
        templateDigest: result.templateDigest,
      },
    });
    return result;
  } catch (error) {
    const reason = failureReason(error);
    activityLog.write({
      category: "process",
      op: "git.draft-template",
      correlationId: input.correlationId,
      level: "warn",
      errorKind: error instanceof TemplateResolutionError ? "validation" : "internal",
      extra: { state: "blocked", reason, ...describeError(error) },
    });
    return { status: "blocked", reason };
  }
}
