import { createHash } from "node:crypto";
import {
  createJiraReadRequest, executeAdmittedJiraRequest, type JiraAvatarSession, type JiraAvatarMutation, type JiraAvatarTarget,
  type JiraPrivateSessionAccess,
} from "@oscharko-dev/keiko-connectors";
import { isJiraAttachmentPreview } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { createGatewayAtlassianHttpBodyPort, type CreateAtlassianHttpPortOptions } from "./httpPort.js";

function uploadPath(operation: JiraAvatarMutation, target: JiraAvatarTarget): string | undefined {
  switch (operation) {
    case "jira.upload-temporary-avatar": return target.kind === "session" ? `avatar/${target.avatarType}/temporary` : undefined;
    case "jira.upload-issue-type-avatar": return target.kind === "issuetype" ? `issuetype/${target.id}/avatar/temporary` : undefined;
    case "jira.upload-project-avatar": return target.kind === "project" ? `project/${target.id}/avatar/temporary` : undefined;
    case "jira.upload-owned-avatar": return target.kind === "project" || target.kind === "issuetype" ? `universal_avatar/type/${target.kind}/owner/${target.id}/temp` : undefined;
    case "jira.upload-user-avatar": return target.kind === "user" ? "user/avatar/temporary" : undefined;
    default: return undefined;
  }
}
export function privateAvatarSession(options: CreateAtlassianHttpPortOptions, context: ManagedMcpInvocationContext,
  session: JiraPrivateSessionAccess, legacyTemporaryRelease?: "10.3" | "10.4"): JiraAvatarSession {
  const base = options.baseUrl.replace(/\/$/u, "");
  const http = createGatewayAtlassianHttpBodyPort({ ...options, privateAuthentication: { kind: "session", scope: "avatar", cookie: session.cookieHeader,
    ...(legacyTemporaryRelease === undefined ? {} : { legacyTemporaryRelease }) } });
  return {
    request: createJiraReadRequest({ deployment: "data-center", baseUrl: base, http }, context),
    temporary: session.temporary, rememberTemporary: session.rememberTemporary,
    upload: (operation, target, file, mimeType, bytes) => {
      const path = uploadPath(operation, target); const owned = new Uint8Array(bytes);
      if (path === undefined || !isJiraAttachmentPreview(file) || owned.byteLength !== file.sizeBytes ||
          createHash("sha256").update(owned).digest("hex") !== file.sha256 || (mimeType !== "image/png" && mimeType !== "image/jpeg"))
        return Promise.resolve({ ok: false, reason: "field-validation" });
      const query = new URLSearchParams(); if (target.kind === "user") query.set("username", target.name);
      query.set("filename", file.name); query.set("size", String(owned.byteLength));
      return executeAdmittedJiraRequest({ http }, context, context.signal, { method: "POST", url: `${base}/rest/api/2/${path}?${query.toString()}`,
        jiraAvatarImage: true, upload: { contentType: mimeType, bytes: owned }, expect: "json" });
    },
  };
}
