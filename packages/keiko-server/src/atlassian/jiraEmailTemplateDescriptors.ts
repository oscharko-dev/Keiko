import { JIRA_ATTACHMENT_MAX_BYTES, type JiraEmailTemplateMutation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import { jiraNativeDeclaration, jiraNativeReadResult, jiraNativeWriteResult, type JiraNativeDefinition } from "./jiraProjectStructureDescriptors.js";

const DIGEST = { ...text(64), minLength: 64, pattern: "^[0-9a-f]{64}$" };
const ACTOR = { ...text(255), minLength: 1 };
const ACKNOWLEDGE = { type: "boolean", enum: [true] };
const FILE_BYTES = { type: "integer", minimum: 1, maximum: JIRA_ATTACHMENT_MAX_BYTES };
const EXPECTED_FILE = object({ name: { ...text(255), minLength: 1 }, sizeBytes: FILE_BYTES, sha256: DIGEST }, ["name", "sizeBytes", "sha256"]);
const SOURCE = object({ kind: { type: "string", enum: ["connected-file"] },
  path: { ...text(4096), minLength: 1, description: "Portable relative path within a human-connected file/folder selection. No absolute path, URL, traversal or model-supplied file bytes. The existing source owner revalidates containment and its server-owned integrity snapshot." },
}, ["kind", "path"]);
const ENTRY = object({ path: { ...text(1024), minLength: 1 }, sizeBytes: { type: "integer", minimum: 0, maximum: 64 * 1024 * 1024 }, sha256: DIGEST }, ["path", "sizeBytes", "sha256"]);
const READ_FIELDS = {
  selectionScope: { type: "string", enum: ["complete-exported-email-template-pack"] },
  archiveBytes: FILE_BYTES, archiveSha256: DIGEST, manifestSha256: DIGEST,
  entryCount: { type: "integer", minimum: 0, maximum: TOOL_CATALOG_LIMITS.maxArrayItems },
  items: { type: "array", maxItems: TOOL_CATALOG_LIMITS.maxArrayItems, items: ENTRY },
};
const READ_RESULT = { anyOf: [
  { ...jiraNativeReadResult(READ_FIELDS), required: ["outcome", ...Object.keys(READ_FIELDS)],
    allOf: [{ properties: { outcome: { type: "string", enum: ["succeeded"] } } }] },
  { ...jiraNativeReadResult({}), allOf: [{ properties: { outcome: { type: "string", enum: ["failed"] } } }] },
] };
const COMMON = "Explicit issue-tracker.admin authority is required; Full access and a connected credential do not supply that scope. Jira independently requires system administration. Existing mode/approval semantics remain unchanged. At most one native effect; no automatic retry or replay. No mail is sent by this tool and no successful email delivery is inferred. Every archive is wholly bounded, regular-entry/path checked and scanned through the credential floor. No extracted template content, executable text or remote URL is exposed to the model.";
function write(action: "upload" | "apply" | "revert", description: string, input: CatalogJsonObject): JiraNativeDefinition {
  const fields: CatalogJsonObject = action === "upload" ? { uploadSha256: DIGEST, uploadBytes: FILE_BYTES }
    : { priorManifestSha256: DIGEST, observedManifestSha256: DIGEST };
  return { description: `${description} ${COMMON}`, input, risk: "write", maxResultCount: 1,
    result: { ...jiraNativeWriteResult({ userKey: ACTOR, emailTemplateAction: { type: "string", enum: [action] }, ...fields }),
      allOf: [{ not: { properties: { outcome: { type: "string", enum: ["succeeded"] } }, required: ["outcome"] } }] },
  };
}
const GLOBAL_INPUT = { expectedActorKey: ACTOR, expectedActiveManifestSha256: DIGEST, acceptGlobalTemplateChange: ACKNOWLEDGE };
export const JIRA_EMAIL_TEMPLATE_DEFINITIONS = {
  "jira.email-template-pack": {
    description: `Export the active native email-template ZIP and inspect it only as bounded data. Return complete sorted path/size/SHA-256 metadata; no template contents, server paths or downloads. Jira documents that this GET creates a temporary export ZIP on its server; it does not replace templates. archiveSha256 binds raw export bytes, while manifestSha256 binds the canonical complete entries independent of compression/timestamps. Neither identifies an uploaded staged pack nor proves all notification effects. Oversized or unreadable evidence is refused, never silently truncated. ${COMMON}`,
    input: object({}), result: READ_RESULT, risk: "read", maxResultCount: TOOL_CATALOG_LIMITS.maxArrayItems,
  },
  "jira.upload-email-template-pack": write("upload",
    "Upload the exact connected ZIP as raw application/zip, not multipart. expectedFile is a reviewed byte-integrity expectation, never an authority grant. Approval-required modes use the existing approved file snapshot; allowed mode uses the accepted task/envelope plus a private server-minted immutable source snapshot. Native upload extracts/replaces the staged folder. acceptStagedTemplateReplacement:true acknowledges that replacement. The API has no independently readable staged-pack identity, so even HTTP acknowledgement is always unconfirmed and does not change the active pack.",
    object({ expectedActorKey: ACTOR, source: SOURCE, expectedFile: EXPECTED_FILE, acceptStagedTemplateReplacement: ACKNOWLEDGE }, ["expectedActorKey", "source", "expectedFile", "acceptStagedTemplateReplacement"])),
  "jira.apply-email-template-pack": write("apply",
    "Apply Jira's currently staged pack globally after matching the complete active export manifest and connected actor. acceptUnverifiedStagedPack:true explicitly acknowledges that Jira provides no atomic binding to a particular earlier upload. A pre-read is not compare-and-swap. After ACK, independently export active metadata; observedManifestSha256 describes that observation only. Global notification consequences and exact staged identity remain unconfirmed even when an export is readable.",
    object({ ...GLOBAL_INPUT, acceptUnverifiedStagedPack: ACKNOWLEDGE }, [...Object.keys(GLOBAL_INPUT), "acceptUnverifiedStagedPack"])),
  "jira.revert-email-template-pack": write("revert",
    "Restore Jira's binary-supplied default template pack globally after matching the reviewed active export and actor. acceptGlobalTemplateChange:true acknowledges replacement. After ACK independently observe the active manifest; no API supplies complete default-pack/consequence proof, so the outcome always remains unconfirmed. Do not infer a no-op from an unchanged observed manifest.",
    object(GLOBAL_INPUT, Object.keys(GLOBAL_INPUT))),
} as const satisfies Readonly<Record<JiraEmailTemplateMutation | "jira.email-template-pack", JiraNativeDefinition>>;
export function jiraEmailTemplateDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_EMAIL_TEMPLATE_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
