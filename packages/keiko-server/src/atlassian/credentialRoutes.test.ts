// Issue #2241 — /api/atlassian-connectors/credentials/* route integration tests. The createUiServer
// fixture mirrors command-runner-routes.test.ts so the CSRF guard, JSON content-type gate,
// host-check, correlation-id plumbing, and top-level catch all run live. Custody is REAL (the
// keiko-security vault on the env-key tier plus the private metadata store, both in a fresh temp
// config dir) so the ciphertext-on-disk and write-only acceptance criteria are proven at the route
// boundary; only the outbound transport is faked. Secrets are synthetic, assembled at runtime.

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAtlassianCredentialCustody,
  type AtlassianCredentialMetadata,
  type AtlassianHttpPort,
  type AtlassianHttpRequest,
  type AtlassianHttpResult,
} from "@oscharko-dev/keiko-connectors";
import { buildCspHeader } from "../csp.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "../index.js";
import { createRunRegistry } from "../runs.js";
import { createUiServer, UI_HOST } from "../server.js";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import { atlassianCredentialMetadataPath } from "./credentialMetadataStore.js";
import { buildAtlassianConnectorCredentialDeps } from "./wiring.js";
import type { AtlassianConnectorCredentialDeps } from "./credentialRoutes.js";

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
let fakePortResult: AtlassianHttpResult;
let fakePortRequests: AtlassianHttpRequest[];

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

function baseDeps(atlassian: AtlassianConnectorCredentialDeps | undefined): UiHandlerDeps {
  return {
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
    store: createInMemoryUiStore(),
    ...(atlassian === undefined ? {} : { atlassianConnectorCredentials: atlassian }),
  };
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
    configPath,
    env: vaultEnv(),
    egress: () => undefined,
  });
  wiring = {
    custody: built.custody,
    httpPortFactory: fakeHttpPortFactory(),
    httpBodyPortFactory: built.httpBodyPortFactory,
  };
  const listening = await buildServer(baseDeps(wiring));
  server = listening.server;
  port = listening.port;
});

afterEach(async () => {
  await closeServer();
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
    [{ kind: "response", status: 302 } satisfies AtlassianHttpResult, "unreachable"],
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
  it("resolves the stored credential into Basic auth and contacts the configured host only", async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seen.push({
        url:
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Promise.resolve(new Response(null, { status: 200 }));
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
