import { describe, expect, it, vi } from "vitest";
import { JIRA_ATTACHMENT_MAX_BYTES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  ATLASSIAN_HTTP_UPLOAD_MAX_BYTES,
  type AtlassianHttpBodyPort,
  type AtlassianHttpBodyResult,
} from "./atlassian-http-port.js";
import {
  executeAtlassianWriteRequest,
  type AtlassianWriteHttpRequest,
} from "./atlassian-write-http.js";
const GET: AtlassianWriteHttpRequest = {
  method: "GET",
  url: "https://jira.example.invalid/context/rest/api/2/email-templates",
  expect: "jira-email-template-zip",
  jiraEmailTemplateArchive: true,
};
const BYTES = new Uint8Array([0x50, 0x4b, 0, 0xff, 0xc0, 0x80]);
const ARCHIVE = {
  kind: "response",
  status: 200,
  bodyText: "",
  archiveBytes: BYTES,
  bodyBytes: BYTES.byteLength,
  truncated: false,
} as const;
function port(result: AtlassianHttpBodyResult = ARCHIVE) {
  return vi.fn<AtlassianHttpBodyPort>().mockResolvedValue(result);
}
describe("closed ZIP response codec on the existing write transport", () => {
  it("returns exact bytes without UTF8 or JSON interpretation", async () => {
    const http = port();
    expect(await executeAtlassianWriteRequest({ http }, GET)).toEqual({
      ok: true,
      status: 200,
      body: undefined,
      bytes: BYTES,
    });
    expect(http.mock.calls[0]?.[0]).toMatchObject({
      jiraEmailTemplateArchive: true,
      maxBodyBytes: JIRA_ATTACHMENT_MAX_BYTES,
    });
  });
  it.each([
    { kind: "response", status: 200, bodyText: "", bodyBytes: BYTES.byteLength, truncated: false },
    { ...ARCHIVE, bodyBytes: BYTES.byteLength - 1 },
    { ...ARCHIVE, bodyText: "decoded-content" },
  ] satisfies readonly AtlassianHttpBodyResult[])(
    "refuses incomplete or contradictory binary codec evidence",
    async (response) => {
      expect(await executeAtlassianWriteRequest({ http: port(response) }, GET)).toMatchObject({
        ok: false,
        reason: "malformed-payload",
      });
    },
  );
  it.each([
    { ...ARCHIVE, truncated: true },
    { ...ARCHIVE, bodyBytes: JIRA_ATTACHMENT_MAX_BYTES + 1 },
  ] satisfies readonly AtlassianHttpBodyResult[])(
    "refuses truncated or oversized archives without returning partial bytes",
    async (response) => {
      const result = await executeAtlassianWriteRequest({ http: port(response) }, GET);
      expect(result).toMatchObject({ ok: false, reason: "bounds-exceeded" });
      expect(result).not.toHaveProperty("bytes");
    },
  );
  it("keeps native HTTP errors on the bounded JSON error path", async () => {
    const text = '{"errorMessages":["Archive rejected"]}';
    const http = port({
      kind: "response",
      status: 400,
      bodyText: text,
      bodyBytes: text.length,
      truncated: false,
    });
    expect(await executeAtlassianWriteRequest({ http }, GET)).toMatchObject({
      ok: false,
      reason: "field-validation",
      httpStatus: 400,
      remote: { messages: ["Archive rejected"] },
    });
  });
  it("uses the existing GET retry policy while never retrying ZIP POST", async () => {
    const failed = {
      kind: "response",
      status: 503,
      bodyText: "",
      bodyBytes: 0,
      truncated: false,
    } as const;
    const http = port().mockResolvedValueOnce(failed).mockResolvedValueOnce(ARCHIVE);
    const sleep = vi.fn(() => Promise.resolve());
    expect(await executeAtlassianWriteRequest({ http, sleep }, GET)).toMatchObject({
      ok: true,
      bytes: BYTES,
    });
    expect(http).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    const post = port(failed);
    expect(
      await executeAtlassianWriteRequest(
        { http: post, sleep },
        {
          ...GET,
          method: "POST",
          expect: "none",
          upload: { contentType: "application/zip", bytes: BYTES },
        },
      ),
    ).toMatchObject({ ok: false, reason: "unavailable" });
    expect(post).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledOnce();
  });
  it.each([
    { ...GET, jiraEmailTemplateArchive: undefined },
    { ...GET, bodyJson: "{}" },
    { ...GET, jiraExperimental: true },
    { ...GET, jiraPermissionAttribute: true },
    { ...GET, method: "PUT" },
    { ...GET, method: "POST", expect: "none" },
    { ...GET, method: "POST", expect: "none", upload: { contentType: "text/plain", bytes: BYTES } },
  ] satisfies readonly AtlassianWriteHttpRequest[])(
    "refuses archive flag/codec/body mismatches before HTTP",
    async (request) => {
      const http = port();
      expect(await executeAtlassianWriteRequest({ http }, request)).toMatchObject({
        ok: false,
        reason: "malformed-payload",
      });
      expect(http).not.toHaveBeenCalled();
    },
  );
  it("retains the transport upload ceiling even for a closed raw ZIP", async () => {
    const http = port();
    expect(
      await executeAtlassianWriteRequest(
        { http },
        {
          ...GET,
          method: "POST",
          expect: "none",
          upload: {
            contentType: "application/zip",
            bytes: new Uint8Array(ATLASSIAN_HTTP_UPLOAD_MAX_BYTES + 1),
          },
        },
      ),
    ).toEqual({ ok: false, reason: "bounds-exceeded" });
    expect(http).not.toHaveBeenCalled();
  });
});
