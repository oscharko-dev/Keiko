import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryUiStore, buildRedactor } from "../packages/keiko-server/src/index.js";
import type { UiHandlerDeps } from "../packages/keiko-server/src/deps.js";
import { createRunRegistry } from "../packages/keiko-server/src/runs.js";
import { createUiServer, UI_HOST } from "../packages/keiko-server/src/server.js";
import { buildAtlassianConnectorCredentialDeps } from "../packages/keiko-server/src/atlassian/wiring.js";
import { atlassianCredentialMetadataPath } from "../packages/keiko-server/src/atlassian/credentialMetadataStore.js";
import { atlassianCredentialStorePath } from "../packages/keiko-server/src/atlassian/credentialVault.js";
import {
  createAtlassianConnector,
  listAtlassianConnectors,
} from "../packages/keiko-ui/src/lib/atlassian-connectors-api.js";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import { responseCorrelationIdOf } from "../packages/keiko-ui/src/lib/bff-correlation.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "./support/activity-log-proof.js";

const syntheticToken = (): string => ["fixture", "jira", "token", "4082"].join("-");
let configDir: string;
let configPath: string;
let close: (() => Promise<void>) | undefined;
let events: ServerLogEvent[];

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
      activityLog: {
        write: (event): void => {
          events.push(event);
        },
      },
    }),
  };
}

beforeEach(async () => {
  events = [];
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
  const origin = `http://${UI_HOST}:${String(port)}`;
  const platformFetch = globalThis.fetch;
  // Browser-relative URL resolution only: the real client, HTTP server, route and vault execute.
  vi.stubGlobal(
    "fetch",
    (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> =>
      platformFetch(typeof input === "string" ? new URL(input, origin) : input, init),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await close?.();
  await rm(configDir, { recursive: true, force: true });
});

describe("Atlassian browser client through the real credential route (#4082)", () => {
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
    const proof = expectActivityLogProof(
      "atlassian.credential.created.line",
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
