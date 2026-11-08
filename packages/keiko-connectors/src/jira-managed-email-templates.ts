import { createHash } from "node:crypto";
import { JIRA_ATTACHMENT_MAX_BYTES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure } from "./jira-managed-metadata.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import { emailTemplateInput, emailTemplateInvalid, type EmailTemplateFailure, type EmailTemplateGlobalInput,
  type EmailTemplateUploadInput, type JiraEmailTemplateAttempt, type JiraEmailTemplateMutation,
  type JiraEmailTemplateObservation, type JiraEmailTemplatePack, type JiraEmailTemplatePorts, type JiraEmailTemplateReceipt } from "./jira-email-template-values.js";

export { isJiraEmailTemplateMutation } from "./jira-email-template-values.js";
const MALFORMED: EmailTemplateFailure = { ok: false, reason: "malformed-payload" };
const UNAVAILABLE: EmailTemplateFailure = { ok: false, reason: "unavailable" };
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function withinBytes(bytes: Uint8Array): boolean { return bytes.byteLength > 0 && bytes.byteLength <= JIRA_ATTACHMENT_MAX_BYTES; }
function conflict(message: string): EmailTemplateFailure { return { ok: false, reason: "conflict", detail: { messages: [message] } }; }
function actorFailure(failure: Pick<EmailTemplateFailure, "reason" | "detail">): EmailTemplateFailure {
  return { ok: false, reason: failure.reason, ...(failure.detail === undefined ? {} : { detail: failure.detail }) };
}
async function inspectedPack(ports: JiraEmailTemplatePorts, bytes: Uint8Array): Promise<JiraEmailTemplateObservation<JiraEmailTemplatePack>> {
  if (!withinBytes(bytes)) return { ok: false, reason: "bounds-exceeded" };
  const snapshot = Uint8Array.from(bytes);
  const digest = sha256(snapshot);
  const inspected = await ports.inspect(snapshot);
  if (!inspected.ok) return inspected;
  return inspected.value.archiveSha256 === digest && inspected.value.archiveBytes === snapshot.byteLength
    ? inspected : MALFORMED;
}
async function currentPack(ports: JiraEmailTemplatePorts): Promise<JiraEmailTemplateObservation<JiraEmailTemplatePack>> {
  const response = await ports.download();
  if (!response.ok) return response;
  return response.status === 200 ? inspectedPack(ports, response.bytes) : MALFORMED;
}
/** A bounded archive observation, never an extraction, executable template or email-send action. */
export async function executeJiraEmailTemplateRead(args: CatalogJsonObject, ports: JiraEmailTemplatePorts): Promise<ManagedMcpToolResult> {
  if (Object.keys(args).length !== 0) return jiraReadFailure("field-validation");
  const read = await currentPack(ports);
  if (!read.ok) return jiraReadFailure(read.reason, read.detail);
  return boundJiraReadResult({ data: { outcome: "succeeded", selectionScope: "complete-exported-email-template-pack",
    archiveBytes: read.value.archiveBytes, archiveSha256: read.value.archiveSha256, manifestSha256: read.value.manifestSha256,
    entryCount: read.value.entries.length, items: read.value.entries.map((entry) => ({ ...entry })) } });
}
async function uploadBytes(ports: JiraEmailTemplatePorts, selected: EmailTemplateUploadInput): Promise<JiraEmailTemplateObservation<Uint8Array>> {
  if (ports.source === undefined || ports.upload === undefined) return UNAVAILABLE;
  const source = await ports.source({ kind: "connected-file", path: selected.path, maxBytes: JIRA_ATTACHMENT_MAX_BYTES, purpose: "jira-email-template-pack" });
  if (!source.ok) return source;
  if (!withinBytes(source.content.bytes)) return { ok: false, reason: "bounds-exceeded" };
  const bytes = Uint8Array.from(source.content.bytes);
  const expected = selected.expectedFile;
  if (source.content.name !== expected.name || bytes.byteLength !== expected.sizeBytes || sha256(bytes) !== expected.sha256)
    return conflict("The connected email-template ZIP no longer matches the reviewed name, byte count and SHA-256. Review the current file; nothing was uploaded.");
  const inspected = await inspectedPack(ports, bytes);
  return inspected.ok ? { ok: true, value: bytes } : inspected;
}
function unconfirmed(receipt: JiraEmailTemplateReceipt, message: string): EmailTemplateFailure {
  return { ok: false, reason: "unavailable", receipt, detail: { messages: [message] } };
}
async function upload(ports: JiraEmailTemplatePorts, selected: EmailTemplateUploadInput, check: boolean): Promise<JiraEmailTemplateAttempt> {
  const content = await uploadBytes(ports, selected);
  if (!content.ok) return content;
  const actor = await readSavedActor(ports.request, selected.actorKey);
  if (!actor.ok) return actorFailure(actor);
  const receipt: JiraEmailTemplateReceipt = { userKey: actor.value.key, emailTemplateAction: "upload",
    uploadSha256: selected.expectedFile.sha256, uploadBytes: selected.expectedFile.sizeBytes };
  if (check) return { ok: true, receipt };
  // The private source owns human approval/current containment; the connector binds its exact bytes.
  const send = ports.upload;
  if (send === undefined) return UNAVAILABLE;
  const response = await send(content.value);
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  return unconfirmed(receipt, "Jira acknowledged the ZIP upload. It replaces the staged template folder; this API cannot independently identify the staged bytes or bind a later apply to this upload. No active template change or email delivery is confirmed. Never replay an uncertain upload.");
}
async function reviewedActive(ports: JiraEmailTemplatePorts, selected: EmailTemplateGlobalInput): Promise<JiraEmailTemplateObservation<JiraEmailTemplatePack>> {
  const read = await currentPack(ports);
  if (!read.ok) return read;
  return read.value.manifestSha256 === selected.expectedActiveManifestSha256 ? read
    : conflict("The active email-template contents changed since review. Read and review the current exported pack before requesting a global replacement; nothing was changed.");
}
async function observedAfterAcknowledgement(ports: JiraEmailTemplatePorts, receipt: JiraEmailTemplateReceipt): Promise<JiraEmailTemplateAttempt> {
  try {
    const after = await currentPack(ports);
    if (!after.ok) return { ...after, receipt };
    return unconfirmed({ ...receipt, observedManifestSha256: after.value.manifestSha256 },
      "Jira acknowledged the global template replacement and a fresh active ZIP was observed. Complete notification-template consequences, the applied staged pack and any email delivery remain unconfirmed. The observed digest is data, not proof of those effects. Do not replay this operation.");
  } catch (error) { throw new JiraAcknowledgedMutationError(error, receipt); }
}
async function replaceGlobal(ports: JiraEmailTemplatePorts, selected: EmailTemplateGlobalInput, check: boolean): Promise<JiraEmailTemplateAttempt> {
  const actor = await readSavedActor(ports.request, selected.actorKey);
  if (!actor.ok) return actorFailure(actor);
  const active = await reviewedActive(ports, selected);
  if (!active.ok) return active;
  const receipt: JiraEmailTemplateReceipt = { userKey: actor.value.key, emailTemplateAction: selected.kind,
    priorManifestSha256: active.value.manifestSha256 };
  if (check) return { ok: true, receipt };
  const currentActor = await readSavedActor(ports.request, selected.actorKey);
  if (!currentActor.ok) return actorFailure(currentActor);
  const response = await ports.request(`email-templates/${selected.kind}`, "POST", undefined, "none");
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  return observedAfterAcknowledgement(ports, receipt);
}
/** Three fixed admin effects, each admitted and journaled by the existing composing owner. */
export async function executeJiraEmailTemplateMutation(operation: JiraEmailTemplateMutation, args: CatalogJsonObject, ports: JiraEmailTemplatePorts, check = false): Promise<JiraEmailTemplateAttempt> {
  const selected = emailTemplateInput(operation, args);
  if (selected === undefined) return emailTemplateInvalid("Review the connected actor and exact ZIP file or active archive digest. Supply the explicit staged/global replacement acknowledgement. Applying also requires accepting that Jira cannot identify the staged pack atomically. No arbitrary path, header or template text is accepted.");
  return selected.kind === "upload" ? upload(ports, selected, check) : replaceGlobal(ports, selected, check);
}
