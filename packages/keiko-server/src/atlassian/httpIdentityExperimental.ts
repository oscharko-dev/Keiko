import { AtlassianCredentialCustodyError, jiraNativeId, type AtlassianHttpBodyRequest } from "@oscharko-dev/keiko-connectors";

function refuse(): never { throw new AtlassianCredentialCustodyError("invalid-input", ["Unsupported fixed Jira identity/project request"]); }
function selected(request: AtlassianHttpBodyRequest): boolean {
  return request.jiraIdentityExperimental !== undefined || request.jiraProjectPriority !== undefined;
}
function compatible(request: AtlassianHttpBodyRequest): boolean {
  return request.upload === undefined && request.jiraExperimental === undefined && request.jiraPermissionAttribute === undefined &&
    request.jiraEmailTemplateArchive === undefined && request.jiraApplicationRole === undefined && request.jiraUserApplication === undefined && request.jiraUserColumns === undefined &&
    [request.jiraIdentityExperimental, request.jiraProjectPriority].filter((value) => value !== undefined).length === 1;
}
function jsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  let value: unknown; try { value = JSON.parse(text); } catch { return undefined; }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}
function text(value: unknown, max = 255): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Surrogate}]/u.test(value);
}
function user(request: AtlassianHttpBodyRequest, url: URL): boolean {
  if (request.jiraIdentityExperimental !== true || !url.pathname.endsWith("/rest/api/2/user")) return false;
  if (request.method === "POST") {
    const body = jsonObject(request.bodyJson);
    return url.search === "" && body !== undefined && Object.keys(body).length === 3 && text(body.name) && text(body.displayName) && text(body.emailAddress, 254);
  }
  if (url.searchParams.getAll("key").length !== 1 || [...url.searchParams.keys()].length !== 1 ||
      !text(url.searchParams.get("key")) || `?${url.searchParams.toString()}` !== url.search) return false;
  if (request.method === "DELETE") return request.bodyJson === undefined;
  if (request.method !== "PUT") return false;
  const body = jsonObject(request.bodyJson);
  return body !== undefined && Object.keys(body).length > 0 && Object.keys(body).every((key) => key === "displayName" || key === "active") &&
    (!Object.hasOwn(body, "displayName") || text(body.displayName)) && (!Object.hasOwn(body, "active") || typeof body.active === "boolean");
}
function priority(request: AtlassianHttpBodyRequest, url: URL): boolean {
  if (request.jiraProjectPriority !== true || url.search !== "") return false;
  const match = /\/rest\/api\/2\/project\/([1-9]\d{0,18})\/priorityscheme(?:\/([1-9]\d{0,18}))?$/u.exec(url.pathname);
  if (!jiraNativeId(match?.[1])) return false;
  if (request.method === "DELETE") return jiraNativeId(match?.[2]) && request.bodyJson === undefined;
  if (match?.[2] !== undefined) return false;
  if (request.method === "GET") return request.bodyJson === undefined;
  const body = jsonObject(request.bodyJson);
  return request.method === "PUT" && body !== undefined && Object.keys(body).length === 1 && typeof body.id === "number" && Number.isSafeInteger(body.id) && body.id > 0;
}
/** Closed flag, native method/query/body and media are checked before custody/admission. */
export function identityExperimentalHeaders(request: AtlassianHttpBodyRequest): Record<string, string> | undefined {
  if (!selected(request)) return undefined;
  if (!compatible(request) || !URL.canParse(request.url)) refuse();
  const url = new URL(request.url);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "" || url.toString() !== request.url ||
      /[\p{Cc}\\]/u.test(request.url) || /%(?:2e|2f|5c|25)/iu.test(url.pathname)) refuse();
  if (!(request.jiraIdentityExperimental !== undefined ? user(request, url) : priority(request, url))) refuse();
  return { "X-ExperimentalApi": "true", ...(request.bodyJson === undefined ? {} : { "content-type": "application/json" }) };
}
export function assertIdentityExperimentalTarget(base: URL, target: URL, request: AtlassianHttpBodyRequest): void {
  if (!selected(request)) return;
  const root = `${base.pathname.replace(/\/$/u, "")}/rest/api/2/`;
  if (!target.pathname.startsWith(root)) refuse();
  const path = target.pathname.slice(root.length);
  if (request.jiraIdentityExperimental !== undefined ? path !== "user" : !/^project\/[1-9]\d{0,18}\/priorityscheme(?:\/[1-9]\d{0,18})?$/u.test(path)) refuse();
}
