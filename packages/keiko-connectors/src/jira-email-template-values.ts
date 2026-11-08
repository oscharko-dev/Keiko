import { JIRA_EMAIL_TEMPLATE_MUTATIONS, isJiraAttachmentPreview, type JiraEmailTemplateMutation, type JiraAttachmentPreview, type JiraMutationAttempt, type JiraMutationReceipt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { isPortableWorkspaceRelativePath } from "@oscharko-dev/keiko-contracts/runtime/workspace-contract-primitives";
import { asRecord } from "./atlassian-sync-classify.js";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraAttachmentSource } from "./jira-attachments.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { savedText } from "./jira-saved-configuration-values.js";

export { JIRA_EMAIL_TEMPLATE_MUTATIONS };
export type { JiraEmailTemplateMutation };
export interface JiraEmailTemplateEntry { readonly path: string; readonly sizeBytes: number; readonly sha256: string }
/** Only metadata crosses the tool boundary; the composing owner never executes or extracts parts. */
export interface JiraEmailTemplatePack {
  readonly archiveBytes: number;
  readonly archiveSha256: string;
  readonly manifestSha256: string;
  readonly entries: readonly JiraEmailTemplateEntry[];
}
export interface JiraEmailTemplateReceipt extends JiraMutationReceipt {
  readonly emailTemplateAction: "upload" | "apply" | "revert";
  readonly uploadSha256?: string;
  readonly uploadBytes?: number;
  readonly priorManifestSha256?: string;
  readonly observedManifestSha256?: string;
}
export type EmailTemplateFailure = Omit<Extract<JiraMutationAttempt, { readonly ok: false }>, "receipt"> & { readonly receipt?: JiraEmailTemplateReceipt };
export type JiraEmailTemplateAttempt = EmailTemplateFailure | { readonly ok: true; readonly receipt: JiraEmailTemplateReceipt };
export type JiraEmailTemplateObservation<T> = EmailTemplateFailure | { readonly ok: true; readonly value: T };
export type JiraEmailTemplateDownload = Omit<EmailTemplateFailure, "receipt"> | { readonly ok: true; readonly status: number; readonly bytes: Uint8Array };
export interface JiraEmailTemplatePorts {
  readonly request: JiraMutationRequest;
  /** Fixed GET /rest/api/2/email-templates through the existing bounded credential/HTTP owner. */
  readonly download: () => Promise<JiraEmailTemplateDownload>;
  /** Existing bounded ZIP owner plus regular-entry/path/credential admission; complete or refused. */
  readonly inspect: (bytes: Uint8Array) => Promise<JiraEmailTemplateObservation<JiraEmailTemplatePack>>;
  /** Existing human-governed file source with the closed email-template ZIP admission policy. */
  readonly source?: JiraAttachmentSource;
  /** Fixed POST /rest/api/2/email-templates, raw application/zip; one effect, never multipart. */
  readonly upload?: (bytes: Uint8Array) => Promise<AtlassianWriteHttpOutcome>;
}
export interface EmailTemplateUploadInput {
  readonly kind: "upload";
  readonly actorKey: string;
  readonly path: string;
  readonly expectedFile: JiraAttachmentPreview;
}
export interface EmailTemplateGlobalInput {
  readonly kind: "apply" | "revert";
  readonly actorKey: string;
  readonly expectedActiveManifestSha256: string;
}
export type EmailTemplateInput = EmailTemplateUploadInput | EmailTemplateGlobalInput;
export function emailTemplateDigest(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value); }
function exactKeys(value: object, keys: readonly string[]): boolean { return Object.keys(value).every((key) => keys.includes(key)); }
function uploadInput(args: CatalogJsonObject, actorKey: string): EmailTemplateUploadInput | undefined {
  if (!exactKeys(args, ["expectedActorKey", "source", "expectedFile", "acceptStagedTemplateReplacement"]) || args.acceptStagedTemplateReplacement !== true) return undefined;
  const source = asRecord(args.source);
  if (source === undefined || !exactKeys(source, ["kind", "path"]) || source.kind !== "connected-file" || !isPortableWorkspaceRelativePath(source.path)) return undefined;
  const expected = asRecord(args.expectedFile);
  if (expected === undefined || !isJiraAttachmentPreview(expected) || !exactKeys(expected, ["name", "sizeBytes", "sha256"]) ||
      typeof expected.name !== "string" || typeof expected.sizeBytes !== "number" || typeof expected.sha256 !== "string") return undefined;
  return { kind: "upload", actorKey, path: source.path,
    expectedFile: { name: expected.name, sizeBytes: expected.sizeBytes, sha256: expected.sha256 } };
}
function globalInput(operation: JiraEmailTemplateMutation, args: CatalogJsonObject, actorKey: string): EmailTemplateGlobalInput | undefined {
  const apply = operation === "jira.apply-email-template-pack";
  const fields = ["expectedActorKey", "expectedActiveManifestSha256", "acceptGlobalTemplateChange"];
  if (apply) fields.push("acceptUnverifiedStagedPack");
  if (!exactKeys(args, fields) || args.acceptGlobalTemplateChange !== true || !emailTemplateDigest(args.expectedActiveManifestSha256)) return undefined;
  if (apply && args.acceptUnverifiedStagedPack !== true) return undefined;
  return { kind: apply ? "apply" : "revert", actorKey, expectedActiveManifestSha256: args.expectedActiveManifestSha256 };
}
export function emailTemplateInput(operation: JiraEmailTemplateMutation, args: CatalogJsonObject): EmailTemplateInput | undefined {
  if (!savedText(args.expectedActorKey, 255)) return undefined;
  return operation === "jira.upload-email-template-pack" ? uploadInput(args, args.expectedActorKey) : globalInput(operation, args, args.expectedActorKey);
}
export function isJiraEmailTemplateMutation(name: string): name is JiraEmailTemplateMutation {
  return JIRA_EMAIL_TEMPLATE_MUTATIONS.some((operation) => operation === name);
}
export function emailTemplateInvalid(message: string): EmailTemplateFailure {
  return { ok: false, reason: "field-validation", detail: { validation: "invalid-field", messages: [message] } };
}
