// Issue #2246 Scope 1 — the token-redaction sweep.
//
// One entropy-shaped marker credential (built at runtime, never a committed literal) is driven
// through EVERY connector flow against the REAL keiko-server transport adapter (so the token is
// genuinely materialised into the outbound Authorization header — a non-vacuous sweep): custody
// CRUD, verify, sync happy + degraded, write actions allowed/denied/failed, live search, activity,
// approvals, plus error and persisted-state surfaces. Every produced artifact class is collected
// into a named bucket and scanned:
//
//   - the RAW marker (token, email) must appear in NO artifact class; and
//   - the base64-encoded credential must appear ONLY at the outbound network hop, never in an
//     artifact, while STILL being present at that hop (proving the credential was really used).
//
// The sweep enforces an allowlist-of-scanned-artifacts: if the flow run produces a bucket that is
// not enumerated, the build fails (future artifact classes cannot silently escape the sweep). A
// dedicated test proves that guard bites.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AtlassianCredentialMetadata } from "@oscharko-dev/keiko-connectors";
import type { CodingWorkbenchConnectorScope } from "@oscharko-dev/keiko-contracts";
import type { RouteContext } from "../../packages/keiko-server/src/routes.js";
import type { UiHandlerDeps } from "../../packages/keiko-server/src/deps.js";
import { buildAtlassianConnectorCredentialDeps } from "../../packages/keiko-server/src/atlassian/wiring.js";
import {
  handleCreateAtlassianConnectorCredential,
  handleDeleteAtlassianConnectorCredential,
  handleListAtlassianConnectorCredentials,
  handleVerifyAtlassianConnectorCredential,
} from "../../packages/keiko-server/src/atlassian/credentialRoutes.js";
import {
  handleGetAtlassianConnectorSyncJob,
  handleListAtlassianConnectorActivity,
  handleStartAtlassianConnectorSync,
} from "../../packages/keiko-server/src/atlassian/syncRoutes.js";
import {
  handleExecuteAtlassianConnectorAction,
  handleListAtlassianConnectorActionApprovals,
} from "../../packages/keiko-server/src/atlassian/writeActionRoutes.js";
import {
  CONNECTOR_BASE_URL,
  awaitJobTerminal,
  buildRedactionMarker,
  createConnectorServerHarness,
  registerConnectorEnvelope,
  resetConnectorRegistries,
  routeCtx,
  type ConnectorServerHarness,
  type RedactionMarker,
} from "./harness.js";

const MARKER = buildRedactionMarker();
const VAULT_ENV = { KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY: randomBytes(32).toString("base64") };
const WRITE_SCOPES: readonly CodingWorkbenchConnectorScope[] = [
  "knowledge-base.write",
  "issue-tracker.write",
];

// ─── Capturing transport (real adapter → this fetch) ───────────────────────────
function verifyRoute(pathname: string): { status: number; body: string } | undefined {
  if (pathname.endsWith("/rest/api/3/myself") || pathname.endsWith("/wiki/rest/api/user/current")) {
    return { status: 200, body: "{}" };
  }
  return undefined;
}

function confluenceWriteRoute(
  p: string,
  method: string,
): { status: number; body: string } | undefined {
  if (p.endsWith("/wiki/api/v2/pages") && method === "POST") {
    return { status: 200, body: '{"id":"123","version":{"number":1}}' };
  }
  if (p.endsWith("/wiki/api/v2/pages/123") && method === "PUT") {
    return { status: 409, body: "{}" };
  }
  return undefined;
}

function confluenceReadRoute(url: URL): { status: number; body: string } | undefined {
  const p = url.pathname;
  if (p.endsWith("/wiki/api/v2/spaces")) {
    const keys = (url.searchParams.get("keys") ?? "").split(",");
    const results = keys.includes("ENG") ? [{ id: "100", key: "ENG", name: "ENG" }] : [];
    return { status: 200, body: JSON.stringify({ results, _links: {} }) };
  }
  if (p.endsWith("/wiki/api/v2/spaces/100/pages")) {
    return {
      status: 200,
      body: JSON.stringify({
        results: [{ id: "1", title: "Runbook", status: "current" }],
        _links: {},
      }),
    };
  }
  if (p.endsWith("/wiki/api/v2/pages/1/footer-comments")) {
    return { status: 200, body: JSON.stringify({ results: [], _links: {} }) };
  }
  if (p.endsWith("/wiki/api/v2/pages/1")) {
    return {
      status: 200,
      body: JSON.stringify({
        id: "1",
        title: "Runbook",
        body: { storage: { value: "<p>Restart the gateway.</p>", representation: "storage" } },
        _links: { webui: "/wiki/spaces/ENG/pages/1" },
      }),
    };
  }
  return undefined;
}

function confluenceRoute(url: URL, method: string): { status: number; body: string } | undefined {
  return confluenceWriteRoute(url.pathname, method) ?? confluenceReadRoute(url);
}

function jiraRoute(url: URL, method: string): { status: number; body: string } | undefined {
  const p = url.pathname;
  if (p.endsWith("/rest/api/3/search/jql")) {
    return {
      status: 200,
      body: JSON.stringify({
        issues: [
          {
            id: "10001",
            key: "PROJ-1",
            fields: { summary: "Tracked", updated: "2026-05-01T10:22:33.000+0000" },
          },
        ],
        isLast: true,
      }),
    };
  }
  if (p.endsWith("/rest/api/3/issue") && method === "POST") {
    return { status: 201, body: '{"id":"10001","key":"PROJ-9"}' };
  }
  if (/\/rest\/api\/3\/issue\/[^/]+\/comment$/u.test(p) && method === "POST") {
    return { status: 201, body: '{"id":"20001"}' };
  }
  if (/\/rest\/api\/3\/issue\/[^/]+\/comment$/u.test(p)) {
    return {
      status: 200,
      body: JSON.stringify({ comments: [], total: 0, startAt: 0, maxResults: 100 }),
    };
  }
  if (p.endsWith("/rest/api/3/issue/PROJ-1")) {
    return {
      status: 200,
      body: JSON.stringify({
        id: "10001",
        key: "PROJ-1",
        fields: { summary: "Tracked", updated: "2026-05-01T10:22:33.000+0000" },
      }),
    };
  }
  return undefined;
}

function routerResponse(url: URL, method: string): { status: number; body: string } {
  return (
    verifyRoute(url.pathname) ??
    confluenceRoute(url, method) ??
    jiraRoute(url, method) ?? { status: 404, body: JSON.stringify({ status: 404 }) }
  );
}

function capturingFetch(outboundAuth: string[]): typeof fetch {
  return (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const authorization = new Headers(init?.headers).get("authorization");
    if (authorization !== null) outboundAuth.push(authorization);
    const answer = routerResponse(new URL(url), init?.method ?? "GET");
    return Promise.resolve(new Response(answer.body, { status: answer.status }));
  };
}

// ─── Artifact collection ────────────────────────────────────────────────────────
const SCANNED_ARTIFACT_CLASSES = [
  "custody-crud-responses",
  "verify-responses",
  "sync-poll-payloads",
  "activity-records",
  "action-responses",
  "approval-projections",
  "error-bodies",
  "diagnostics",
  "persisted-metadata",
  "persisted-vault-file",
  "console-output",
] as const;

type ArtifactClass = (typeof SCANNED_ARTIFACT_CLASSES)[number];

class ArtifactSink {
  readonly buckets = new Map<string, string[]>();
  record(bucket: ArtifactClass, value: unknown): void {
    const entries = this.buckets.get(bucket) ?? [];
    entries.push(typeof value === "string" ? value : JSON.stringify(value));
    this.buckets.set(bucket, entries);
  }
}

function assertArtifactAllowlist(keys: readonly string[], allowlist: readonly string[]): void {
  const extra = keys.filter((key) => !allowlist.includes(key));
  const missing = allowlist.filter((key) => !keys.includes(key));
  if (extra.length > 0 || missing.length > 0) {
    throw new Error(
      `artifact allowlist drift: extra=[${extra.join(",")}] missing=[${missing.join(",")}]`,
    );
  }
}

function credentialBody(
  provider: "jira" | "confluence",
  marker: RedactionMarker,
): Record<string, unknown> {
  return {
    provider,
    displayName: provider === "jira" ? "Jira Prod" : "Wiki Prod",
    baseUrl: CONNECTOR_BASE_URL,
    authScheme: "basic-api-token",
    accountEmail: marker.email,
    apiToken: marker.token,
  };
}

async function createCredential(
  deps: UiHandlerDeps,
  provider: "jira" | "confluence",
  sink: ArtifactSink,
): Promise<AtlassianCredentialMetadata> {
  const result = await handleCreateAtlassianConnectorCredential(
    routeCtx({}, credentialBody(provider, MARKER)) as unknown as RouteContext,
    deps,
  );
  sink.record("custody-crud-responses", result.body);
  return result.body as AtlassianCredentialMetadata;
}

async function runCustodyAndVerify(
  deps: UiHandlerDeps,
  sink: ArtifactSink,
): Promise<{ jira: AtlassianCredentialMetadata; confluence: AtlassianCredentialMetadata }> {
  const jira = await createCredential(deps, "jira", sink);
  const confluence = await createCredential(deps, "confluence", sink);
  const throwaway = await createCredential(deps, "jira", sink);
  sink.record(
    "custody-crud-responses",
    (
      await handleListAtlassianConnectorCredentials(
        routeCtx({}, {}) as unknown as RouteContext,
        deps,
      )
    ).body,
  );
  sink.record(
    "custody-crud-responses",
    (
      await handleDeleteAtlassianConnectorCredential(
        routeCtx({ authRef: throwaway.authRef }, {}) as unknown as RouteContext,
        deps,
      )
    ).body,
  );
  for (const credential of [jira, confluence]) {
    const verified = await handleVerifyAtlassianConnectorCredential(
      routeCtx({ authRef: credential.authRef }, {}) as unknown as RouteContext,
      deps,
    );
    sink.record("verify-responses", verified.body);
  }
  return { jira, confluence };
}

async function runSync(
  deps: UiHandlerDeps,
  authRef: string,
  scope: Record<string, unknown>,
  sink: ArtifactSink,
): Promise<void> {
  const started = await handleStartAtlassianConnectorSync(
    routeCtx({ authRef }, scope) as unknown as RouteContext,
    deps,
  );
  const body = started.body as { job?: { jobId: string }; disposition?: string };
  if (body.job === undefined) {
    sink.record("sync-poll-payloads", started.body);
    return;
  }
  const terminal = await awaitJobTerminal(body.job.jobId);
  sink.record("sync-poll-payloads", terminal);
  const poll = await handleGetAtlassianConnectorSyncJob(
    routeCtx({ jobId: body.job.jobId }, {}) as unknown as RouteContext,
    deps,
  );
  sink.record("sync-poll-payloads", poll.body);
}

async function runAction(
  deps: UiHandlerDeps,
  authRef: string,
  action: Record<string, unknown>,
  scopes: readonly CodingWorkbenchConnectorScope[],
  sink: ArtifactSink,
): Promise<void> {
  const authority = registerConnectorEnvelope("autonomous-delivery", scopes);
  const result = await handleExecuteAtlassianConnectorAction(
    routeCtx({ authRef }, { action, authority }) as unknown as RouteContext,
    deps,
  );
  sink.record("action-responses", result.body);
}

async function runReviewRequiredAction(
  deps: UiHandlerDeps,
  authRef: string,
  action: Record<string, unknown>,
  sink: ArtifactSink,
): Promise<void> {
  const authority = registerConnectorEnvelope("governed-assist", WRITE_SCOPES);
  const result = await handleExecuteAtlassianConnectorAction(
    routeCtx({ authRef }, { action, authority }) as unknown as RouteContext,
    { ...deps, autonomousDeliveryDeploymentCeiling: "governed-assist" },
  );
  sink.record("approval-projections", result.body);
  const listed = await handleListAtlassianConnectorActionApprovals(
    routeCtx({}, {}) as unknown as RouteContext,
    deps,
  );
  sink.record("approval-projections", listed.body);
}

async function runErrorSurfaces(deps: UiHandlerDeps, sink: ArtifactSink): Promise<void> {
  // Invalid create body echoing the submitted token in the base URL — the route must not echo it.
  const invalid = await handleCreateAtlassianConnectorCredential(
    routeCtx(
      {},
      { ...credentialBody("jira", MARKER), baseUrl: `https://user:${MARKER.token}@x.example` },
    ) as unknown as RouteContext,
    deps,
  );
  sink.record("error-bodies", invalid.body);
  // Oversized body → 413.
  const oversized = await handleCreateAtlassianConnectorCredential(
    routeCtx({}, { filler: "x".repeat(40_000), token: MARKER.token }) as unknown as RouteContext,
    deps,
  );
  sink.record("error-bodies", oversized.body);
  // Verify an unknown ref → 404 (no oracle, no echo).
  const unknown = await handleVerifyAtlassianConnectorCredential(
    routeCtx({ authRef: `atlassian-cred:${"Z".repeat(22)}` }, {}) as unknown as RouteContext,
    deps,
  );
  sink.record("error-bodies", unknown.body);
}

function recordPersistedState(
  deps: UiHandlerDeps,
  configPath: string,
  diagnostics: readonly unknown[],
  sink: ArtifactSink,
): void {
  const credentialsDir = join(dirname(configPath), "credentials");
  sink.record("persisted-metadata", deps.atlassianConnectorCredentials?.custody.list() ?? []);
  sink.record(
    "persisted-metadata",
    readFileSync(join(credentialsDir, "atlassian-connector-credentials.metadata.json"), "utf8"),
  );
  sink.record(
    "persisted-vault-file",
    readFileSync(join(credentialsDir, "atlassian-connector-credentials.vault"), "utf8"),
  );
  sink.record("diagnostics", diagnostics);
}

// Capture any console output during the flow run: product code routes real output through the
// diagnostic sink, not `console.*`, so this bucket proves nothing is logged there either.
function captureConsole(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const spies = methods.map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]): void => {
      output.push(args.map((arg) => String(arg)).join(" "));
    }),
  );
  return {
    output,
    restore: (): void => {
      spies.forEach((spy) => {
        spy.mockRestore();
      });
    },
  };
}

// ─── Sweep run ───────────────────────────────────────────────────────────────
let sink: ArtifactSink;
let outboundAuth: string[];
let harness: ConnectorServerHarness;

beforeAll(async () => {
  resetConnectorRegistries();
  sink = new ArtifactSink();
  outboundAuth = [];
  const consoleCapture = captureConsole();
  const configPathHolder = { value: "" };
  harness = createConnectorServerHarness(
    (tmp): ReturnType<typeof buildAtlassianConnectorCredentialDeps> => {
      configPathHolder.value = join(tmp, "keiko.config.json");
      return buildAtlassianConnectorCredentialDeps({
        configPath: configPathHolder.value,
        env: VAULT_ENV,
        egress: () => undefined,
        fetchImpl: capturingFetch(outboundAuth),
      });
    },
    { tmpPrefix: "keiko-atl-redaction-" },
  );
  const deps = harness.deps;
  const { jira, confluence } = await runCustodyAndVerify(deps, sink);
  await runSync(deps, confluence.authRef, { spaceKeys: ["ENG"] }, sink); // happy
  await runSync(deps, confluence.authRef, { spaceKeys: ["OPS"] }, sink); // degraded (unresolved space)
  await runSync(deps, jira.authRef, { projectKeys: ["PROJ"] }, sink); // happy jira
  await runAction(
    deps,
    jira.authRef,
    { type: "add-issue-comment", issueKey: "PROJ-1", commentText: MARKER.token },
    WRITE_SCOPES,
    sink,
  ); // allowed
  await runAction(
    deps,
    jira.authRef,
    { type: "create-issue", projectKey: "PROJ", issueTypeId: "10004", summary: MARKER.token },
    [],
    sink,
  ); // denied
  await runAction(
    deps,
    confluence.authRef,
    { type: "update-page", pageId: "123", title: "T", bodyText: MARKER.token, currentVersion: 4 },
    WRITE_SCOPES,
    sink,
  ); // failed (409)
  await runAction(
    deps,
    jira.authRef,
    { type: "search-issues-live", jql: MARKER.jql },
    ["issue-tracker.read"],
    sink,
  ); // live
  await runReviewRequiredAction(
    deps,
    jira.authRef,
    { type: "create-issue", projectKey: "PROJ", issueTypeId: "10004", summary: "S" },
    sink,
  );
  for (const credential of [jira, confluence]) {
    const activity = await handleListAtlassianConnectorActivity(
      routeCtx({ authRef: credential.authRef }, {}) as unknown as RouteContext,
      deps,
    );
    sink.record("activity-records", activity.body);
  }
  await runErrorSurfaces(deps, sink);
  recordPersistedState(deps, configPathHolder.value, harness.diagnostics, sink);
  consoleCapture.restore();
  sink.record("console-output", consoleCapture.output);
});

afterAll(() => {
  resetConnectorRegistries();
  harness.cleanup();
});

describe("token-redaction sweep (Issue #2246 Scope 1, ADR-0128 D2/D6)", () => {
  it("materialises the credential at the outbound hop (the sweep is non-vacuous)", () => {
    const encoded = Buffer.from(`${MARKER.email}:${MARKER.token}`, "utf8").toString("base64");
    expect(outboundAuth.length).toBeGreaterThan(0);
    expect(outboundAuth).toContain(`Basic ${encoded}`);
  });

  it("finds ZERO raw marker occurrences (token or email) in any scanned artifact class", () => {
    for (const [bucket, entries] of sink.buckets) {
      for (const entry of entries) {
        expect(entry, `${bucket} leaked the token`).not.toContain(MARKER.token);
        expect(entry, `${bucket} leaked the email`).not.toContain(MARKER.email);
      }
    }
  });

  it("keeps the base64 credential ONLY at the outbound hop, never in an artifact", () => {
    const encoded = Buffer.from(`${MARKER.email}:${MARKER.token}`, "utf8").toString("base64");
    for (const [bucket, entries] of sink.buckets) {
      for (const entry of entries) {
        expect(entry, `${bucket} leaked the encoded credential`).not.toContain(encoded);
      }
    }
  });

  it("ran every listed flow: each artifact class is present and non-degenerate", () => {
    for (const bucket of SCANNED_ARTIFACT_CLASSES) {
      expect(sink.buckets.has(bucket), `missing artifact class ${bucket}`).toBe(true);
    }
    expect((sink.buckets.get("sync-poll-payloads") ?? []).length).toBeGreaterThanOrEqual(3);
    expect((sink.buckets.get("action-responses") ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("FAILS the build if a produced artifact class is not enumerated in the scanned set", () => {
    // The real run's buckets exactly match the allowlist.
    assertArtifactAllowlist([...sink.buckets.keys()], SCANNED_ARTIFACT_CLASSES);
    // Guard bites: a new (unenumerated) artifact class is a hard failure.
    expect(() => {
      assertArtifactAllowlist([...sink.buckets.keys(), "ghost-artifact"], SCANNED_ARTIFACT_CLASSES);
    }).toThrow(/allowlist drift/u);
    // Guard bites the other way too: a dropped artifact class is a hard failure.
    expect(() => {
      assertArtifactAllowlist([...sink.buckets.keys()].slice(1), SCANNED_ARTIFACT_CLASSES);
    }).toThrow(/allowlist drift/u);
  });
});
