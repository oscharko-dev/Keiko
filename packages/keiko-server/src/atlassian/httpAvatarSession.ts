import { AtlassianCredentialCustodyError, jiraNativeId, jiraPropertyUserText, parseJsonRecord, type AtlassianHttpBodyRequest } from "@oscharko-dev/keiko-connectors";
import { JIRA_ATTACHMENT_MAX_BYTES, isJiraAttachmentName } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { JiraPrivateAuthentication } from "./httpRequestLifecycle.js";

function refuse(): never { throw new AtlassianCredentialCustodyError("invalid-input", ["Invalid private Jira session request"]); }
function query(url: URL, keys: readonly string[]): boolean {
  return [...url.searchParams.keys()].length === keys.length && keys.every((key) => url.searchParams.getAll(key).length === 1) &&
    (keys.length === 0 ? url.search === "" : url.search === `?${url.searchParams.toString()}`);
}
function namedUser(url: URL): boolean { return query(url, ["username"]) && jiraPropertyUserText(url.searchParams.get("username")); }
function idPath(path: string, pattern: RegExp): boolean {
  const match = pattern.exec(path); return match !== null && match.slice(1).every(jiraNativeId);
}
function avatarRead(path: string, url: URL): boolean {
  if (path === "myself") return query(url, []);
  if (path === "user") return (query(url, ["key"]) && jiraPropertyUserText(url.searchParams.get("key"))) || namedUser(url);
  if (path === "user/avatars") return namedUser(url);
  return query(url, []) && (idPath(path, /^(?:project|issuetype)\/([1-9]\d{0,18})$/u) ||
    idPath(path, /^project\/([1-9]\d{0,18})\/avatars$/u) ||
    idPath(path, /^universal_avatar\/type\/(?:project|issuetype)\/owner\/([1-9]\d{0,18})$/u));
}
function cropBody(text: string | undefined): boolean {
  if (text === undefined) return false;
  const raw = parseJsonRecord(text);
  if (raw === undefined) return false;
  const fields = Object.entries(raw);
  return fields.length === 3 && fields.every(([key, value]) => (key === "cropperOffsetX" || key === "cropperOffsetY" || key === "cropperWidth") &&
    typeof value === "number" && Number.isSafeInteger(value) && value >= (key === "cropperWidth" ? 1 : 0) && value <= 2147483647);
}
function cropPath(path: string, url: URL, legacy: boolean): boolean {
  if (path === "user/avatar") return namedUser(url);
  if (!query(url, [])) return false;
  return idPath(path, /^(?:project|issuetype)\/([1-9]\d{0,18})\/avatar$/u) ||
    idPath(path, /^universal_avatar\/type\/(?:project|issuetype)\/owner\/([1-9]\d{0,18})\/avatar$/u) ||
    (legacy && /^avatar\/(?:project|user|issuetype)\/temporaryCrop$/u.test(path));
}
function uploadPath(path: string, url: URL, request: AtlassianHttpBodyRequest, legacy: boolean): boolean {
  const upload = request.upload;
  if (request.jiraAvatarImage !== true || request.method !== "POST" || request.bodyJson !== undefined || upload === undefined ||
      (upload.contentType !== "image/png" && upload.contentType !== "image/jpeg") || upload.bytes.byteLength < 1 || upload.bytes.byteLength > JIRA_ATTACHMENT_MAX_BYTES) return false;
  const user = path === "user/avatar/temporary";
  if (!query(url, user ? ["username", "filename", "size"] : ["filename", "size"]) ||
      (user && !jiraPropertyUserText(url.searchParams.get("username"))) || !isJiraAttachmentName(url.searchParams.get("filename")) ||
      url.searchParams.get("size") !== String(upload.bytes.byteLength)) return false;
  return user || idPath(path, /^(?:project|issuetype)\/([1-9]\d{0,18})\/avatar\/temporary$/u) ||
    idPath(path, /^universal_avatar\/type\/(?:project|issuetype)\/owner\/([1-9]\d{0,18})\/temp$/u) ||
    (legacy && /^avatar\/(?:project|user|issuetype)\/temporary$/u.test(path));
}
function compatible(request: AtlassianHttpBodyRequest): boolean {
  return request.jiraHumanInput === undefined && request.jiraExperimental === undefined && request.jiraPermissionAttribute === undefined &&
    request.jiraEmailTemplateArchive === undefined && request.jiraApplicationRole === undefined && request.jiraUserApplication === undefined &&
    request.jiraUserColumns === undefined && request.jiraIdentityExperimental === undefined && request.jiraProjectPriority === undefined;
}
/** Cookie authentication is available only to these native proof/session/avatar routes. */
export function assertPrivateSessionRequest(base: URL, request: AtlassianHttpBodyRequest, authentication?: JiraPrivateAuthentication): void {
  if (authentication?.kind !== "session") { if (request.jiraAvatarImage !== undefined) refuse(); return; }
  if (!compatible(request)) return refuse();
  const url = new URL(request.url); const prefix = base.pathname.replace(/\/$/u, "");
  const path = url.pathname.slice(`${prefix}/rest/api/2/`.length);
  const statusOnly = request.bodyJson === undefined && request.upload === undefined && request.jiraAvatarImage === undefined && query(url, []);
  if (authentication.scope === "logout" || authentication.scope === "websudo") {
    if (!statusOnly || request.method !== "DELETE" || url.pathname !== `${prefix}/rest/auth/1/${authentication.scope === "logout" ? "session" : "websudo"}`) refuse();
    return;
  }
  if (authentication.scope === "actor") {
    if (!statusOnly || request.method !== "GET" || (url.pathname !== `${prefix}/rest/api/2/myself` && url.pathname !== `${prefix}/rest/auth/1/session`)) refuse();
    return;
  }
  if (!url.pathname.startsWith(`${prefix}/rest/api/2/`)) return refuse();
  if (request.method === "GET" && request.bodyJson === undefined && request.upload === undefined && request.jiraAvatarImage === undefined && avatarRead(path, url)) return;
  const legacy = authentication.legacyTemporaryRelease !== undefined;
  if (uploadPath(path, url, request, legacy)) return;
  if (request.method === "POST" && request.upload === undefined && request.jiraAvatarImage === undefined && cropBody(request.bodyJson) && cropPath(path, url, legacy)) return;
  return refuse();
}
