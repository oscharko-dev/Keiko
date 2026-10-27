import {
  EditorAgentAuthorityRegistry,
  type ChatToolAuthorityResolution,
} from "../editor/agentAuthorityRegistry.js";
import {
  chatAuthorityFixture,
  CHAT_AUTHORITY_TEST_NOW,
} from "../editor/chatAuthority.test-support.js";
// Issue #2241 — /api/atlassian-connectors/credentials/* route integration tests. The createUiServer
// fixture mirrors command-runner-routes.test.ts so the CSRF guard, JSON content-type gate,
// host-check, correlation-id plumbing, and top-level catch all run live. Custody is REAL (the
// keiko-security vault on the env-key tier plus the private metadata store, both in a fresh temp
// config dir) so the ciphertext-on-disk and write-only acceptance criteria are proven at the route
// boundary; only the outbound transport is faked. Secrets are synthetic, assembled at runtime.

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import type { Chat } from "../store/index.js";
import { jiraChatActorDigest } from "./jiraPodAccess.js";
import { invalidateJiraPodChats } from "./jiraPodLifecycle.js";
import { runSerializedChatTurn } from "../chat-turn-serializer.js";
import {
  createFileServerLogSink,
  createServerLogger,
  setServerLogger,
} from "../observability/index.js";
import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AtlassianCredentialCustodyError,
  createAtlassianCredentialCustody,
  type AtlassianCredentialCustody,
  type AtlassianCredentialMetadata,
  type AtlassianHttpBodyPort,
  type AtlassianHttpBodyResult,
  type AtlassianHttpPort,
  type AtlassianHttpRequest,
  type AtlassianHttpBodyRequest,
  type AtlassianHttpResult,
} from "@oscharko-dev/keiko-connectors";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../../tests/support/activity-log-proof.js";
import { buildCspHeader } from "../csp.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "../index.js";
import { createRunRegistry } from "../runs.js";
import { createUiServer, UI_HOST } from "../server.js";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import type { ServerLogEvent, ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { mockRequest, mockResponse } from "../_support.js";
import type { RouteContext } from "../routes.js";
import {
  atlassianCredentialMetadataPath,
  createAtlassianCredentialMetadataStore,
} from "./credentialMetadataStore.js";
import { buildAtlassianConnectorCredentialDeps } from "./wiring.js";
import {
  handleCreateAtlassianConnectorCredential,
  type AtlassianConnectorCredentialDeps,
} from "./credentialRoutes.js";

const SYNTHETIC_TOKEN = ["ATATT", "route", "test", "9876543210", "zyxwvutsrq", "KLMNOPQRST"].join(
  "",
);
const SYNTHETIC_EMAIL = ["routes-tester", "@", "example", ".", "com"].join("");

let server: Server;
let staticRoot: string;
let configDir: string;
let configPath: string;
let port: number;
let diagnostics: ServerDiagnosticRecord[];
let wiring: AtlassianConnectorCredentialDeps;
let fixtureStore: ReturnType<typeof createInMemoryUiStore>;
let fakePortResult: AtlassianHttpResult;
let fakePortRequests: (AtlassianHttpRequest | AtlassianHttpBodyRequest)[];

function vaultEnv(): Record<string, string> {
  return { KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY: randomBytes(32).toString("base64") };
}

function fakeHttpPortFactory(): (metadata: AtlassianCredentialMetadata) => AtlassianHttpPort {
  return (): AtlassianHttpPort =>
    (request: AtlassianHttpRequest): Promise<AtlassianHttpResult> => {
      fakePortRequests.push(request);
      return Promise.resolve(fakePortResult);
    };
}

function fakeHttpBodyPortFactory(): (
  metadata: AtlassianCredentialMetadata,
) => AtlassianHttpBodyPort {
  return () => (request) => {
    fakePortRequests.push(request);
    if (fakePortResult.kind !== "response") return Promise.resolve(fakePortResult);
    const bodyText = JSON.stringify({ accountId: "synthetic-id", active: true });
    return Promise.resolve({
      ...fakePortResult,
      bodyText,
      bodyBytes: Buffer.byteLength(bodyText),
      truncated: false,
    });
  };
}

function baseDeps(atlassian: AtlassianConnectorCredentialDeps | undefined): UiHandlerDeps {
  return {
    serverPrincipal: () => activePrincipal,
    agentAuthorityRegistry: fixtureAuthorityRegistry,
    config: undefined,
    configPresent: false,
    evidenceStore: {
      put: (): string => "",
      list: (): readonly string[] => [],
      get: (): string | undefined => undefined,
      delete: (): void => undefined,
    },
    env: {},
    redactor: buildRedactor({}),
    diagnostics: {
      record: (record): void => {
        diagnostics.push(record);
      },
    },
    registry: createRunRegistry(),
    modelPortFactory: (): undefined => undefined,
    store: fixtureStore,
    ...(atlassian === undefined ? {} : { atlassianConnectorCredentials: atlassian }),
  };
}

let activePrincipal = "synthetic-operator";
let fixtureAuthorityRegistry: EditorAgentAuthorityRegistry;

function livePodCreateInput(): Record<string, unknown> {
  return {
    provider: "jira",
    displayName: "Live Jira",
    baseUrl: "https://jira.example.invalid/context",
    authScheme: "bearer-pat",
    deployment: "data-center",
    apiToken: SYNTHETIC_TOKEN,
    livePodCreationRequestId: "6d3eb557-e77f-4215-a806-af1826230b18",
  };
}

function jiraProbeResponse(
  request: AtlassianHttpBodyRequest,
  status = 200,
): AtlassianHttpBodyResult {
  const bodyText = JSON.stringify(
    request.url.endsWith("/serverInfo")
      ? { version: "10.3.26", versionNumbers: [10, 3, 26], deploymentType: "Server" }
      : { name: "synthetic-user", key: "synthetic-key", active: true },
  );
  return {
    kind: "response",
    status,
    bodyText,
    bodyBytes: Buffer.byteLength(bodyText),
    truncated: false,
  };
}

function verifyCredentialRequest(authRef: string): Promise<Response> {
  return fetch(
    `${baseUrl()}/api/atlassian-connectors/credentials/${encodeURIComponent(authRef)}/verify`,
    { method: "POST", headers: csrfHeaders(), body: "{}" },
  );
}

function probeSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function readVerificationEvidence(
  sink: ReturnType<typeof createFileServerLogSink>,
): readonly Record<string, unknown>[] {
  sink.close?.();
  return persistedActivityLogLines(
    readPersistedActivityLog(configDir),
    "atlassian.connection.checked",
  ).map((line) => expectActivityLogProof("atlassian.connection.checked.line", line));
}

async function listen(srv: Server): Promise<number> {
  await new Promise<void>((resolve) => srv.listen(0, UI_HOST, resolve));
  return (srv.address() as AddressInfo).port;
}

async function closeServer(srv: Server = server): Promise<void> {
  await new Promise<void>((resolve) => {
    srv.close(() => {
      resolve();
    });
  });
}

async function buildServer(handlerDeps: UiHandlerDeps): Promise<{ server: Server; port: number }> {
  const probe = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0, handlerDeps });
  const chosenPort = await listen(probe);
  await closeServer(probe);
  const next = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port: chosenPort,
    handlerDeps,
  });
  await new Promise<void>((resolve) => next.listen(chosenPort, UI_HOST, resolve));
  return { server: next, port: chosenPort };
}

async function rebuild(atlassian: AtlassianConnectorCredentialDeps | undefined): Promise<void> {
  await closeServer();
  const built = await buildServer(baseDeps(atlassian));
  server = built.server;
  port = built.port;
}

function baseUrl(): string {
  return `http://${UI_HOST}:${String(port)}`;
}

function csrfHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", "X-Keiko-CSRF": "1" };
}

function createBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    provider: "jira",
    displayName: "Team Jira",
    baseUrl: "https://acme.example",
    authScheme: "basic-api-token",
    accountEmail: SYNTHETIC_EMAIL,
    apiToken: SYNTHETIC_TOKEN,
    ...overrides,
  });
}

function inMemoryCreateContext(): RouteContext {
  const path = "/api/atlassian-connectors/credentials";
  return {
    req: mockRequest({ method: "POST", url: path, headers: csrfHeaders(), body: createBody() }),
    res: mockResponse().res,
    params: {},
    url: new URL(`http://${UI_HOST}${path}`),
    correlationId: "credential-route-test",
  };
}

async function createCredential(): Promise<AtlassianCredentialMetadata> {
  const res = await fetch(`${baseUrl()}/api/atlassian-connectors/credentials`, {
    method: "POST",
    headers: csrfHeaders(),
    body: createBody(),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as AtlassianCredentialMetadata;
}

function expectNoSecretBytes(text: string): void {
  expect(text).not.toContain(SYNTHETIC_TOKEN);
  expect(text).not.toContain(SYNTHETIC_EMAIL);
}

beforeEach(async () => {
  fixtureStore = createInMemoryUiStore();
  fixtureAuthorityRegistry = new EditorAgentAuthorityRegistry();
  activePrincipal = "synthetic-operator";
  // realpath: on macOS tmpdir() lives under the /var -> /private/var symlink, which the vault and
  // private-JSON writers' symlink-refusing path checks correctly reject.
  const realTmp = realpathSync(tmpdir());
  staticRoot = await mkdtemp(join(realTmp, "keiko-atl-routes-static-"));
  configDir = await mkdtemp(join(realTmp, "keiko-atl-routes-config-"));
  configPath = join(configDir, "keiko.config.json");
  diagnostics = [];
  fakePortRequests = [];
  fakePortResult = { kind: "response", status: 200 };
  const built = buildAtlassianConnectorCredentialDeps({
    onLivePodInvalidated: (podId, generation, correlationId) => {
      invalidateJiraPodChats(
        fixtureStore,
        podId,
        generation,
        correlationId,
        fixtureAuthorityRegistry,
      );
    },
    configPath,
    env: vaultEnv(),
    egress: () => undefined,
  });
  wiring = {
    custody: built.custody,
    httpPortFactory: fakeHttpPortFactory(),
    httpBodyPortFactory: fakeHttpBodyPortFactory(),
  };
  const listening = await buildServer(baseDeps(wiring));
  server = listening.server;
  port = listening.port;
});

afterEach(async () => {
  await closeServer();
  resetServerLogger();
  fixtureStore.close();
  await rm(staticRoot, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
});

describe("POST /api/atlassian-connectors/credentials", () => {
  it("creates a credential and answers authRef + metadata, never the secret", async () => {
    const res = await fetch(`${baseUrl()}/api/atlassian-connectors/credentials`, {
      method: "POST",
      headers: csrfHeaders(),
      body: createBody(),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expectNoSecretBytes(text);
    const metadata = JSON.parse(text) as AtlassianCredentialMetadata;
    expect(metadata.authRef.startsWith("atlassian-cred:")).toBe(true);
    expect(metadata.provider).toBe("jira");
    expect(metadata.displayName).toBe("Team Jira");
    expect(metadata.baseUrl).toBe("https://acme.example");
    expect(metadata.authScheme).toBe("basic-api-token");
    expect(Object.keys(metadata).sort()).toEqual([
      "authRef",
      "authScheme",
      "baseUrl",
      "createdAt",
      "displayName",
      "provider",
      "schemaVersion",
    ]);
  });

  it("persists no token or email plaintext anywhere in the custody directory", async () => {
    await createCredential();
    const credentialsDir = join(configDir, "credentials");
    const files = await readdir(credentialsDir);
    expect(files).toContain("atlassian-connector-credentials.vault");
    expect(files).toContain("atlassian-connector-credentials.metadata.json");
    for (const file of files) {
      const bytes = await readFile(join(credentialsDir, file), "utf8");
      expectNoSecretBytes(bytes);
    }
  });

  it("rejects invalid input with 400 and never echoes submitted values", async () => {
    const res = await fetch(`${baseUrl()}/api/atlassian-connectors/credentials`, {
      method: "POST",
      headers: csrfHeaders(),
      body: createBody({ baseUrl: `https://user:${SYNTHETIC_TOKEN}@acme.example` }),
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expectNoSecretBytes(text);
    expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects the declared-but-unimplemented bearer-pat scheme", async () => {
    const res = await fetch(`${baseUrl()}/api/atlassian-connectors/credentials`, {
      method: "POST",
      headers: csrfHeaders(),
      body: createBody({ authScheme: "bearer-pat" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AUTH_SCHEME_UNSUPPORTED");
  });

  it("rejects a non-JSON body shape with 400", async () => {
    const res = await fetch(`${baseUrl()}/api/atlassian-connectors/credentials`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify(["not", "an", "object"]),
    });
    expect(res.status).toBe(400);
  });

  it("caps the request body at 413", async () => {
    const res = await fetch(`${baseUrl()}/api/atlassian-connectors/credentials`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ filler: "x".repeat(20_000) }),
    });
    expect(res.status).toBe(413);
  });

  it("rejects without the CSRF header and without JSON content type", async () => {
    const noCsrf = await fetch(`${baseUrl()}/api/atlassian-connectors/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: createBody(),
    });
    expect(noCsrf.status).toBe(403);
    const noJson = await fetch(`${baseUrl()}/api/atlassian-connectors/credentials`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Keiko-CSRF": "1" },
      body: createBody(),
    });
    expect(noJson.status).toBe(415);
  });

  // KEIKO-0826: the domain layer caps stored credentials at
  // ATLASSIAN_CREDENTIAL_CUSTODY_MAX_ENTRIES and throws credential-limit-exceeded once the cap is
  // reached. The BFF must surface that as 429 (Too Many Requests) with a typed error code, not
  // rethrow into the opaque-500 top-level catch — a 500 would misdiagnose a benign capacity
  // ceiling as a server fault. Uses a stub custody instead of filling 64 real vault entries.
  it("answers 429 CREDENTIAL_LIMIT_EXCEEDED when custody has hit the storage cap", async () => {
    const stubCustody: AtlassianCredentialCustody = {
      updateLivePod: (): never => {
        throw new Error("Unexpected Live Pod update");
      },
      beginVerification: (): undefined => undefined,
      finishVerification: (): boolean => false,
      create: (): never => {
        throw new AtlassianCredentialCustodyError("credential-limit-exceeded");
      },
      getMetadata: (): undefined => undefined,
      list: (): readonly AtlassianCredentialMetadata[] => [],
      delete: (): boolean => false,
    };
    const stubHttpPort: AtlassianHttpPort = (): Promise<AtlassianHttpResult> =>
      Promise.resolve({ kind: "response", status: 200 });
    // The body-carrying port returns AtlassianHttpBodyResult, which extends the response shape
    // with bodyText/bodyBytes/truncated — the create() flow never reaches this stub (custody
    // rejects at the cap first), so the values are inert placeholders that keep the type honest.
    const stubHttpBodyPort: AtlassianHttpBodyPort = (): Promise<AtlassianHttpBodyResult> =>
      Promise.resolve({
        kind: "response",
        status: 200,
        bodyText: "",
        bodyBytes: 0,
        truncated: false,
      });
    // KEIKO-0826 follow-up: assert the typed 4xx also emits a body-free activity-log line so a
    // support bundle can reconstruct why the request was rejected. Codex flagged that the
    // original KEIKO-0826 fix mapped the code but did NOT log — the analyzer saw an opaque 429
    // indistinguishable from any other client-visible failure.
    const activityEvents: ServerLogEvent[] = [];
    const activityLog: ServerLogSink = {
      write: (event) => activityEvents.push(event),
    };
    await rebuild({
      custody: stubCustody,
      httpPortFactory: (): AtlassianHttpPort => stubHttpPort,
      httpBodyPortFactory: (): AtlassianHttpBodyPort => stubHttpBodyPort,
      activityLog,
    });
    const res = await fetch(`${baseUrl()}/api/atlassian-connectors/credentials`, {
      method: "POST",
      headers: csrfHeaders(),
      body: createBody(),
    });
    expect(res.status).toBe(429);
    const text = await res.text();
    expectNoSecretBytes(text);
    const body = JSON.parse(text) as { error: { code: string } };
    expect(body.error.code).toBe("CREDENTIAL_LIMIT_EXCEEDED");
    // Activity log emits a closed envelope kind plus governed reason and status; body-free.
    const rejection = activityEvents.find((e) => e.op === "atlassian.credential.rejected");
    expect(rejection).toBeDefined();
    expect(rejection?.category).toBe("security");
    expect(rejection?.errorKind).toBe("rate-limited");
    expect(rejection?.status).toBe(429);
    expect(rejection?.extra).toEqual({
      completeness: "complete",
      loss: "none",
      reason: "credential-limit-exceeded",
    });
    // Nothing about the request body — mirror the response-body no-secret check on the sink.
    expectNoSecretBytes(JSON.stringify(activityEvents));
  });

  // Registry-linked executable proof (#3532): the SAME body-free rejection event above, read back
  // through the real formatter/registry path rather than only asserted field-by-field, so the
  // `atlassian.credential.rejected.reason` proof id resolves against a production-computed event —
  // never a hand-built one (this task's rule 1).
  it.each([
    { code: "credential-limit-exceeded", status: 429, errorKind: "rate-limited" },
    { code: "creation-conflict", status: 409, errorKind: "validation-failed" },
    { code: "credential-changed", status: 409, errorKind: "validation-failed" },
  ] as const)("persists the registered credential rejection: $code", async (failure) => {
    const stubCustody: AtlassianCredentialCustody = {
      updateLivePod: (): never => {
        throw new Error("Unexpected Live Pod update");
      },
      beginVerification: (): undefined => undefined,
      finishVerification: (): boolean => false,
      create: (): never => {
        throw new AtlassianCredentialCustodyError(failure.code);
      },
      getMetadata: (): undefined => undefined,
      list: (): readonly AtlassianCredentialMetadata[] => [],
      delete: (): boolean => false,
    };
    const stubHttpPort: AtlassianHttpPort = (): Promise<AtlassianHttpResult> =>
      Promise.resolve({ kind: "response", status: 200 });
    const stubHttpBodyPort: AtlassianHttpBodyPort = (): Promise<AtlassianHttpBodyResult> =>
      Promise.resolve({
        kind: "response",
        status: 200,
        bodyText: "",
        bodyBytes: 0,
        truncated: false,
      });
    const activityEvents: ServerLogEvent[] = [];
    const activityLog: ServerLogSink = {
      write: (event) => activityEvents.push(event),
    };
    await rebuild({
      custody: stubCustody,
      httpPortFactory: (): AtlassianHttpPort => stubHttpPort,
      httpBodyPortFactory: (): AtlassianHttpBodyPort => stubHttpBodyPort,
      activityLog,
    });

    const res = await fetch(`${baseUrl()}/api/atlassian-connectors/credentials`, {
      method: "POST",
      headers: csrfHeaders(),
      body: createBody(),
    });
    expect(res.status).toBe(failure.status);

    const rejection = activityEvents.find((e) => e.op === "atlassian.credential.rejected");
    if (rejection === undefined) throw new Error("expected a rejection event");
    const line = formatActivityLogProofLine(rejection);
    const persisted = expectActivityLogProof("atlassian.credential.rejected.reason", line);
    expect(persisted).toMatchObject({
      category: "security",
      errorKind: failure.errorKind,
      status: failure.status,
      reason: failure.code,
    });
  });

  it("answers 503 when custody is not configured", async () => {
    await rebuild(undefined);
    const res = await fetch(`${baseUrl()}/api/atlassian-connectors/credentials`, {
      method: "POST",
      headers: csrfHeaders(),
      body: createBody(),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ATLASSIAN_CONNECTORS_UNAVAILABLE");
  });
});

describe("Atlassian credential route in-memory failure handling", () => {
  it("preserves the typed 429 when activity logging fails", async (): Promise<void> => {
    const custody: AtlassianCredentialCustody = {
      updateLivePod: (): never => {
        throw new Error("Unexpected Live Pod update");
      },
      beginVerification: (): undefined => undefined,
      finishVerification: (): boolean => false,
      create: (): never => {
        throw new AtlassianCredentialCustodyError("credential-limit-exceeded");
      },
      getMetadata: (): undefined => undefined,
      list: (): readonly AtlassianCredentialMetadata[] => [],
      delete: (): boolean => false,
    };
    const diagnosticRecords: ServerDiagnosticRecord[] = [];
    const connectorDeps: AtlassianConnectorCredentialDeps = {
      custody,
      httpPortFactory: (): AtlassianHttpPort => () =>
        Promise.resolve({ kind: "response", status: 200 }),
      httpBodyPortFactory: (): AtlassianHttpBodyPort => () =>
        Promise.resolve({
          kind: "response",
          status: 200,
          bodyText: "",
          bodyBytes: 0,
          truncated: false,
        }),
      activityLog: {
        write: (): never => {
          throw new Error("activity sink unavailable");
        },
      },
      diagnostics: {
        record: (record): void => {
          diagnosticRecords.push(record);
        },
      },
    };
    const result = await handleCreateAtlassianConnectorCredential(
      inMemoryCreateContext(),
      baseDeps(connectorDeps),
    );
    expect(result).toMatchObject({
      status: 429,
      body: { error: { code: "CREDENTIAL_LIMIT_EXCEEDED" } },
    });
    expect(diagnosticRecords).toMatchObject([
      {
        operation: "atlassian.credential.rejected",
        message: "atlassian-credential-rejection-activity-log-failed",
      },
    ]);
    expectNoSecretBytes(JSON.stringify({ result, diagnosticRecords }));
  });
});

describe("GET /api/atlassian-connectors/credentials", () => {
  it("lists metadata only", async () => {
    const created = await createCredential();
    const res = await fetch(`${baseUrl()}/api/atlassian-connectors/credentials`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expectNoSecretBytes(text);
    const body = JSON.parse(text) as { credentials: AtlassianCredentialMetadata[] };
    expect(body.credentials).toHaveLength(1);
    expect(body.credentials[0]?.authRef).toBe(created.authRef);
  });
});

describe("DELETE /api/atlassian-connectors/credentials/:authRef", () => {
  it("removes ciphertext and metadata and invalidates the authRef", async () => {
    const created = await createCredential();
    const res = await fetch(
      `${baseUrl()}/api/atlassian-connectors/credentials/${encodeURIComponent(created.authRef)}`,
      { method: "DELETE", headers: csrfHeaders() },
    );
    expect(res.status).toBe(200);
    const list = (await (
      await fetch(`${baseUrl()}/api/atlassian-connectors/credentials`)
    ).json()) as { credentials: unknown[] };
    expect(list.credentials).toHaveLength(0);
    // Verify against the deleted ref fails closed with a content-free 404.
    const verify = await fetch(
      `${baseUrl()}/api/atlassian-connectors/credentials/${encodeURIComponent(created.authRef)}/verify`,
      { method: "POST", headers: csrfHeaders(), body: "{}" },
    );
    expect(verify.status).toBe(404);
    expectNoSecretBytes(await verify.text());
    // Second delete: the ref no longer resolves.
    const again = await fetch(
      `${baseUrl()}/api/atlassian-connectors/credentials/${encodeURIComponent(created.authRef)}`,
      { method: "DELETE", headers: csrfHeaders() },
    );
    expect(again.status).toBe(404);
  });

  it("answers 404 for malformed and unknown refs (no oracle)", async () => {
    const malformed = await fetch(`${baseUrl()}/api/atlassian-connectors/credentials/not-a-ref`, {
      method: "DELETE",
      headers: csrfHeaders(),
    });
    expect(malformed.status).toBe(404);
    const unknown = await fetch(
      `${baseUrl()}/api/atlassian-connectors/credentials/${encodeURIComponent(
        `atlassian-cred:${"D".repeat(22)}`,
      )}`,
      { method: "DELETE", headers: csrfHeaders() },
    );
    expect(unknown.status).toBe(404);
  });
});

describe("POST /api/atlassian-connectors/credentials/:authRef/verify", () => {
  it.each([
    [{ kind: "response", status: 200 } satisfies AtlassianHttpResult, "ok"],
    [{ kind: "response", status: 401 } satisfies AtlassianHttpResult, "auth-failed"],
    [{ kind: "response", status: 403 } satisfies AtlassianHttpResult, "forbidden"],
    [{ kind: "response", status: 302 } satisfies AtlassianHttpResult, "redirect-refused"],
    [{ kind: "timeout" } satisfies AtlassianHttpResult, "timeout"],
    [{ kind: "network-error" } satisfies AtlassianHttpResult, "unreachable"],
  ])("maps the transport outcome %o to %s", async (portResult, expected) => {
    const created = await createCredential();
    fakePortResult = portResult;
    const res = await fetch(
      `${baseUrl()}/api/atlassian-connectors/credentials/${encodeURIComponent(created.authRef)}/verify`,
      { method: "POST", headers: csrfHeaders(), body: "{}" },
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expectNoSecretBytes(text);
    const body = JSON.parse(text) as { authRef: string; status: string };
    expect(body).toEqual({ authRef: created.authRef, status: expected });
  });

  it("contacts ONLY the configured base URL, exactly once, with the D3 timeout", async () => {
    const created = await createCredential();
    await fetch(
      `${baseUrl()}/api/atlassian-connectors/credentials/${encodeURIComponent(created.authRef)}/verify`,
      { method: "POST", headers: csrfHeaders(), body: "{}" },
    );
    expect(fakePortRequests).toHaveLength(1);
    expect(fakePortRequests[0]?.url).toBe("https://acme.example/rest/api/3/myself");
    expect(fakePortRequests[0]?.timeoutMs).toBe(30_000);
  });

  it("answers 404 for malformed and unknown refs without contacting the port", async () => {
    const malformed = await fetch(`${baseUrl()}/api/atlassian-connectors/credentials/junk/verify`, {
      method: "POST",
      headers: csrfHeaders(),
      body: "{}",
    });
    expect(malformed.status).toBe(404);
    expect(fakePortRequests).toHaveLength(0);
  });
});

describe("redaction under failure", () => {
  it("answers an opaque, correlation-keyed 500 on a vault failure and never leaks the token", async () => {
    const failing = createAtlassianCredentialCustody({
      vault: {
        get: (): string | undefined => undefined,
        set: (): void => {
          throw new Error("vault store corrupted");
        },
        delete: (): void => undefined,
      },
      metadataStore: {
        insert: (): void => undefined,
        get: (): undefined => undefined,
        list: (): readonly AtlassianCredentialMetadata[] => [],
        delete: (): boolean => false,
      },
    });
    await rebuild({
      custody: failing.custody,
      httpPortFactory: fakeHttpPortFactory(),
      httpBodyPortFactory: wiring.httpBodyPortFactory,
    });
    const res = await fetch(`${baseUrl()}/api/atlassian-connectors/credentials`, {
      method: "POST",
      headers: csrfHeaders(),
      body: createBody(),
    });
    expect(res.status).toBe(500);
    const text = await res.text();
    expectNoSecretBytes(text);
    const body = JSON.parse(text) as { error: { code: string; correlationId?: string } };
    expect(body.error.code).toBe("INTERNAL");
    expect(typeof body.error.correlationId).toBe("string");
    expect(res.headers.get("x-keiko-correlation-id")).toBe(body.error.correlationId);
    // The operator diagnostic is correlation-keyed and carries no secret bytes.
    const record = diagnostics.find((entry) => entry.correlationId === body.error.correlationId);
    expect(record).toBeDefined();
    expect(record?.source).toBe("server.top-level-catch");
    expectNoSecretBytes(JSON.stringify(diagnostics));
  });

  it("fails closed (opaque 500, diagnostic, no secret bytes) when the metadata store is corrupted", async () => {
    await createCredential();
    await writeFile(atlassianCredentialMetadataPath(configPath), "{corrupted", "utf8");
    const res = await fetch(`${baseUrl()}/api/atlassian-connectors/credentials`);
    expect(res.status).toBe(500);
    const text = await res.text();
    expectNoSecretBytes(text);
    expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe("INTERNAL");
    expect(diagnostics.length).toBeGreaterThan(0);
    expectNoSecretBytes(JSON.stringify(diagnostics));
  });
});

describe("end-to-end verify through the gateway transport adapter", () => {
  it("retains successful verification and revokes the generation after a failed recheck", async () => {
    const created = wiring.custody.create(
      livePodCreateInput(),
      jiraChatActorDigest(baseDeps(wiring)),
    );
    let status = 200;
    await rebuild({
      ...wiring,
      httpBodyPortFactory:
        () =>
        (request): Promise<AtlassianHttpBodyResult> =>
          Promise.resolve(jiraProbeResponse(request, status)),
    });
    expect((await verifyCredentialRequest(created.authRef)).status).toBe(200);
    expect(wiring.custody.getMetadata(created.authRef)).toMatchObject({
      generation: 1,
      livePod: { verificationStatus: "ok", verificationInProgress: false },
    });
    status = 401;
    expect(await (await verifyCredentialRequest(created.authRef)).json()).toMatchObject({
      status: "auth-failed",
    });
    expect(wiring.custody.getMetadata(created.authRef)).toMatchObject({
      generation: 2,
      livePod: { verificationStatus: "auth-failed", verificationInProgress: false },
    });
  });

  it.each([200, 401])(
    "rejects a late probe after the newer verification returned %s",
    async (newerStatus) => {
      const created = wiring.custody.create(
        livePodCreateInput(),
        jiraChatActorDigest(baseDeps(wiring)),
      );
      const entered = probeSignal();
      const release = probeSignal();
      let attempt = 0;
      const sink = createFileServerLogSink(configDir, { level: "debug" });
      await rebuild({
        ...wiring,
        activityLog: sink,
        httpBodyPortFactory: () => {
          const currentAttempt = ++attempt;
          return async (request): Promise<AtlassianHttpBodyResult> => {
            if (currentAttempt === 1 && request.url.endsWith("/serverInfo")) {
              entered.resolve();
              await release.promise;
            }
            return jiraProbeResponse(
              request,
              currentAttempt === 1 ? (newerStatus === 200 ? 401 : 200) : newerStatus,
            );
          };
        },
      });
      const earlier = verifyCredentialRequest(created.authRef);
      await entered.promise;
      expect((await verifyCredentialRequest(created.authRef)).status).toBe(200);
      release.resolve();
      expect((await earlier).status).toBe(409);
      expect(readVerificationEvidence(sink).map((entry) => entry.verificationState)).toEqual([
        "applied",
        "stale",
      ]);
      expect(wiring.custody.getMetadata(created.authRef)).toMatchObject({
        generation: newerStatus === 200 ? 1 : 2,
        livePod: {
          verificationStatus: newerStatus === 200 ? "ok" : "auth-failed",
          verificationRevision: 2,
          verificationInProgress: false,
        },
      });
    },
  );

  it("cannot complete a verification after the credential deletion route removed its Pod", async () => {
    const created = wiring.custody.create(
      livePodCreateInput(),
      jiraChatActorDigest(baseDeps(wiring)),
    );
    const entered = probeSignal();
    const release = probeSignal();
    await rebuild({
      ...wiring,
      httpBodyPortFactory:
        () =>
        async (request): Promise<AtlassianHttpBodyResult> => {
          entered.resolve();
          await release.promise;
          return jiraProbeResponse(request);
        },
    });
    const pending = verifyCredentialRequest(created.authRef);
    await entered.promise;
    const deleted = await fetch(
      `${baseUrl()}/api/atlassian-connectors/credentials/${encodeURIComponent(created.authRef)}`,
      { method: "DELETE", headers: csrfHeaders() },
    );
    expect(deleted.status).toBe(200);
    release.resolve();
    expect((await pending).status).toBe(409);
    expect(wiring.custody.getMetadata(created.authRef)).toBeUndefined();
  });

  it("retires an interrupted probe without falsely retaining readiness", async () => {
    const created = wiring.custody.create(
      livePodCreateInput(),
      jiraChatActorDigest(baseDeps(wiring)),
    );
    const sink = createFileServerLogSink(configDir, { level: "debug" });
    await rebuild({
      ...wiring,
      activityLog: sink,
      httpBodyPortFactory: () => (): Promise<AtlassianHttpBodyResult> =>
        Promise.reject(new TypeError("Synthetic probe failure")),
    });
    expect((await verifyCredentialRequest(created.authRef)).status).toBe(500);
    expect(readVerificationEvidence(sink)).toMatchObject([
      { verificationState: "applied", outcome: "verification-aborted" },
    ]);
    expect(wiring.custody.getMetadata(created.authRef)).toMatchObject({
      generation: 2,
      livePod: { verificationStatus: "unverified", verificationInProgress: false },
    });
  });
  it("projects existing credential GET without private Pod ownership or creation facts", async () => {
    const sink = createFileServerLogSink(configDir, { level: "debug" });
    await rebuild({ ...wiring, activityLog: sink });
    const owner = jiraChatActorDigest(baseDeps(wiring));
    const created = wiring.custody.create(livePodCreateInput(), owner);
    expect(created).toHaveProperty("livePod");
    const response = await fetch(`${baseUrl()}/api/atlassian-connectors/credentials`);
    const body = (await response.json()) as { credentials: readonly Record<string, unknown>[] };
    expect(response.status).toBe(200);
    expect(body.credentials).toHaveLength(1);
    expect(body.credentials[0]).not.toHaveProperty("livePod");
    expect(JSON.stringify(body)).not.toMatch(/ownerDigest|creationRequestId|verificationRevision/);
    sink.close?.();
    const lines = persistedActivityLogLines(
      readPersistedActivityLog(configDir),
      "atlassian.credential.listed",
    );
    expect(lines).toHaveLength(1);
    for (const line of lines)
      expect(expectActivityLogProof("atlassian.credential.listed.line", line)).toMatchObject({
        visibleCount: 1,
      });
  });

  it("creates through the authenticated route with a server owner and public response only", async () => {
    const response = await fetch(`${baseUrl()}/api/atlassian-connectors/credentials`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify(livePodCreateInput()),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { authRef: string };
    expect(body).not.toHaveProperty("livePod");
    expect(wiring.custody.getMetadata(body.authRef)).toMatchObject({
      livePod: {
        ownerDigest: jiraChatActorDigest(baseDeps(wiring)),
        verificationStatus: "unverified",
      },
    });
  });

  it("hides another operator's Pod from list, verify and delete without HTTP dispatch", async () => {
    const owner = jiraChatActorDigest(baseDeps(wiring));
    const created = wiring.custody.create(livePodCreateInput(), owner);
    activePrincipal = "another-operator";
    const list = await fetch(`${baseUrl()}/api/atlassian-connectors/credentials`);
    expect(await list.json()).toEqual({ credentials: [] });
    for (const [method, suffix] of [
      ["POST", "/verify"],
      ["DELETE", ""],
    ] as const) {
      const result = await fetch(
        `${baseUrl()}/api/atlassian-connectors/credentials/${encodeURIComponent(created.authRef)}${suffix}`,
        { method, headers: csrfHeaders(), body: "{}" },
      );
      expect(result.status).toBe(404);
    }
    expect(fakePortRequests).toHaveLength(0);
    expect(wiring.custody.getMetadata(created.authRef)).toBeDefined();
  });
  it("pins the selected generation in both HTTP factories before credential materialization", async () => {
    let calls = 0;
    const realWiring = buildAtlassianConnectorCredentialDeps({
      configPath,
      env: vaultEnv(),
      egress: () => undefined,
      fetchImpl: (): Promise<Response> => {
        calls++;
        return Promise.resolve(new Response("{}"));
      },
    });
    const metadata = realWiring.custody.create({
      provider: "jira",
      displayName: "Synthetic Jira",
      baseUrl: "https://acme.example",
      authScheme: "basic-api-token",
      accountEmail: SYNTHETIC_EMAIL,
      apiToken: SYNTHETIC_TOKEN,
    });
    const port = realWiring.httpPortFactory(metadata);
    const bodyPort = realWiring.httpBodyPortFactory(metadata);
    createAtlassianCredentialMetadataStore({ configPath }).insert({ ...metadata, generation: 2 });
    Object.assign(metadata, { generation: 2 });
    const request = {
      method: "GET",
      url: "https://acme.example/rest/api/3/myself",
      timeoutMs: 1_000,
      maxBodyBytes: 4096,
    } as const;
    await expect(port(request)).rejects.toMatchObject({ code: "credential-changed" });
    await expect(bodyPort(request)).rejects.toMatchObject({ code: "credential-changed" });
    expect(calls).toBe(0);
  });
  it("resolves the stored credential into Basic auth and contacts the configured host only", async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seen.push({
        url:
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Promise.resolve(Response.json({ accountId: "synthetic-id", active: true }));
    }) as typeof fetch;
    const realWiring = buildAtlassianConnectorCredentialDeps({
      configPath,
      env: vaultEnv(),
      egress: () => undefined,
      fetchImpl,
    });
    await rebuild(realWiring);
    const created = await createCredential();
    const res = await fetch(
      `${baseUrl()}/api/atlassian-connectors/credentials/${encodeURIComponent(created.authRef)}/verify`,
      { method: "POST", headers: csrfHeaders(), body: "{}" },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("ok");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://acme.example/rest/api/3/myself");
    const expectedBasic = `Basic ${Buffer.from(`${SYNTHETIC_EMAIL}:${SYNTHETIC_TOKEN}`, "utf8").toString("base64")}`;
    expect(seen[0]?.authorization).toBe(expectedBasic);
  });
});

async function readyJiraPod(): Promise<string> {
  await rebuild({
    ...wiring,
    httpBodyPortFactory:
      () =>
      (request): Promise<AtlassianHttpBodyResult> =>
        Promise.resolve(jiraProbeResponse(request)),
  });
  const created = wiring.custody.create(
    { ...livePodCreateInput(), livePodCreationRequestId: randomUUID() },
    jiraChatActorDigest(baseDeps(wiring)),
  );
  expect((await verifyCredentialRequest(created.authRef)).status).toBe(200);
  if (created.deployment !== "data-center" || created.livePod === undefined)
    throw new Error("Expected synthetic Live Pod");
  return created.livePod.podId;
}

function patchJiraChat(
  chat: Chat,
  patch: Record<string, unknown>,
  includePrecondition = true,
): Promise<Response> {
  return fetch(`${baseUrl()}/api/chats?id=${encodeURIComponent(chat.id)}`, {
    method: "PATCH",
    headers: csrfHeaders(),
    body: JSON.stringify({
      ...patch,
      ...(includePrecondition
        ? { expectedGroundingScopeIdentity: chat.groundingScopeIdentity }
        : {}),
    }),
  });
}

function jiraChat(): Chat {
  fixtureStore.createProject(configDir);
  return fixtureStore.createChat(configDir, "Jira Chat", "model");
}

async function updatedJiraChat(chat: Chat, patch: Record<string, unknown>): Promise<Chat> {
  const response = await patchJiraChat(chat, patch);
  expect(response.status).toBe(200);
  return ((await response.json()) as { chat: Chat }).chat;
}

function retainedChatAuthority(chat: Chat): () => ChatToolAuthorityResolution {
  const binding = chat.jiraPodBinding;
  const actorDigest = jiraChatActorDigest(baseDeps(wiring));
  if (binding === undefined || actorDigest === undefined)
    throw new Error("Expected an owned Chat binding");
  const value = chatAuthorityFixture({
    runId: `authority-${chat.id}`,
    requestedMode: chat.toolMode ?? "governed-assist",
    subject: {
      actorDigest,
      chatId: chat.id,
      podId: binding.podId,
      bindingGeneration: binding.bindingGeneration,
      authenticationGeneration: binding.authenticationGeneration,
    },
  });
  const registered = fixtureAuthorityRegistry.registerChat(
    value,
    "autonomous-delivery",
    CHAT_AUTHORITY_TEST_NOW,
  );
  if (!registered.ok) throw new Error("Expected retained Chat authority");
  return () =>
    fixtureAuthorityRegistry.resolveChat(
      registered.authorityRef,
      value.subject,
      "autonomous-delivery",
      CHAT_AUTHORITY_TEST_NOW,
    );
}

describe("normal Chat Jira binding through authenticated PATCH", () => {
  it("revokes authority only after committed mode, binding or closed-state changes", async () => {
    const podId = await readyJiraPod();
    const bound = await updatedJiraChat(jiraChat(), { jiraPodId: podId });
    const firstAuthority = retainedChatAuthority(bound);
    const noOp = await updatedJiraChat(bound, { toolMode: "governed-assist" });
    expect(firstAuthority().ok).toBe(true);
    const changed = await updatedJiraChat(noOp, { toolMode: "autonomous-delivery" });
    expect(firstAuthority()).toEqual({ ok: false, reason: "revoked" });
    const changedAuthority = retainedChatAuthority(changed);
    expect((await patchJiraChat(bound, { jiraPodId: null })).status).toBe(409);
    expect(changedAuthority().ok).toBe(true);
    const disconnected = await updatedJiraChat(changed, { jiraPodId: null });
    expect(changedAuthority()).toEqual({ ok: false, reason: "revoked" });
    const reconnected = await updatedJiraChat(disconnected, { jiraPodId: podId });
    const reconnectedAuthority = retainedChatAuthority(reconnected);
    await updatedJiraChat(reconnected, { status: "closed" });
    expect(reconnectedAuthority()).toEqual({ ok: false, reason: "revoked" });
  });

  it("direct credential deletion revokes both shared-Pod Chats but leaves another Pod authority live", async () => {
    const podId = await readyJiraPod();
    const otherPodId = await readyJiraPod();
    const chats = await Promise.all(
      [podId, podId, otherPodId].map(async (jiraPodId) =>
        updatedJiraChat(jiraChat(), { jiraPodId }),
      ),
    );
    const authorities = chats.map(retainedChatAuthority);
    const credential = wiring.custody
      .list()
      .find((row) => row.deployment === "data-center" && row.livePod?.podId === podId);
    if (credential === undefined) throw new Error("Expected credential");
    const response = await fetch(
      `${baseUrl()}/api/atlassian-connectors/credentials/${encodeURIComponent(credential.authRef)}`,
      { method: "DELETE", headers: csrfHeaders() },
    );
    expect(response.status).toBe(200);
    expect(authorities.map((resolve) => resolve().ok)).toEqual([false, false, true]);
  });

  it("direct credential deletion disconnects matching Chats and cancels only their active turns", async () => {
    const podId = await readyJiraPod();
    const otherPodId = await readyJiraPod();
    const first = await updatedJiraChat(jiraChat(), { jiraPodId: podId });
    const second = await updatedJiraChat(jiraChat(), { jiraPodId: podId });
    const other = await updatedJiraChat(jiraChat(), { jiraPodId: otherPodId });
    const credential = wiring.custody
      .list()
      .find((row) => row.deployment === "data-center" && row.livePod?.podId === podId);
    if (credential === undefined) throw new Error("Expected synthetic credential");
    const controllers = [
      new AbortController(),
      new AbortController(),
      new AbortController(),
      new AbortController(),
    ];
    const started: number[] = [];
    let release!: () => void;
    const work = new Promise<void>((resolve) => {
      release = resolve;
    });
    const turns = [first, second, other, first].map((chat, index) => {
      const controller = controllers[index];
      if (controller === undefined) throw new Error("Expected turn controller");
      return runSerializedChatTurn(
        { store: fixtureStore },
        chat.id,
        controller.signal,
        () => {
          started.push(index);
          return work;
        },
        controller,
      );
    });
    let requestCorrelation: string | null = null;
    const sink = createFileServerLogSink(configDir, { level: "debug" });
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    try {
      const response = await fetch(
        `${baseUrl()}/api/atlassian-connectors/credentials/${credential.authRef}`,
        {
          method: "DELETE",
          headers: csrfHeaders(),
        },
      );
      requestCorrelation = response.headers.get("x-keiko-correlation-id");
      expect(response.status).toBe(200);
      expect(controllers.map((controller) => controller.signal.aborted)).toEqual([
        true,
        true,
        false,
        true,
      ]);
      for (const chat of [first, second]) {
        expect(fixtureStore.findChatById(chat.id)?.jiraPodBinding).toBeUndefined();
        expect(fixtureStore.findChatById(chat.id)?.jiraBindingGeneration).toBe(2);
      }
      expect(fixtureStore.findChatById(other.id)).toEqual(other);
    } finally {
      release();
      await Promise.all(turns);
      sink.close?.();
      resetServerLogger();
    }
    expect(started).toEqual([0, 1, 2]);
    const lines = persistedActivityLogLines(
      readPersistedActivityLog(configDir),
      "chat.scope.update",
    );
    const events = lines.map((line) => expectActivityLogProof("chat.scope.update.outcome", line));
    expect(requestCorrelation).not.toBeNull();
    expect(events.every((event) => event.correlationId === requestCorrelation)).toBe(true);
    expect(events.map((event) => event.outcome)).toEqual([
      "applied",
      "applied",
      "cancellation-requested",
      "cancellation-requested",
    ]);
    expect(lines.join("\n")).not.toContain(podId);
    expect(lines.join("\n")).not.toContain(credential.authRef);
  });

  it("a failed direct reverify revokes the old binding generation while retaining the Pod", async () => {
    const podId = await readyJiraPod();
    const bound = await updatedJiraChat(jiraChat(), { jiraPodId: podId });
    const credential = wiring.custody
      .list()
      .find((row) => row.deployment === "data-center" && row.livePod?.podId === podId);
    if (credential === undefined) throw new Error("Expected synthetic credential");
    fakePortResult = { kind: "response", status: 401 };
    await rebuild({ ...wiring, httpBodyPortFactory: fakeHttpBodyPortFactory() });
    const failed = await verifyCredentialRequest(credential.authRef);
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({ status: "auth-failed" });
    expect(fixtureStore.findChatById(bound.id)?.jiraPodBinding).toEqual({
      ...bound.jiraPodBinding,
      authenticationGeneration: 2,
      bindingGeneration: 2,
    });
    expect((await patchJiraChat(bound, { toolMode: "autonomous-delivery" })).status).toBe(409);
  });

  it("records each binding effect once and reconstructs denials and conflicts without private facts", async () => {
    const podId = await readyJiraPod();
    const initial = jiraChat();
    const sink = createFileServerLogSink(configDir, { level: "debug" });
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    try {
      const connected = await updatedJiraChat(initial, { jiraPodId: podId });
      expect((await patchJiraChat(connected, { toolMode: "invalid" })).status).toBe(400);
      activePrincipal = "another-operator";
      expect((await patchJiraChat(connected, { jiraPodId: podId })).status).toBe(400);
      expect((await patchJiraChat(initial, { toolMode: "supervised-coding" })).status).toBe(409);
    } finally {
      sink.close?.();
      resetServerLogger();
    }
    const lines = persistedActivityLogLines(
      readPersistedActivityLog(configDir),
      "chat.scope.update",
    );
    const events = lines.map((line) => expectActivityLogProof("chat.scope.update.outcome", line));
    expect(events.map((entry) => entry.outcome)).toEqual([
      "applied",
      "denied",
      "denied",
      "conflict",
    ]);
    expect(events.map((entry) => entry.status)).toEqual([200, 400, 400, 409]);
    expect(lines.join("\n")).not.toContain(podId);
    expectNoSecretBytes(lines.join("\n"));
  });
  it("persists one verified owned Pod, replacement, disconnection and the chosen mode", async () => {
    const first = await readyJiraPod();
    const second = await readyJiraPod();
    const initial = jiraChat();
    expect(initial.toolMode).toBe("governed-assist");
    const connected = await updatedJiraChat(initial, { jiraPodId: first });
    expect(connected.jiraPodBinding).toMatchObject({
      podId: first,
      authenticationGeneration: 1,
      bindingGeneration: 1,
    });
    expect(connected.groundingScopeIdentity).not.toBe(initial.groundingScopeIdentity);
    const replaced = await updatedJiraChat(connected, {
      jiraPodId: second,
      toolMode: "supervised-coding",
    });
    expect(replaced.jiraPodBinding).toMatchObject({ podId: second, bindingGeneration: 2 });
    expect(replaced.toolMode).toBe("supervised-coding");
    const disconnected = await updatedJiraChat(replaced, { jiraPodId: null });
    expect(disconnected.jiraPodBinding).toBeUndefined();
    expect(disconnected.jiraBindingGeneration).toBe(3);
    const full = await updatedJiraChat(disconnected, { toolMode: "autonomous-delivery" });
    expect(full.toolMode).toBe("autonomous-delivery");
    const list = await fetch(`${baseUrl()}/api/chats?projectPath=${encodeURIComponent(configDir)}`);
    expect(await list.json()).toMatchObject({
      chats: [{ id: initial.id, toolMode: "autonomous-delivery", jiraBindingGeneration: 4 }],
    });
  });

  it.each(["unverified", "foreign", "unknown"])(
    "rejects %s Pods without changing the Chat",
    async (state) => {
      const podId = state === "unknown" ? randomUUID() : await readyJiraPod();
      if (state === "foreign") activePrincipal = "another-operator";
      if (state === "unverified") {
        const current = wiring.custody
          .list()
          .find((item) => item.deployment === "data-center" && item.livePod?.podId === podId);
        if (current === undefined) throw new Error("Expected owned Pod");
        const ticket = wiring.custody.beginVerification(current.authRef);
        if (ticket === undefined) throw new Error("Expected verification ticket");
        wiring.custody.finishVerification(
          current.authRef,
          current.generation ?? 1,
          ticket.revision,
          "auth-failed",
        );
      }
      const chat = jiraChat();
      expect(
        (await patchJiraChat(chat, { jiraPodId: podId, title: "Must not apply" })).status,
      ).toBe(400);
      expect(fixtureStore.findChatById(chat.id)).toEqual(chat);
    },
  );

  it.each([
    { toolMode: "root" },
    { jiraPodId: "invalid" },
    { jiraPodBinding: {} },
    { jiraBindingGeneration: 99 },
  ])("rejects malformed or server-owned binding fields %j", async (patch) => {
    const chat = jiraChat();
    expect((await patchJiraChat(chat, patch)).status).toBe(400);
    expect(fixtureStore.findChatById(chat.id)).toEqual(chat);
  });

  it("requires a scope precondition for Jira or mode changes", async () => {
    const chat = jiraChat();
    expect((await patchJiraChat(chat, { toolMode: "autonomous-delivery" }, false)).status).toBe(
      400,
    );
    expect(fixtureStore.findChatById(chat.id)).toEqual(chat);
  });

  it("accepts only one competing binding update and leaves another Chat untouched", async () => {
    const first = await readyJiraPod();
    const second = await readyJiraPod();
    const chat = jiraChat();
    const other = fixtureStore.createChat(configDir, "Other Chat", "model");
    const responses = await Promise.all([
      patchJiraChat(chat, { jiraPodId: first, title: "First" }),
      patchJiraChat(chat, { jiraPodId: second, title: "Second" }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = responses[0].status === 200 ? first : second;
    expect(fixtureStore.findChatById(chat.id)?.jiraPodBinding?.podId).toBe(winner);
    expect(fixtureStore.findChatById(other.id)).toEqual(other);
  });
});

function updateJiraCredential(authRef: string, patch: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl()}/api/atlassian-connectors/credentials/${authRef}`, {
    method: "PATCH",
    headers: csrfHeaders(),
    body: JSON.stringify(patch),
  });
}

function credentialForPod(podId: string): AtlassianCredentialMetadata {
  const metadata = wiring.custody
    .list()
    .find((row) => row.deployment === "data-center" && row.livePod?.podId === podId);
  if (metadata === undefined) throw new Error("Expected synthetic credential");
  return metadata;
}

describe("authenticated Live Pod credential updates", () => {
  it("a delayed verification cannot restore readiness after the token replacement route", async () => {
    const credential = credentialForPod(await readyJiraPod());
    const entered = probeSignal();
    const release = probeSignal();
    await rebuild({
      ...wiring,
      httpBodyPortFactory:
        () =>
        async (request): Promise<AtlassianHttpBodyResult> => {
          entered.resolve();
          await release.promise;
          return jiraProbeResponse(request);
        },
    });
    const pending = verifyCredentialRequest(credential.authRef);
    await entered.promise;
    const changed = await updateJiraCredential(credential.authRef, {
      expectedGeneration: 1,
      apiToken: SYNTHETIC_TOKEN + "rotated",
    }).finally(release.resolve);
    const stale = await pending;
    expect(changed.status).toBe(200);
    expect(stale.status).toBe(409);
    expect(wiring.custody.getMetadata(credential.authRef)).toMatchObject({
      generation: 2,
      livePod: { verificationStatus: "unverified", verificationInProgress: false },
    });
  });

  it("applies the existing CSRF guard before token replacement", async () => {
    const credential = credentialForPod(await readyJiraPod());
    const response = await fetch(
      `${baseUrl()}/api/atlassian-connectors/credentials/${credential.authRef}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedGeneration: 1, apiToken: SYNTHETIC_TOKEN }),
      },
    );
    expect(response.status).toBe(403);
    expect(wiring.custody.getMetadata(credential.authRef)).toEqual(credential);
  });

  it("renames and replaces tokens without losing the Pod association or exposing private state", async () => {
    const podId = await readyJiraPod();
    const credential = credentialForPod(podId);
    const first = await updatedJiraChat(jiraChat(), { jiraPodId: podId });
    const second = await updatedJiraChat(jiraChat(), { jiraPodId: podId });
    const otherId = await readyJiraPod();
    const other = await updatedJiraChat(jiraChat(), { jiraPodId: otherId });
    const sink = createFileServerLogSink(configDir, { level: "debug" });
    await rebuild({ ...wiring, activityLog: sink });
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const correlations: (string | null)[] = [];
    try {
      const renamed = await updateJiraCredential(credential.authRef, {
        expectedGeneration: 1,
        displayName: "Renamed Jira",
      });
      expect(renamed.status).toBe(200);
      correlations.push(renamed.headers.get("x-keiko-correlation-id"));
      expect(await renamed.json()).toMatchObject({ generation: 1, displayName: "Renamed Jira" });
      const replaced = await updateJiraCredential(credential.authRef, {
        expectedGeneration: 1,
        apiToken: SYNTHETIC_TOKEN + "new",
      });
      expect(replaced.status).toBe(200);
      correlations.push(replaced.headers.get("x-keiko-correlation-id"));
      const response = await replaced.text();
      expect(JSON.parse(response)).toMatchObject({ authRef: credential.authRef, generation: 2 });
      expect(response).not.toContain("livePod");
      expect(response).not.toContain(SYNTHETIC_TOKEN);
      const both = await updateJiraCredential(credential.authRef, {
        expectedGeneration: 2,
        displayName: "Renamed Again",
        apiToken: SYNTHETIC_TOKEN + "newer",
      });
      expect(both.status).toBe(200);
      correlations.push(both.headers.get("x-keiko-correlation-id"));
      expect(
        (
          await updateJiraCredential(credential.authRef, {
            expectedGeneration: 1,
            apiToken: SYNTHETIC_TOKEN,
          })
        ).status,
      ).toBe(409);
      for (const chat of [first, second])
        expect(fixtureStore.findChatById(chat.id)?.jiraPodBinding).toMatchObject({
          podId,
          authenticationGeneration: 3,
          bindingGeneration: 3,
        });
      expect(fixtureStore.findChatById(other.id)).toEqual(other);
      expect(wiring.custody.getMetadata(credential.authRef)).toMatchObject({
        generation: 3,
        livePod: { verificationStatus: "unverified" },
      });
    } finally {
      sink.close?.();
      resetServerLogger();
    }
    const lines = persistedActivityLogLines(
      readPersistedActivityLog(configDir),
      "atlassian.credential.updated",
    );
    const events = lines.map((line) =>
      expectActivityLogProof("atlassian.credential.updated.line", line),
    );
    expect(events.map((event) => event.action)).toEqual([
      "rename",
      "replace-token",
      "rename-and-replace-token",
    ]);
    expect(events.map((event) => event.authenticationGeneration)).toEqual([1, 2, 3]);
    expect(correlations.every((id) => id !== null)).toBe(true);
    expect(events.map((event) => event.correlationId)).toEqual(correlations);
    const scopes = persistedActivityLogLines(
      readPersistedActivityLog(configDir),
      "chat.scope.update",
    ).map((line) => expectActivityLogProof("chat.scope.update.outcome", line));
    expect(scopes.map((event) => event.correlationId)).toEqual([
      correlations[1],
      correlations[1],
      correlations[2],
      correlations[2],
    ]);
    expect(lines.join("\n")).not.toContain(credential.authRef);
    expect(lines.join("\n")).not.toContain(SYNTHETIC_TOKEN);
  });

  it("refuses foreign Pod updates and malformed bodies without changing custody", async () => {
    const credential = credentialForPod(await readyJiraPod());
    activePrincipal = "another-operator";
    expect(
      (
        await updateJiraCredential(credential.authRef, {
          expectedGeneration: 1,
          apiToken: SYNTHETIC_TOKEN,
        })
      ).status,
    ).toBe(404);
    activePrincipal = "synthetic-operator";
    for (const patch of [
      {},
      { expectedGeneration: 1, apiToken: "short" },
      { expectedGeneration: 1, baseUrl: "https://other.invalid" },
    ])
      expect((await updateJiraCredential(credential.authRef, patch)).status).toBe(400);
    expect(wiring.custody.getMetadata(credential.authRef)).toEqual(credential);
  });
});
