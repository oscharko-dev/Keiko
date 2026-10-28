import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { I18nProvider, loadLocaleMessages } from "./i18n.js";
import { loadOptionalWidgetMessages } from "./optional-widget-i18n.js";
import { AtlassianConnectorsPanel } from "../app/components/desktop/widgets/connectors/AtlassianConnectorsPanel.js";
import {
  expectRegisteredActivityLogLine,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

const syntheticToken = (): string => ["fixture", "jira", "token", "4082"].join("-");
let configDir: string;
let configPath: string;
let close: (() => Promise<void>) | undefined;
let events: ServerLogEvent[];
let responses: (Response | Error)[];
let outbound: { url: string; authorization: string | null }[];
let networkConfig: AtlassianNetworkConfig | undefined;
let listenerPort = 0;

function fixtureFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  outbound.push({
    url: input instanceof Request ? input.url : String(input),
    authorization: new Headers(init?.headers).get("authorization"),
  });
  const response = responses.shift();
  return response instanceof Error
    ? Promise.reject(response)
    : Promise.resolve(response ?? new Response("", { status: 503 }));
}

function dependencies(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    serverPrincipal: () => "synthetic-connector-owner",
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

function verifiedDataCenterResponses(): Response[] {
  return [
    Response.json({ version: "10.3.26", versionNumbers: [10, 3, 26], deploymentType: "Server" }),
    Response.json({ name: "fixture-user", key: "fixture-key", active: true }),
  ];
}

const privateProviderDetail = "synthetic-provider-private-detail";
const hubVerificationCases = [
  {
    status: "ok",
    en: "Connection verified",
    de: "Verbindung geprüft",
    replies: verifiedDataCenterResponses,
  },
  {
    status: "auth-failed",
    en: "Authentication failed",
    de: "Authentifizierung fehlgeschlagen",
    replies: (): Response[] => [new Response(privateProviderDetail, { status: 401 })],
  },
  {
    status: "forbidden",
    en: "Access forbidden",
    de: "Zugriff verweigert",
    replies: (): Response[] => [new Response(privateProviderDetail, { status: 403 })],
  },
  {
    status: "unreachable",
    en: "Site unreachable",
    de: "Website nicht erreichbar",
    replies: (): Error[] => [new TypeError(privateProviderDetail)],
  },
  {
    status: "timeout",
    en: "Connection timed out",
    de: "Zeitüberschreitung der Verbindung",
    replies: (): Error[] => [
      Object.assign(new Error(privateProviderDetail), { name: "AbortError" }),
    ],
  },
  {
    status: "redirect-refused",
    en: "Redirect refused",
    de: "Weiterleitung abgelehnt",
    replies: (): Response[] => [new Response(privateProviderDetail, { status: 302 })],
  },
  {
    status: "invalid-response",
    en: "Invalid Atlassian response",
    de: "Ungültige Atlassian-Antwort",
    replies: (): Response[] => [
      new Response(`<html>${privateProviderDetail}</html>`, {
        headers: { "content-type": "text/html" },
      }),
    ],
  },
  {
    status: "unsupported-version",
    en: "Unsupported Jira version",
    de: "Jira-Version nicht unterstützt",
    replies: (): Response[] => [
      Response.json({
        version: "9.12.0",
        versionNumbers: [9, 12, 0],
        deploymentType: "Server",
      }),
    ],
  },
  {
    status: "tls-failed",
    en: "Certificate verification failed",
    de: "Zertifikatsprüfung fehlgeschlagen",
    replies: (): Error[] => [
      new TypeError(privateProviderDetail, {
        cause: { code: "CERT_HAS_EXPIRED" },
      }),
    ],
  },
] as const;

async function mountedDataCenterHub(locale: "en" | "de"): Promise<{
  readonly metadata: Awaited<ReturnType<typeof createAtlassianConnector>>;
  readonly card: HTMLElement;
}> {
  const metadata = await createAtlassianConnector({
    provider: "jira",
    deployment: "data-center",
    authScheme: "bearer-pat",
    displayName: "Synthetic Data Center",
    baseUrl: "https://jira.example/context",
    apiToken: syntheticToken(),
    livePodCreationRequestId: randomUUID(),
  });
  await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
  window.localStorage.setItem("keiko.locale", locale);
  render(
    createElement(I18nProvider, {
      children: createElement(AtlassianConnectorsPanel, { jiraLive: true }),
    }),
  );
  return { metadata, card: await screen.findByTestId("acx-connector") };
}

describe.each(["en", "de"] as const)("Data Center verification in the real %s Hub", (locale) => {
  it.each(hubVerificationCases)(
    "carries $status through the client, route, custody and card",
    async (scenario) => {
      const { metadata, card } = await mountedDataCenterHub(locale);
      responses.push(...scenario.replies());
      await userEvent.click(
        within(card).getByRole("button", {
          name: locale === "en" ? "Verify connection" : "Verbindung prüfen",
        }),
      );
      const notice = await within(card).findByTestId("acx-verify-status");
      expect(notice).toHaveAttribute("data-status", scenario.status);
      expect(notice).toHaveTextContent(scenario[locale]);
      expect(within(card).getByRole("status")).toBe(notice);
      if (scenario.status === "auth-failed") expect(notice).not.toHaveTextContent(/e-?mail/iu);
      if (scenario.status === "forbidden") expect(notice).toHaveTextContent(/licen[cs]e|lizenz/iu);
      expect(card).not.toHaveTextContent(privateProviderDetail);
      expect(card).not.toHaveTextContent(syntheticToken());
      const stored = (await listAtlassianConnectors()).find(
        (item) => item.authRef === metadata.authRef,
      );
      assert(stored?.deployment === "data-center");
      expect(stored.livePod?.verificationStatus).toBe(scenario.status);
      expect(outbound).toHaveLength(scenario.status === "ok" ? 2 : 1);
      for (const request of outbound)
        expect(request.authorization).toBe(`Bearer ${syntheticToken()}`);
      const checked = events.filter((event) => event.op === "atlassian.connection.checked");
      const terminal = checked.at(-1);
      assert(terminal !== undefined);
      expect(
        expectRegisteredActivityLogLine(terminal.op, formatActivityLogProofLine(terminal)),
      ).toMatchObject({ outcome: scenario.status });
      expect(JSON.stringify(checked)).not.toContain(privateProviderDetail);
      expect(JSON.stringify(checked)).not.toContain(syntheticToken());
    },
  );
});

it("removes the Hub's verified state after a revoked PAT fails real re-verification", async () => {
  const { metadata, card } = await mountedDataCenterHub("en");
  responses.push(...verifiedDataCenterResponses());
  await userEvent.click(within(card).getByRole("button", { name: "Verify connection" }));
  expect(await within(card).findByTestId("acx-verify-status")).toHaveAttribute("data-status", "ok");
  const verified = (await listAtlassianConnectors()).find(
    (item) => item.authRef === metadata.authRef,
  );
  assert(verified?.deployment === "data-center");
  responses.push(new Response(privateProviderDetail, { status: 401 }));
  await userEvent.click(within(card).getByRole("button", { name: "Verify connection" }));
  await waitFor(() =>
    expect(within(card).getByTestId("acx-verify-status")).toHaveAttribute(
      "data-status",
      "auth-failed",
    ),
  );
  const revoked = (await listAtlassianConnectors()).find(
    (item) => item.authRef === metadata.authRef,
  );
  expect(revoked).toMatchObject({
    generation: verified.generation + 1,
    livePod: { podId: verified.livePod?.podId, verificationStatus: "auth-failed" },
  });
  expect(within(card).queryByText("Connection verified")).toBeNull();
  expect(outbound).toHaveLength(3);
});
