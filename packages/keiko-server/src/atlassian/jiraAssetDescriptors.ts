import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeIdentitySchema as ID,
  jiraNativeProjectSchema as PROJECT,
  jiraNativePagingSchema as PAGING,
  jiraNativeCollectionResult,
  jiraNativeReadResult,
  jiraNativeDeclaration,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const COUNT = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const ATTACHMENT_INPUT = object({ attachmentId: ID }, ["attachmentId"]);
const AVATARS = jiraNativeCollectionResult(
  object(
    {
      id: ID,
      category: { type: "string", enum: ["system", "custom"] },
      owner: text(255),
      selected: { type: "boolean" },
    },
    ["id", "category"],
  ),
);
const ARCHIVE_ENTRY = object(
  {
    entryIndex: COUNT,
    name: text(1024),
    size: COUNT,
    mediaType: text(255),
    abbreviatedName: text(1024),
  },
  ["entryIndex"],
);
export const JIRA_ASSET_READ_DEFINITIONS = {
  "jira.attachment-settings": {
    description:
      "Read whether Jira attachments are enabled and the native upload limit when supplied, alongside Keiko's applicable byte cap. These settings do not establish permission to upload; the existing governed attachment writer enforces permission and source admission separately.",
    input: object({}),
    result: jiraNativeReadResult({
      enabled: { type: "boolean" },
      uploadLimit: COUNT,
      maxBytes: COUNT,
    }),
    risk: "read",
    maxResultCount: 1,
  },
  "jira.attachment": {
    description:
      "Read metadata for one exact attachment identity: filename, byte size and available media type/creation text. Does not retrieve file bytes, expose download URLs, or infer an issue association from the attachment ID.",
    input: ATTACHMENT_INPUT,
    result: jiraNativeReadResult({
      attachmentId: ID,
      filename: text(1024),
      size: COUNT,
      mimeType: text(255),
      created: text(128),
    }),
    risk: "read",
    maxResultCount: 1,
  },
  "jira.attachment-archive": {
    description:
      "Read Jira's typed archive-entry preview and locally page the returned bounded entries. total counts available entries; totalEntryCount and entriesComplete are present only when Jira provides a valid total. nextStartAt pages this returned preview, not unseen remote entries. No archive is downloaded or extracted; an empty preview does not establish an empty archive.",
    input: object({ attachmentId: ID, ...PAGING }, ["attachmentId"]),
    result: jiraNativeReadResult({
      attachmentId: ID,
      items: { type: "array", maxItems: 100, items: ARCHIVE_ENTRY },
      startAt: PAGING.startAt,
      total: COUNT,
      nextStartAt: PAGING.startAt,
      totalEntryCount: COUNT,
      entriesComplete: { type: "boolean" },
    }),
    risk: "read",
    maxResultCount: 100,
  },
  "jira.attachment-archive-summary": {
    description:
      "Read only the documented identity, name, media type and available entry count from Jira's human-readable archive expansion. Its unstable opaque entry structure is never copied. This neither downloads content nor proves archive completeness.",
    input: ATTACHMENT_INPUT,
    result: jiraNativeReadResult({
      attachmentId: ID,
      name: text(1024),
      mediaType: text(255),
      totalEntryCount: COUNT,
    }),
    risk: "read",
    maxResultCount: 1,
  },
  "jira.system-avatars": {
    description:
      "Read and locally page visible system avatar metadata for the native user, project or issue-type category. Returns exact identities and available owner/selection facts; no image bytes or remote URLs are exposed.",
    input: object(
      { avatarType: { type: "string", enum: ["user", "project", "issuetype"] }, ...PAGING },
      ["avatarType"],
    ),
    result: AVATARS,
    risk: "read",
    maxResultCount: 100,
  },
  "jira.project-avatars": {
    description:
      "Read and locally page system/custom avatar metadata visible for the selected project. Category is retained for each avatar; omitted selected state remains unknown. Does not change the project's avatar.",
    input: object({ projectIdOrKey: PROJECT, ...PAGING }, ["projectIdOrKey"]),
    result: AVATARS,
    risk: "read",
    maxResultCount: 100,
  },
  "jira.user-avatars": {
    description:
      "Read and locally page avatar metadata visible for the selected username, or the current user when username is omitted. Ordinary spaces in usernames are preserved. Does not retrieve images or change user settings.",
    input: object({ username: { ...text(255), minLength: 1 }, ...PAGING }),
    result: AVATARS,
    risk: "read",
    maxResultCount: 100,
  },
  "jira.avatars": {
    description:
      "Read and locally page native avatar metadata for one project or issue-type owner ID. Only these published native owner categories are offered; custom plugin types are unavailable. No image download or avatar mutation occurs.",
    input: object(
      {
        avatarType: { type: "string", enum: ["project", "issuetype"] },
        owningObjectId: ID,
        ...PAGING,
      },
      ["avatarType", "owningObjectId"],
    ),
    result: AVATARS,
    risk: "read",
    maxResultCount: 100,
  },
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraAssetDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_ASSET_READ_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
