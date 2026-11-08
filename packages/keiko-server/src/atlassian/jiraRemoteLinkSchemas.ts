import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { object, text } from "./jiraManagedSchemas.js";
import { jiraNativeIdentitySchema } from "./jiraProjectStructureDescriptors.js";

const NAME = { ...text(255), minLength: 1 };
const URL_METADATA = { ...text(2048), minLength: 1, description: "HTTP(S) remote-link metadata without credentials or controls. Plain review text, never a browse link or fetch destination." };
function nullable(schema: CatalogJsonObject): CatalogJsonObject { return { anyOf: [schema, { type: "null" }] }; }
const FIELDS = {
  globalId: nullable(NAME), applicationType: nullable(NAME), applicationName: nullable(NAME), relationship: nullable(NAME),
  url: URL_METADATA, title: NAME, summary: nullable(text(32768)),
  iconUrl: nullable(URL_METADATA), iconTitle: nullable(NAME), resolved: nullable({ type: "boolean" }),
  statusIconUrl: nullable(URL_METADATA), statusIconTitle: nullable(NAME), statusIconLink: nullable(URL_METADATA),
};
/** Complete fixed RemoteIssueLinkBean replacement facts, shared by the read and mutation owners. */
export const jiraRemoteLinkValueSchema = object(FIELDS, Object.keys(FIELDS));
export const jiraRemoteLinkUpsertValueSchema = object({ ...FIELDS, globalId: NAME }, Object.keys(FIELDS));
export const jiraRemoteLinkSnapshotSchema = object({ id: jiraNativeIdentitySchema, ...FIELDS }, ["id", ...Object.keys(FIELDS)]);
