import { AtlassianCredentialCustodyError, isAtlassianApplicationRoleVersion, type AtlassianHttpBodyRequest } from "@oscharko-dev/keiko-connectors";
import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

function refuse(): never {
  throw new AtlassianCredentialCustodyError("invalid-input", ["Unsupported fixed Jira directory-access request"]);
}
function selected(request: AtlassianHttpBodyRequest): boolean {
  return request.jiraApplicationRole !== undefined || request.jiraUserApplication !== undefined || request.jiraUserColumns !== undefined;
}
function compatible(request: AtlassianHttpBodyRequest): void {
  if (request.upload !== undefined || request.jiraExperimental !== undefined ||
      request.jiraPermissionAttribute !== undefined || request.jiraEmailTemplateArchive !== undefined) refuse();
  if ([request.jiraApplicationRole, request.jiraUserApplication, request.jiraUserColumns].filter((value) => value !== undefined).length !== 1) refuse();
}
function text(value: string | null): value is string {
  return value !== null && value.length > 0 && value.length <= 255 && !/[\p{Cc}\p{Surrogate}]/u.test(value);
}
function canonicalQuery(query: URLSearchParams, names: readonly string[]): boolean {
  return [...query.keys()].every((key) => names.includes(key)) && names.every((key) => query.getAll(key).length === 1);
}
function roleSuffix(path: string): boolean {
  return path === "" || (path.startsWith("/") && isSafeAtlassianIdentifier(path.slice(1)));
}
function nativeRoleGroups(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= TOOL_CATALOG_LIMITS.maxArrayItems &&
    value.every((item) => typeof item === "string" && text(item)) && new Set(value).size === value.length;
}
function nativeRoleKey(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (Object.keys(value).length !== 3 || !("key" in value) || !("groups" in value) || !("defaultGroups" in value)) return undefined;
  const groups = value.groups; const defaults = value.defaultGroups;
  return isSafeAtlassianIdentifier(value.key) && nativeRoleGroups(groups) && nativeRoleGroups(defaults) &&
    defaults.every((group) => groups.includes(group)) ? value.key : undefined;
}
function decodedRoleBody(body: string): unknown {
  try { return JSON.parse(body); } catch { return undefined; }
}
function validRoleBody(body: string, suffix: string): boolean {
  const value = decodedRoleBody(body);
  if (suffix !== "") return nativeRoleKey(value) === suffix.slice(1);
  if (!Array.isArray(value) || value.length === 0 || value.length > TOOL_CATALOG_LIMITS.maxArrayItems) return false;
  const keys = value.map(nativeRoleKey);
  return keys.every((key) => key !== undefined) && new Set(keys).size === keys.length;
}
function applicationRoleWriteHeaders(request: AtlassianHttpBodyRequest, url: URL): Record<string, string> {
  const version = request.jiraApplicationRole;
  if (version === null || typeof version !== "object" || Object.keys(version).length !== 1 ||
      !Object.hasOwn(version, "ifMatch") || !isAtlassianApplicationRoleVersion(version.ifMatch) ||
      request.method !== "PUT" || typeof request.bodyJson !== "string") refuse();
  const suffix = url.pathname.split("/rest/api/2/applicationrole").at(-1);
  if (suffix === undefined || !roleSuffix(suffix) || !validRoleBody(request.bodyJson, suffix)) refuse();
  return { "content-type": "application/json", "if-match": version.ifMatch };
}
function applicationRoleHeaders(request: AtlassianHttpBodyRequest, url: URL): Record<string, string> {
  if (url.search !== "") refuse();
  if (request.jiraApplicationRole !== "version") return applicationRoleWriteHeaders(request, url);
  if (request.method !== "GET" || request.bodyJson !== undefined || !url.pathname.endsWith("/rest/api/2/applicationrole")) refuse();
  return {};
}
function userApplicationHeaders(request: AtlassianHttpBodyRequest, url: URL): Record<string, string> {
  if (request.jiraUserApplication !== true || (request.method !== "POST" && request.method !== "DELETE") ||
      request.bodyJson !== undefined || !url.pathname.endsWith("/rest/api/2/user/application")) refuse();
  const query = url.searchParams;
  if (!canonicalQuery(query, ["username", "applicationKey"]) || !text(query.get("username")) ||
      !isSafeAtlassianIdentifier(query.get("applicationKey")) || `?${query.toString()}` !== url.search) refuse();
  return { "X-ExperimentalApi": "true" };
}
function validUserColumnForm(body: string): boolean {
  const form = new URLSearchParams(body);
  const columns = form.getAll("columns");
  return !(form.toString() !== body || form.getAll("username").length !== 1 ||
      !text(form.get("username")) || columns.length < 1 || columns.length > TOOL_CATALOG_LIMITS.maxArrayItems ||
      !columns.every(text) || [...form.keys()].some((key) => key !== "username" && key !== "columns"));
}
function userColumnHeaders(request: AtlassianHttpBodyRequest, url: URL): Record<string, string> {
  if (request.jiraUserColumns !== true || request.method !== "PUT" || url.search !== "" ||
      !url.pathname.endsWith("/rest/api/2/user/columns") || typeof request.bodyJson !== "string" || !validUserColumnForm(request.bodyJson)) refuse();
  return { "content-type": "application/x-www-form-urlencoded" };
}
function canonicalDirectoryUrl(url: URL, raw: string): boolean {
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === "" &&
    url.toString() === raw && !/[\p{Cc}\\]/u.test(raw) && !/%(?:2e|2f|5c|25)/iu.test(url.pathname);
}
/** Validated before lifecycle admission/custody. No caller chooses a header, media type or path. */
export function directoryAccessHeaders(request: AtlassianHttpBodyRequest): Record<string, string> | undefined {
  if (!selected(request)) return undefined;
  compatible(request);
  if (!URL.canParse(request.url)) refuse();
  const url = new URL(request.url);
  if (!canonicalDirectoryUrl(url, request.url)) refuse();
  if (request.jiraApplicationRole !== undefined) return applicationRoleHeaders(request, url);
  return request.jiraUserApplication !== undefined ? userApplicationHeaders(request, url) : userColumnHeaders(request, url);
}
/** The saved instance/context remains authoritative in addition to the fixed operation suffix. */
export function assertDirectoryAccessTarget(base: URL, target: URL, request: AtlassianHttpBodyRequest): void {
  if (!selected(request)) return;
  const root = `${base.pathname.replace(/\/$/u, "")}/rest/api/2/`;
  const path = target.pathname.slice(root.length);
  if (!target.pathname.startsWith(root)) refuse();
  if (request.jiraApplicationRole !== undefined) {
    if (!path.startsWith("applicationrole") || !roleSuffix(path.slice("applicationrole".length))) refuse();
  } else if (path !== (request.jiraUserApplication !== undefined ? "user/application" : "user/columns")) refuse();
}
export function applicationRoleResponseVersion(request: AtlassianHttpBodyRequest, response: Response): string | undefined {
  if (request.jiraApplicationRole !== "version" || response.status !== 200) return undefined;
  const value = response.headers.get("etag");
  return isAtlassianApplicationRoleVersion(value) ? value : undefined;
}
