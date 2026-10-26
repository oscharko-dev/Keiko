import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryUiStore, buildRedactor } from "../../../keiko-server/dist/index.js";
import type { UiHandlerDeps } from "../../../keiko-server/dist/deps.js";
import { createRunRegistry } from "../../../keiko-server/dist/runs.js";
import { createUiServer, UI_HOST } from "../../../keiko-server/dist/server.js";
import { buildAtlassianConnectorCredentialDeps } from "../../../keiko-server/dist/atlassian/wiring.js";
import { atlassianCredentialMetadataPath } from "../../../keiko-server/dist/atlassian/credentialMetadataStore.js";
import { atlassianCredentialStorePath } from "../../../keiko-server/dist/atlassian/credentialVault.js";
import {
  createAtlassianConnector,
  listAtlassianConnectors,
  verifyAtlassianConnector,
  startAtlassianConnectorSync,
} from "./atlassian-connectors-api.js";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import type { AtlassianNetworkConfig } from "@oscharko-dev/keiko-contracts";
import { responseCorrelationIdOf } from "./bff-correlation.js";
import {
  expectRegisteredActivityLogLine,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

const syntheticToken = (): string => ["fixture", "jira", "token", "4082"].join("-");
let configDir: string;
let configPath: string;
let close: (() => Promise<void>) | undefined;
let events: ServerLogEvent[];
let responses: Response[];
let outbound: { url: string; authorization: string | null }[];
let networkConfig: AtlassianNetworkConfig | undefined;
let listenerPort = 0;

function fixtureFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  outbound.push({
    url: input instanceof Request ? input.url : String(input),
    authorization: new Headers(init?.headers).get("authorization"),
  });
  return Promise.resolve(responses.shift() ?? new Response("", { status: 503 }));
}

function dependencies(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    atlassianConnectorCredentials: buildAtlassianConnectorCredentialDeps({
      configPath,
      env: { KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY: randomBytes(32).toString("base64") },
      egress: () => undefined,
      networkConfig: () => networkConfig,
      fetchImpl: fixtureFetch,
      activityLog: {
        write: (event): void => {
          events.push(event);
        },
      },
    }),
  };
}

beforeEach(async () => {
  networkConfig = undefined;
  events = [];
  responses = [];
  outbound = [];
  configDir = await mkdtemp(join(realpathSync(tmpdir()), "keiko-jira-client-"));
  configPath = join(configDir, "keiko.config.json");
  let port = 0;
  const server = createUiServer({
    staticRoot: configDir,
    csp: "default-src 'self'",
    get port() {
      return port;
    },
    handlerDeps: dependencies(),
  });
  close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  };
  await new Promise<void>((resolve) => server.listen(0, UI_HOST, resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new TypeError("Missing fixture listener");
  port = address.port;
  listenerPort = port;
  const origin = `http://${UI_HOST}:${String(port)}`;
  const platformFetch = globalThis.fetch;
  // Browser-relative URL resolution only: the real client, HTTP server, route and vault execute.
  vi.stubGlobal(
    "fetch",
    (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> =>
      platformFetch(typeof input === "string" ? new URL(input, origin) : input, init),
  );
});

it("refuses the actual BFF listener even if a loopback target is operator-admitted", async () => {
  const baseUrl = `https://127.0.0.1:${String(listenerPort)}/jira`;
  networkConfig = { privateTargets: [{ baseUrl, addressClass: "loopback" }] };
  const created = await createAtlassianConnector({
    provider: "jira",
    deployment: "data-center",
    authScheme: "bearer-pat",
    displayName: "Listener isolation",
    baseUrl,
    apiToken: syntheticToken(),
  });
  const verified = await verifyAtlassianConnector(created.authRef);
  expect(verified.status).toBe("unreachable");
  expect(outbound).toHaveLength(0);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await close?.();
  await rm(configDir, { recursive: true, force: true });
});

describe("Atlassian browser client through the real credential route (#4082)", () => {
  it.each(["jira", "confluence"] as const)(
    "rejects HTML-2xx through the real %s Cloud path",
    async (provider) => {
      const metadata = await createAtlassianConnector({
        provider,
        displayName: "Synthetic Cloud",
        baseUrl: "https://cloud.example",
        accountEmail: "fixture@example.test",
        apiToken: syntheticToken(),
      });
      responses.push(
        new Response("<html><form>Sign in</form></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      );
      expect(await verifyAtlassianConnector(metadata.authRef)).toMatchObject({
        status: "invalid-response",
      });
      expect(outbound).toHaveLength(1);
      const failed = events.filter((event) => event.op === "atlassian.connection.checked");
      expect(failed).toHaveLength(1);
      const event = failed[0];
      if (!event) throw new TypeError("Missing connection outcome");
      const line = formatActivityLogProofLine(event);
      expect(expectRegisteredActivityLogLine(event.op, line)).toMatchObject({
        outcome: "invalid-response",
      });
      expect(line).not.toContain("<html>");
      expect(line).not.toContain("cloud.example");
      expect(line).not.toContain(syntheticToken());
    },
  );

  it.each(["jira", "confluence"] as const)(
    "preserves valid JSON verification and Basic auth for %s Cloud",
    async (provider) => {
      const metadata = await createAtlassianConnector({
        provider,
        displayName: "Synthetic Cloud",
        baseUrl: "https://cloud.example",
        accountEmail: "fixture@example.test",
        apiToken: syntheticToken(),
      });
      responses.push(
        Response.json(
          provider === "jira"
            ? { accountId: "synthetic-id", active: true }
            : { accountId: "synthetic-id", type: "known" },
        ),
      );
      expect(await verifyAtlassianConnector(metadata.authRef)).toMatchObject({ status: "ok" });
      expect(outbound[0]?.url).toBe(
        provider === "jira"
          ? "https://cloud.example/rest/api/3/myself"
          : "https://cloud.example/wiki/rest/api/user/current",
      );
      expect(outbound[0]?.authorization).toBe(
        `Basic ${Buffer.from(`fixture@example.test:${syntheticToken()}`).toString("base64")}`,
      );
    },
  );

  it("creates a Data Center PAT credential without an account email", async () => {
    const metadata = await createAtlassianConnector({
      provider: "jira",
      deployment: "data-center",
      authScheme: "bearer-pat",
      displayName: "Synthetic Data Center",
      baseUrl: "https://jira.example/context",
      apiToken: syntheticToken(),
    });
    expect(metadata).toMatchObject({
      deployment: "data-center",
      authScheme: "bearer-pat",
      generation: 1,
    });
    expect(await listAtlassianConnectors()).toEqual([metadata]);
    expect(JSON.stringify(metadata)).not.toContain(syntheticToken());
    expect(await readFile(atlassianCredentialStorePath(configPath), "utf8")).not.toContain(
      syntheticToken(),
    );
    responses.push(
      Response.json({ version: "10.3.26", versionNumbers: [10, 3, 26], deploymentType: "Server" }),
      Response.json({ name: "fixture-user", key: "fixture-key", active: true }),
    );
    expect(await verifyAtlassianConnector(metadata.authRef)).toMatchObject({ status: "ok" });
    expect(outbound.map((request) => request.url)).toEqual([
      "https://jira.example/context/rest/api/2/serverInfo",
      "https://jira.example/context/rest/api/2/myself",
    ]);
    expect(
      outbound.every((request) => request.authorization === `Bearer ${syntheticToken()}`),
    ).toBe(true);
    await expect(
      startAtlassianConnectorSync(metadata.authRef, { projectKeys: ["FIXTURE"] }),
    ).rejects.toMatchObject({ code: "SYNC_UNSUPPORTED_DEPLOYMENT" });
    expect(outbound).toHaveLength(2);
    const checked = events.filter((event) => event.op === "atlassian.connection.checked");
    expect(checked).toHaveLength(2);
    expect(JSON.stringify(checked)).not.toContain(syntheticToken());
    expect(JSON.stringify(checked)).not.toContain("jira.example");
  });

  it("creates a Cloud credential with the form's actual request and keeps its secret private", async () => {
    const metadata = await createAtlassianConnector({
      provider: "jira",
      displayName: "Synthetic Cloud",
      baseUrl: "https://jira.example",
      accountEmail: "fixture@example.test",
      apiToken: syntheticToken(),
    });
    expect(metadata.authScheme).toBe("basic-api-token");
    expect(await listAtlassianConnectors()).toEqual([metadata]);
    const event = events.find((entry) => entry.op === "atlassian.credential.created");
    assert(event !== undefined);
    const proof = expectRegisteredActivityLogLine(
      "atlassian.credential.created",
      formatActivityLogProofLine(event),
    );
    expect(proof.correlationId).toBe(responseCorrelationIdOf(metadata));
    expect(proof.status).toBe(200);
    const persisted = await readFile(atlassianCredentialMetadataPath(configPath), "utf8");
    const vault = await readFile(atlassianCredentialStorePath(configPath), "utf8");
    for (const text of [JSON.stringify(metadata), persisted, vault, JSON.stringify(proof)]) {
      expect(text).not.toContain(syntheticToken());
      expect(text).not.toContain("fixture@example.test");
    }
  });
});
