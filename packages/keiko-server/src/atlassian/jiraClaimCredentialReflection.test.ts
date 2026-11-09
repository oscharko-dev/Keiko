import { describe, expect, it, vi } from "vitest";
import type {
  AtlassianHttpBodyPort,
  AtlassianHttpBodyRequest,
  AtlassianResolvedCredential,
} from "@oscharko-dev/keiko-connectors";
import { createJiraManagedProvider } from "@oscharko-dev/keiko-connectors";
import { atlassianAuthorizationHeaderValue } from "@oscharko-dev/keiko-connectors";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createGatewayAtlassianHttpBodyPort } from "./httpPort.js";
import { jiraDeclarationForTool } from "./jiraManagedProvider.js";
import { zipTextEntries } from "../../../../tests/support/zip-fixture.js";
import { defaultServerDiagnosticSink } from "../diagnostics-log.js";

const BASE = "https://jira.example.invalid";
const PAT = ["synthetic", "jira", "pat", "4288"].join("-");
const CREDENTIALS: readonly AtlassianResolvedCredential[] = [
  { scheme: "bearer-pat", apiToken: PAT },
  { scheme: "basic-api-token", apiToken: PAT, accountEmail: "synthetic@example.invalid" },
];
const REQUEST: AtlassianHttpBodyRequest = {
  method: "GET",
  url: `${BASE}/rest/api/2/search?jql=project%3DSYN`,
  maxBodyBytes: 16_384,
  timeoutMs: 1000,
};
function fixture(
  credential: AtlassianResolvedCredential,
  body: string | Uint8Array<ArrayBuffer>,
  status = 400,
  headers: Readonly<Record<string, string>> = {},
): {
  readonly http: AtlassianHttpBodyPort;
  readonly fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
  readonly log: ReturnType<typeof createBufferedServerLogSink>;
  readonly onResponse: ReturnType<typeof vi.fn<() => boolean>>;
  readonly resolveForExecution: ReturnType<typeof vi.fn<() => AtlassianResolvedCredential>>;
} {
  const log = createBufferedServerLogSink();
  const onResponse = vi.fn(() => true);
  const resolveForExecution = vi.fn(() => credential);
  const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(
      atlassianAuthorizationHeaderValue(credential),
    );
    return Promise.resolve(
      new Response(body, {
        status,
        headers: {
          "content-type": typeof body === "string" ? "application/json" : "application/zip",
          ...headers,
        },
      }),
    );
  });
  const http = createGatewayAtlassianHttpBodyPort({
    baseUrl: BASE,
    authRef: "synthetic-reference",
    credentials: { resolveForExecution },
    fetchImpl,
    activityLog: log,
    correlationId: "credential-reflection-proof",
    singleAttempt: true,
    onResponse,
  });
  return { http, fetchImpl, log, onResponse, resolveForExecution };
}
function errorBody(spelling: string): string {
  return `{"errorMessages":["Echo ${spelling}"],"errors":{}}`;
}
function unicodeSpelling(value: string): string {
  return Array.from(value)
    .map((point) => `\\u${point.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .join("");
}

describe.each(CREDENTIALS)("request-owned $scheme credential reflection floor", (credential) => {
  it.each([
    { kind: "literal", spelling: PAT },
    { kind: "JSON escaped", spelling: unicodeSpelling(PAT) },
    {
      kind: "percent encoded",
      spelling: Array.from(PAT)
        .map((point) => `%${point.charCodeAt(0).toString(16)}`)
        .join(""),
    },
  ])("withholds $kind PAT error bytes while preserving the HTTP status", async ({ spelling }) => {
    const f = fixture(credential, errorBody(spelling));
    expect(await f.http(REQUEST)).toMatchObject({
      kind: "response",
      status: 400,
      bodyText: "",
      truncated: true,
    });
    expect(f.resolveForExecution).toHaveBeenCalledOnce();
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(f.onResponse).toHaveBeenCalledWith(expect.anything(), 400);
  });
  it("preserves an ordinary JSON response byte for byte", async () => {
    const body = errorBody("Ordinary field validation");
    const f = fixture(credential, body);
    expect(await f.http(REQUEST)).toMatchObject({
      kind: "response",
      status: 400,
      bodyText: body,
      truncated: false,
    });
  });
  it("never returns the actual reflected opaque PAT through the native Jira error projector", async () => {
    const f = fixture(credential, errorBody(PAT));
    const declaration = jiraDeclarationForTool("jira.search");
    if (declaration === undefined) throw new TypeError("Missing native search declaration");
    const provider = createJiraManagedProvider({
      connection: () => ({ baseUrl: BASE, deployment: "data-center", http: f.http }),
      declarations: [declaration],
    });
    const tool = provider.tools()[0];
    if (tool === undefined) throw new TypeError("Missing native search tool");
    const result = await tool.execute(
      { jql: "project=SYN" },
      {
        invocationId: "reflection-search",
        correlationId: "credential-reflection-proof",
        signal: new AbortController().signal,
        beforeEffect: () => true,
      },
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(PAT);
    expect(f.fetchImpl).toHaveBeenCalledOnce();
  });
});

it("preserves a write acknowledgement while withholding a reflected Basic authorization representation", async () => {
  const credential = CREDENTIALS[1];
  if (credential === undefined) throw new TypeError("Missing Basic fixture credential");
  const authorization = atlassianAuthorizationHeaderValue(credential).replace("Basic ", "");
  const f = fixture(credential, errorBody(authorization), 201);
  expect(await f.http({ ...REQUEST, method: "POST", bodyJson: "{}" })).toMatchObject({
    kind: "response",
    status: 201,
    bodyText: "",
    truncated: true,
  });
  expect(f.onResponse).toHaveBeenCalledWith(expect.anything(), 201);
  expect(f.fetchImpl).toHaveBeenCalledOnce();
});

it("records only closed reflection facts on the registered Activity Log", async () => {
  const credential = CREDENTIALS[0];
  if (credential === undefined) throw new TypeError("Missing PAT fixture credential");
  const f = fixture(credential, errorBody(PAT));
  await f.http(REQUEST);
  const event = f.log.events.find((entry) => entry.op === "atlassian.http.credential-reflection");
  expect(event).toBeDefined();
  if (event === undefined) throw new TypeError("Missing credential-floor event");
  const line = formatActivityLogProofLine(event);
  expect(expectActivityLogProof("atlassian.http.credential-reflection.line", line)).toMatchObject({
    status: 400,
    reason: "reflected-secret",
    reflectionCount: 1,
    completeness: "complete",
    loss: "none",
  });
  expect(line).not.toMatch(/synthetic|jira\.example|Authorization|Bearer|errorMessages/u);
});

const ZIP_REQUEST: AtlassianHttpBodyRequest = {
  ...REQUEST,
  url: `${BASE}/rest/api/2/email-templates`,
  jiraEmailTemplateArchive: true,
};
it("withholds a native ZIP whose entry name reflects the actual Jira PAT", async () => {
  const credential = CREDENTIALS[0];
  if (credential === undefined) throw new TypeError("Missing PAT fixture credential");
  const bytes = new Uint8Array(
    zipTextEntries([{ name: `templates/${PAT}.vm`, content: "Ordinary template" }]),
  );
  const f = fixture(credential, bytes, 200);
  const result = await f.http(ZIP_REQUEST);
  expect(result).toMatchObject({ kind: "response", status: 200, bodyText: "", truncated: true });
  expect(result).not.toHaveProperty("archiveBytes");
  expect(f.fetchImpl).toHaveBeenCalledOnce();
});
it("preserves an ordinary native ZIP byte for byte", async () => {
  const credential = CREDENTIALS[0];
  if (credential === undefined) throw new TypeError("Missing PAT fixture credential");
  const bytes = new Uint8Array(
    zipTextEntries([{ name: "templates/ordinary.vm", content: "Ordinary template" }]),
  );
  const f = fixture(credential, bytes, 200);
  const result = await f.http(ZIP_REQUEST);
  expect(result).toMatchObject({
    kind: "response",
    status: 200,
    archiveBytes: bytes,
    truncated: false,
  });
  expect(f.resolveForExecution).toHaveBeenCalledOnce();
});

it("withholds reflected bytes and preserves ACK even when its Activity Log sink throws", async () => {
  const credential = CREDENTIALS[0];
  if (credential === undefined) throw new TypeError("Missing PAT fixture credential");
  const f = fixture(credential, errorBody(PAT), 201);
  const diagnostic = vi
    .spyOn(defaultServerDiagnosticSink, "record")
    .mockImplementation(() => undefined);
  vi.spyOn(f.log, "write").mockImplementation(() => {
    throw new Error(`Synthetic sink failure ${PAT}`);
  });
  try {
    const result = await f.http({ ...REQUEST, method: "POST", bodyJson: "{}" });
    expect(result).toMatchObject({ kind: "response", status: 201, bodyText: "", truncated: true });
    expect(f.onResponse).toHaveBeenCalledWith(expect.anything(), 201);
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "atlassian.http.credential-reflection" }),
    );
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(PAT);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("jira.example.invalid");
    expect(f.fetchImpl).toHaveBeenCalledOnce();
  } finally {
    diagnostic.mockRestore();
  }
});

it("withholds all bytes if the existing request signal aborts at a scan yield after ACK", async () => {
  const credential = CREDENTIALS[0];
  if (credential === undefined) throw new TypeError("Missing PAT fixture credential");
  const controller = new AbortController();
  const f = fixture(credential, errorBody("ordinary ".repeat(3000)), 200);
  f.onResponse.mockImplementation(() => {
    setImmediate(() => {
      controller.abort();
    });
    return true;
  });
  const result = await f.http({ ...REQUEST, maxBodyBytes: 65_536, signal: controller.signal });
  expect(result).toMatchObject({ kind: "response", status: 200, bodyText: "", truncated: true });
  expect(result).not.toHaveProperty("archiveBytes");
  expect(controller.signal.aborted).toBe(true);
  expect(
    f.log.events.find((event) => event.op === "atlassian.http.credential-reflection")?.extra
      ?.reason,
  ).toBe("scan-budget-exhausted");
  expect(f.fetchImpl).toHaveBeenCalledOnce();
});
it("refuses an excessive retained spelling plan before unbounded scanner work", async () => {
  const credential: AtlassianResolvedCredential = {
    scheme: "bearer-pat",
    apiToken: `${"a".repeat(1023)}b`,
  };
  const f = fixture(credential, errorBody("a".repeat(3000)), 200);
  const result = await f.http({ ...REQUEST, maxBodyBytes: 65_536 });
  expect(result).toMatchObject({ kind: "response", status: 200, bodyText: "", truncated: true });
  expect(
    f.log.events.find((event) => event.op === "atlassian.http.credential-reflection")?.extra
      ?.reason,
  ).toBe("scan-budget-exhausted");
  expect(f.fetchImpl).toHaveBeenCalledOnce();
});

it("preserves an ordinary response when a split secret prefix is disproved by the next byte", async () => {
  const credential: AtlassianResolvedCredential = {
    scheme: "bearer-pat",
    apiToken: `Z${"x".repeat(126)}b`,
  };
  const prefix = '{"message":"';
  const body = `${prefix}${"q".repeat(1023 - prefix.length)}Za${"q".repeat(2048)}"}`;
  const f = fixture(credential, body, 200);
  expect(await f.http(REQUEST)).toMatchObject({
    kind: "response",
    status: 200,
    bodyText: body,
    truncated: false,
  });
  expect(
    f.log.events.find((event) => event.op === "atlassian.http.credential-reflection"),
  ).toBeUndefined();
});

const ROLE_REQUEST: AtlassianHttpBodyRequest = {
  ...REQUEST,
  url: `${BASE}/rest/api/2/applicationrole`,
  jiraApplicationRole: "version",
};
it("withholds the actual Jira PAT reflected in the sole allowlisted native ETag metadata", async () => {
  const credential = CREDENTIALS[0];
  if (credential === undefined) throw new TypeError("Missing PAT fixture credential");
  const body = errorBody("Ordinary response");
  const f = fixture(credential, body, 200, { etag: `"${PAT}"` });
  const result = await f.http(ROLE_REQUEST);
  expect(result).toMatchObject({ kind: "response", status: 200, bodyText: body, truncated: false });
  expect(result).not.toHaveProperty("applicationRoleVersion");
  expect(JSON.stringify(result)).not.toContain(PAT);
  expect(
    f.log.events.find((event) => event.op === "atlassian.http.credential-reflection")?.extra
      ?.reason,
  ).toBe("reflected-secret");
});
it("preserves ordinary strong native ETag metadata", async () => {
  const credential = CREDENTIALS[0];
  if (credential === undefined) throw new TypeError("Missing PAT fixture credential");
  const f = fixture(credential, errorBody("Ordinary response"), 200, {
    etag: '"ordinary-version"',
  });
  expect(await f.http(ROLE_REQUEST)).toMatchObject({
    kind: "response",
    status: 200,
    applicationRoleVersion: '"ordinary-version"',
    truncated: false,
  });
});
