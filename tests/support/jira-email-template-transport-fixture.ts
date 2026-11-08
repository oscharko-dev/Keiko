import { expect } from "vitest";
import type { AtlassianHttpBodyRequest, AtlassianHttpBodyResult, JiraManagedConnection } from "@oscharko-dev/keiko-connectors";
import { inspectJiraEmailTemplateArchive } from "../../packages/keiko-server/src/atlassian/jiraEmailTemplateArchive.js";
import { emailTemplateFixture } from "./jira-email-template-fixture.js";
import { response } from "./jira-managed-remote.js";

const pack = emailTemplateFixture();
const ACTOR = "synthetic-actor";
export const EMAIL_TEMPLATE_NATIVE_CASES = [
  { tool: "jira.email-template-pack", args: {}, path: "email-templates", method: "GET" },
  { tool: "jira.upload-email-template-pack", args: { ...pack.uploadArgs, expectedActorKey: ACTOR }, path: "email-templates", method: "POST",
    receipt: { userKey: ACTOR, emailTemplateAction: "upload", uploadSha256: pack.expectedFile.sha256, uploadBytes: pack.expectedFile.sizeBytes } },
  { tool: "jira.apply-email-template-pack", args: { ...pack.applyArgs, expectedActorKey: ACTOR }, path: "email-templates/apply", method: "POST",
    receipt: { userKey: ACTOR, emailTemplateAction: "apply", priorManifestSha256: pack.pack.manifestSha256, observedManifestSha256: pack.pack.manifestSha256 } },
  { tool: "jira.revert-email-template-pack", args: { ...pack.revertArgs, expectedActorKey: ACTOR }, path: "email-templates/revert", method: "POST",
    receipt: { userKey: ACTOR, emailTemplateAction: "revert", priorManifestSha256: pack.pack.manifestSha256, observedManifestSha256: pack.pack.manifestSha256 } },
] as const;

/** Uses the real archive inspector, plus a synthetic already-governed file source. */
export function emailTemplateFixtureAdmission(): NonNullable<JiraManagedConnection["emailTemplates"]> {
  return {
    inspect: (bytes) => inspectJiraEmailTemplateArchive(bytes, { secrets: [] }),
    sourceFor: () => async (request) => {
      expect(request).toMatchObject({ kind: "connected-file", path: "docs/templates.zip", purpose: "jira-email-template-pack" });
      return { ok: true, content: { name: "templates.zip", bytes: Uint8Array.from(pack.bytes), sha256: pack.expectedFile.sha256 } };
    },
  };
}
export function emailTemplateTransportController(operation: string | undefined, actorKey = ACTOR) {
  const selected = EMAIL_TEMPLATE_NATIVE_CASES.find((item) => item.tool === operation);
  if (selected === undefined) return undefined;
  let writes = 0;
  let action: string | null = null;
  const root = "/context/rest/api/2/";
  return {
    snapshot: () => ({ writes, action }),
    async read(request: AtlassianHttpBodyRequest): Promise<AtlassianHttpBodyResult | undefined> {
      const url = new URL(request.url);
      expect(url.search).toBe("");
      expect(request.method).toBe("GET"); expect(request.bodyJson).toBeUndefined(); expect(request.upload).toBeUndefined();
      if (url.pathname === `${root}myself`) return response({ key: actorKey, name: "operator" });
      if (url.pathname !== `${root}email-templates`) return undefined;
      expect(request.jiraEmailTemplateArchive).toBe(true);
      return { kind: "response", status: 200, bodyText: "", bodyBytes: pack.bytes.byteLength,
        archiveBytes: Uint8Array.from(pack.bytes), truncated: false };
    },
    async write(request: AtlassianHttpBodyRequest): Promise<AtlassianHttpBodyResult | undefined> {
      const url = new URL(request.url);
      if (url.pathname !== `${root}${selected.path}`) return undefined;
      expect(url.search).toBe(""); expect(request.method).toBe("POST"); expect(request.bodyJson).toBeUndefined();
      expect(++writes).toBe(1);
      if (selected.tool === "jira.upload-email-template-pack") {
        expect(request.jiraEmailTemplateArchive).toBe(true);
        expect(request.upload?.contentType).toBe("application/zip");
        expect(request.upload?.bytes).toEqual(Uint8Array.from(pack.bytes));
        action = "upload";
      } else {
        expect(request.jiraEmailTemplateArchive).toBeUndefined(); expect(request.upload).toBeUndefined();
        action = selected.tool === "jira.apply-email-template-pack" ? "apply" : "revert";
      }
      return response(undefined, 204);
    },
  };
}
