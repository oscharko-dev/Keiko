import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type {
  AtlassianCredentialMetadata,
  AtlassianHttpBodyRequest,
} from "@oscharko-dev/keiko-connectors";
import {
  AtlassianCredentialCustodyError,
  executeAtlassianWriteRequest,
} from "@oscharko-dev/keiko-connectors";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import { buildAtlassianConnectorCredentialDeps } from "./wiring.js";
import {
  ambiguousJiraAuthenticationResponse,
  JIRA_IDENTITY_PROBE_WINDOW_MS,
  withJiraAuthenticationObservation,
} from "./jiraAuthenticationObservation.js";
import { createAtlassianCredentialMetadataStore } from "./credentialMetadataStore.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";
import { defaultServerDiagnosticSink } from "../diagnostics-log.js";

const BASE = "https://jira.example.invalid/context";
const IDENTITY = { name: "synthetic-user", key: "synthetic-key", active: true };
const PATHS = [
  "issueLink/1",
  "workflowscheme/1",
  "workflowscheme/1/default",
  "workflowscheme/1/draft",
  "workflowscheme/1/draft/default",
  "workflowscheme/1/issuetype/2",
  "workflowscheme/1/draft/issuetype/2",
  "workflowscheme/1/workflow",
  "workflowscheme/1/draft/workflow",
  "screens/1/tabs",
  "screens/1/tabs/2/fields",
  "screens/1/availableFields",
  "workflow",
  "screens",
  "cluster/nodes",
  "cluster/zdu/state",
  "index-snapshot/isRunning",
  "user/columns",
  "index-snapshot",
] as const;
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
type JiraMetadata = Extract<AtlassianCredentialMetadata, { deployment: "data-center" }>;
interface Fixture {
  readonly deps: ReturnType<typeof buildAtlassianConnectorCredentialDeps>;
  readonly urls: string[];
  readonly events: ServerLogEvent[];
  readonly invalidated: number[];
  readonly metadata: JiraMetadata;
  readonly current: () => JiraMetadata;
}
function fixture(
  reply: (index: number, init?: RequestInit) => Response | Promise<Response>,
): Fixture {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "keiko-auth-observation-")));
  directories.push(directory);
  const configPath = join(directory, "config.json");
  const urls: string[] = [];
  const events: ServerLogEvent[] = [];
  const invalidated: number[] = [];
  const deps = buildAtlassianConnectorCredentialDeps({
    configPath,
    env: { KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY: randomBytes(32).toString("base64") },
    egress: () => undefined,
    activityLog: {
      write: (event): void => {
        events.push(event);
      },
    },
    onLivePodInvalidated: (_id, generation): void => {
      if (generation !== null) invalidated.push(generation);
    },
    fetchImpl: (input, init): Promise<Response> => {
      urls.push(input instanceof Request ? input.url : input.toString());
      return Promise.resolve(reply(urls.length - 1, init));
    },
  });
  const created = deps.custody.create(
    {
      provider: "jira",
      displayName: "Synthetic Jira",
      baseUrl: BASE,
      deployment: "data-center",
      authScheme: "bearer-pat",
      apiToken: ["synthetic", "observation", "credential"].join("-"),
      livePodCreationRequestId: "7765d9e4-fc9a-46d5-aea4-24880fec5e1e",
    },
    "a".repeat(64),
  );
  createAtlassianCredentialMetadataStore({ configPath }).bindTargetAdmission(created, {
    baseUrl: BASE,
    addressClass: "public",
  });
  const ticket = deps.custody.beginVerification(created.authRef);
  if (ticket === undefined) throw new TypeError("Missing verification ticket");
  deps.custody.finishVerification(created.authRef, 1, ticket.revision, "ok", undefined, {
    schemaVersion: 1,
    deploymentType: "Data Center",
    versionNumbers: [11, 3, 13],
    restApi: "v2",
    agileApi: "unverified",
  });
  const current = (): JiraMetadata => {
    const metadata = deps.custody.getMetadata(created.authRef);
    if (metadata?.deployment !== "data-center")
      throw new TypeError("Missing Jira credential metadata");
    return metadata;
  };
  return { deps, urls, events, invalidated, metadata: current(), current };
}
// A 401 Jira itself authored carries its request id and the anonymous-user marker (observed on
// Data Center 10.3: unknown or revoked bearer tokens answer exactly so). Tests that need another
// origin pass their own headers.
const JIRA_401_HEADERS = { "X-AREQUESTID": "synthetic-request", "X-AUSERNAME": "anonymous" };
function response(value: unknown = {}, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: headers ?? (status === 401 ? JIRA_401_HEADERS : {}),
  });
}
function request(path: string = PATHS[0]): AtlassianHttpBodyRequest {
  const relative = path.startsWith("/") ? path.slice(1) : path;
  return {
    method: "GET",
    url: `${BASE}/rest/api/2/${relative}`,
    timeoutMs: 1000,
    maxBodyBytes: 4096,
  };
}
it.each(PATHS)(
  "keeps a verified credential after ambiguous administrator401 on %s",
  async (path) => {
    const f = fixture((index) => (index === 0 ? response({}, 401) : response(IDENTITY)));
    const statuses: number[] = [];
    const beforeDispatch = vi.fn(() => true);
    const result = await f.deps.httpBodyPortFactory(f.metadata, "admin-auth-check", {
      beforeDispatch,
      onResponse: (_request, status): boolean => {
        statuses.push(status);
        return true;
      },
    })(request(path));
    expect(result).toMatchObject({ kind: "response", status: 401, authentication: "confirmed" });
    expect(f.urls).toEqual([request(path).url, `${BASE}/rest/api/2/myself`]);
    expect(statuses).toEqual([401]);
    expect(beforeDispatch).toHaveBeenCalledTimes(2);
    expect(f.current()).toEqual(f.metadata);
    expect(f.invalidated).toEqual([]);
  },
);
it.each([401, "anonymous"] as const)(
  "invalidates only confirmed identity failure %s",
  async (failure) => {
    const f = fixture((index) =>
      index === 0
        ? response({}, 401)
        : failure === 401
          ? response({}, 401)
          : response(IDENTITY, 200, {
              "x-ausername": "anonymous",
              "X-AREQUESTID": "synthetic-request",
            }),
    );
    const result = await f.deps.httpBodyPortFactory(f.metadata)(request());
    expect(result).toMatchObject({ status: 401 });
    expect(result).not.toHaveProperty("authentication");
    expect(f.urls).toHaveLength(2);
    expect(f.current()).toMatchObject({
      generation: 2,
      livePod: { verificationStatus: "auth-failed" },
    });
    expect(f.invalidated).toEqual([2]);
  },
);
it.each([403, 404, 429, 503, "malformed", "inactive", "wrong-shape"] as const)(
  "does not infer a credential failure or retry from uncertain identity %s",
  async (failure) => {
    const f = fixture((index) => {
      if (index === 0) return response({}, 401);
      if (typeof failure === "number") return response({}, failure);
      if (failure === "malformed") return new Response("not-json");
      return response(
        failure === "inactive"
          ? { ...IDENTITY, active: false }
          : { accountId: "other", active: true },
      );
    });
    expect(await f.deps.httpBodyPortFactory(f.metadata)(request())).toMatchObject({ status: 401 });
    expect(f.urls).toHaveLength(2);
    expect(f.current()).toEqual(f.metadata);
    expect(f.invalidated).toEqual([]);
  },
);
it.each([
  "project",
  "issuetypescheme/1",
  "workflowscheme/1/unknown",
  "workflow/unknown",
  "screens/1/tabs/2",
  "readonly-mode",
  "cluster/nodes/1",
  "cluster/zdu/approve",
  "index-snapshot/unknown",
  "reindex",
  "reindex/progress",
  "reindex/request/1",
  "upgrade",
  "monitoring/app",
  "index/summary",
  "user/a11y/personal-settings",
  "settings/columns",
  "filter/1/columns",
  "user/columns/unknown",
])(
  // Deliberate reversal (#4353). The removed pin "keeps ordinary401 invalidation on %s without a
  // probe" (#4287 C-series, #4314/#4316) guarded one incident: widening the list of ambiguous
  // routes beyond what Jira documents would let a dead token survive on a route nobody had proven
  // ambiguous. There is no list any more; the identity read decides every route. This test, with
  // "#4316: index/summary still discards an invalid credential", still catches the incident: a
  // dead credential is discarded on each of these routes.
  "keeps ordinary401 invalidation on %s once the identity probe also answers 401",
  async (path) => {
    const f = fixture(() => response({}, 401));
    await f.deps.httpBodyPortFactory(f.metadata)(request(path));
    expect(f.urls).toEqual([request(path).url, `${BASE}/rest/api/2/myself`]);
    expect(f.invalidated).toEqual([2]);
  },
);
it.each([
  "workflowscheme/1/unknown",
  "workflow",
  "screens",
  "cluster/nodes",
  "cluster/zdu/state",
  "index-snapshot/isRunning",
  "user/columns",
  "index-snapshot",
])(
  // Deliberate reversal (#4353). The removed pin "does not classify a %s write as an ambiguous
  // administrator read" guarded an incident of the same family: a GET-only ambiguity must not be
  // borrowed for a write on the same path, or a refused write would be misread. Writes are never
  // replayed and never borrow a read's facts; the identity read alone decides, and this test
  // asserts exactly that (two requests, the write sent once, an invalid credential discarded).
  "decides a %s write 401 by the identity probe and never replays the write",
  async (path) => {
    const f = fixture(() => response({}, 401));
    await f.deps.httpBodyPortFactory(f.metadata)({
      ...request(path),
      method: "PUT",
      bodyJson: "{}",
    });
    expect(f.urls).toEqual([request(path).url, `${BASE}/rest/api/2/myself`]);
    expect(f.invalidated).toEqual([2]);
  },
);
it("honors authority revocation between the primary response and identity probe", async () => {
  let allowed = true;
  const f = fixture(() => {
    allowed = false;
    return response({}, 401);
  });
  // The credential change during the probe no longer throws out of the port: the original 401
  // settles as unconfirmed, nothing more is sent and the credential is kept (#4353).
  expect(
    await f.deps.httpBodyPortFactory(f.metadata, undefined, {
      beforeDispatch: () => allowed,
    })(request()),
  ).toMatchObject({ status: 401, authentication: "unconfirmed" });
  expect(f.urls).toHaveLength(1);
  expect(f.current()).toEqual(f.metadata);
});
it("does not probe after caller cancellation", async () => {
  const controller = new AbortController();
  const f = fixture(() => {
    controller.abort();
    return response({}, 401);
  });
  await f.deps.httpBodyPortFactory(f.metadata)({ ...request(), signal: controller.signal });
  expect(f.urls).toHaveLength(1);
  expect(f.current()).toEqual(f.metadata);
});
it("does not probe without remaining original time", async () => {
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = fixture(() => {
    now += 2000;
    return response({}, 401);
  });
  await f.deps.httpBodyPortFactory(f.metadata)(request());
  expect(f.urls).toHaveLength(1);
  expect(f.current()).toEqual(f.metadata);
  vi.restoreAllMocks();
});
it("does not probe a stale verification revision", async () => {
  const f = fixture(() => {
    const ticket = f.deps.custody.beginVerification(f.metadata.authRef);
    if (ticket === undefined) throw new TypeError("Missing new verification");
    f.deps.custody.finishVerification(f.metadata.authRef, 1, ticket.revision, "ok");
    return response({}, 401);
  });
  await f.deps.httpBodyPortFactory(f.metadata)(request());
  expect(f.urls).toHaveLength(1);
  expect(f.current().livePod?.verificationStatus).toBe("ok");
});
it.each(["revision", "generation"] as const)(
  "cannot publish a stale identity failure after %s changes",
  async (change) => {
    const f = fixture((index) => {
      if (index === 0) return response({}, 401);
      if (change === "generation") {
        f.deps.custody.updateLivePod(f.metadata.authRef, {
          expectedGeneration: 1,
          apiToken: ["replacement", "synthetic", "credential"].join("-"),
        });
      } else {
        const ticket = f.deps.custody.beginVerification(f.metadata.authRef);
        if (ticket === undefined) throw new TypeError("Missing verification ticket");
        f.deps.custody.finishVerification(f.metadata.authRef, 1, ticket.revision, "ok");
      }
      return response({}, 401);
    });
    await f.deps.httpBodyPortFactory(f.metadata)(request());
    expect(f.urls).toHaveLength(2);
    expect(f.current().livePod?.verificationStatus).toBe(
      change === "generation" ? "unverified" : "ok",
    );
    expect(f.current().generation).toBe(change === "generation" ? 2 : 1);
  },
);
it("uses the remaining original time and tears down the identity request on cancellation", async () => {
  const controller = new AbortController();
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = fixture((index, init) => {
    if (index === 0) {
      now += 800;
      return response({}, 401);
    }
    expect(init?.signal?.aborted).toBe(false);
    controller.abort();
    expect(init?.signal?.aborted).toBe(true);
    return Promise.reject(new DOMException("cancelled", "AbortError"));
  });
  const budgets: number[] = [];
  await f.deps.httpBodyPortFactory(f.metadata, undefined, {
    beforeDispatch: (input) => {
      budgets.push(input.timeoutMs);
      return true;
    },
  })({ ...request(), signal: controller.signal });
  expect(f.urls).toHaveLength(2);
  expect(budgets).toEqual([1000, 200]);
  expect(f.current()).toEqual(f.metadata);
});
it("does not accept an oversized identity response or replay the primary request", async () => {
  const f = fixture((index) =>
    index === 0 ? response({}, 401) : response({ ...IDENTITY, ignored: "x".repeat(65536) }),
  );
  await f.deps.httpBodyPortFactory(f.metadata)(request());
  expect(f.urls).toHaveLength(2);
  expect(f.current()).toEqual(f.metadata);
});
it("keeps synchronous observer refusal before any secondary request", async () => {
  const f = fixture(() => response({}, 401));
  await expect(
    f.deps.httpBodyPortFactory(f.metadata, undefined, { onResponse: () => false })(request()),
  ).rejects.toMatchObject({ code: "invalid-input" });
  expect(f.urls).toHaveLength(1);
  expect(f.current()).toEqual(f.metadata);
});
it("also preserves the bounded bodyless request API", async () => {
  const f = fixture((index) => (index === 0 ? response({}, 401) : response(IDENTITY)));
  const input = { method: "GET", url: request().url, timeoutMs: 1000 } as const;
  expect(await f.deps.httpPortFactory(f.metadata)(input)).toEqual({
    kind: "response",
    status: 401,
    authentication: "confirmed",
    authenticationFailure: "jira",
  });
  expect(f.urls).toHaveLength(2);
  expect(f.current()).toEqual(f.metadata);
});
it.each([
  ["jira.workflow-scheme", { schemeId: "1" }],
  ["jira.screen-tabs", { screenId: "1" }],
  ["jira.workflows", {}],
  ["jira.screens", {}],
  ["jira.cluster-nodes", {}],
  ["jira.cluster-upgrade-state", {}],
  ["jira.index-snapshot-status", {}],
  ["jira.user-columns", {}],
  ["jira.index-snapshots", {}],
] as const)(
  "returns actionable %s permission failure through the real managed read",
  async (name, args) => {
    const f = fixture((index) => (index === 0 ? response({}, 401) : response(IDENTITY)));
    const provider = createJiraProviderForCatalog(
      () => ({
        deployment: "data-center",
        baseUrl: BASE,
        http: f.deps.httpBodyPortFactory(f.metadata),
      }),
      [name],
    );
    const tool = provider.tools()[0];
    if (tool === undefined) throw new TypeError("Missing Jira read");
    const result = await tool.execute(args, {
      invocationId: "admin-read",
      correlationId: "admin-read",
      signal: new AbortController().signal,
      beforeEffect: () => true,
    });
    expect(result.data).toMatchObject({ outcome: "failed", reason: "permission-denied" });
    expect(f.urls).toHaveLength(2);
    expect(f.current()).toEqual(f.metadata);
  },
);
it.each(["expired", "cancelled", "revised"] as const)(
  "cannot attach positive identity evidence after the request became %s",
  async (state) => {
    const controller = new AbortController();
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture((index) => {
      if (index === 0) return response({}, 401);
      if (state === "expired") now += 2000;
      if (state === "cancelled") controller.abort();
      if (state === "revised") {
        const ticket = f.deps.custody.beginVerification(f.metadata.authRef);
        if (ticket === undefined) throw new TypeError("Missing new verification");
        f.deps.custody.finishVerification(f.metadata.authRef, 1, ticket.revision, "ok");
      }
      return response(IDENTITY);
    });
    const result = await f.deps.httpBodyPortFactory(f.metadata)({
      ...request(),
      signal: controller.signal,
    });
    expect(result).toMatchObject({ status: 401 });
    expect(result).toMatchObject({ authentication: "unconfirmed" });
    expect(f.current().livePod?.verificationStatus).toBe("ok");
  },
);
it.each([false, true])(
  "uses the original request snapshot when the caller mutates it (aborted=%s)",
  async (abort) => {
    const original = new AbortController();
    const input = { ...request(), signal: original.signal };
    const f = fixture((index) => {
      if (index === 0) {
        input.method = "PUT";
        input.url = `${BASE}/rest/api/2/project`;
        input.signal = new AbortController().signal;
        if (abort) original.abort();
        return response({}, 401);
      }
      return response(IDENTITY);
    });
    expect(await f.deps.httpBodyPortFactory(f.metadata)(input)).toMatchObject({ status: 401 });
    expect(f.urls).toHaveLength(abort ? 1 : 2);
    expect(f.current()).toEqual(f.metadata);
  },
);
it("keeps body-free evidence and does not attribute the probe status to the primary response", async () => {
  const f = fixture((index) =>
    index === 0 ? response({ message: "private admin message" }, 401) : response(IDENTITY),
  );
  await f.deps.httpBodyPortFactory(f.metadata, "admin-auth-check")(request());
  const checked = f.events.filter((event) => event.op === "atlassian.connection.checked");
  expect(checked).toHaveLength(1);
  expect(JSON.stringify(checked)).not.toMatch(
    /private admin|synthetic-user|https:|myself|workflowscheme/,
  );
});

const TAB_REQUESTS = [
  ["POST", "screens/1/tabs"],
  ["PUT", "screens/1/tabs/2"],
  ["DELETE", "screens/1/tabs/2"],
] as const;
const ISSUE_LINK_REQUESTS = [
  ["POST", "issueLink"],
  ["DELETE", "issueLink/1"],
] as const;
it.each(ISSUE_LINK_REQUESTS)(
  "retains documented %s %s permission401 only after a current positive identity read",
  async (method, path) => {
    const methods: string[] = [];
    const f = fixture((index, init) => {
      methods.push(init?.method ?? "GET");
      return index === 0
        ? response({ errorMessages: ["Link Issues permission required"] }, 401)
        : response(IDENTITY);
    });
    const statuses: number[] = [];
    const result = await executeAtlassianWriteRequest(
      {
        http: f.deps.httpBodyPortFactory(f.metadata, undefined, {
          onResponse: (_request, status) => {
            statuses.push(status);
            return true;
          },
        }),
      },
      {
        method,
        url: request(path).url,
        expect: "none",
        ...(method === "POST"
          ? {
              bodyJson:
                '{"type":{"name":"Blocks"},"inwardIssue":{"key":"SYN-1"},"outwardIssue":{"key":"SYN-2"}}',
            }
          : {}),
      },
    );
    expect(result).toMatchObject({ ok: false, reason: "permission-denied", httpStatus: 401 });
    expect(f.urls).toEqual([request(path).url, `${BASE}/rest/api/2/myself`]);
    expect(methods).toEqual([method, "GET"]);
    expect(statuses).toEqual([401]);
    expect(f.current()).toEqual(f.metadata);
    expect(f.invalidated).toEqual([]);
    expect(JSON.stringify(f.events)).not.toMatch(
      /Link Issues|Blocks|SYN-1|SYN-2|synthetic-user|https:/u,
    );
  },
);
it.each(ISSUE_LINK_REQUESTS)(
  "keeps expired credentials definitive for %s %s without replay",
  async (method, path) => {
    const f = fixture(() => response({}, 401));
    const result = await f.deps.httpBodyPortFactory(f.metadata)({ ...request(path), method });
    expect(result).toMatchObject({ status: 401 });
    expect(result).not.toHaveProperty("authentication");
    expect(f.urls).toEqual([request(path).url, `${BASE}/rest/api/2/myself`]);
    expect(f.invalidated).toEqual([2]);
  },
);
it.each([
  { method: "POST", path: "issueLink/1" },
  { method: "PUT", path: "issueLink/1" },
  { method: "DELETE", path: "issueLink" },
  { method: "DELETE", path: "issueLink/0" },
  { method: "DELETE", path: "issueLink/1/unknown" },
  { method: "POST", path: "issue/SYN-1/remotelink" },
  { method: "PUT", path: "issue/SYN-1/remotelink/1" },
  { method: "DELETE", path: "issue/SYN-1/remotelink/1" },
  { method: "DELETE", path: "issue/SYN-1/remotelink" },
] as const)(
  "never borrows issue-link permission evidence for $method $path: only the identity probe decides",
  async ({ method, path }) => {
    const f = fixture(() => response({}, 401));
    await f.deps.httpBodyPortFactory(f.metadata)({ ...request(path), method });
    expect(f.urls).toEqual([request(path).url, `${BASE}/rest/api/2/myself`]);
    expect(f.invalidated).toEqual([2]);
  },
);
function tabRequest(method: "POST" | "PUT" | "DELETE", path: string): AtlassianHttpBodyRequest {
  return {
    ...request(path),
    method,
    ...(method === "DELETE" ? {} : { bodyJson: '{"name":"Reviewed"}' }),
  };
}
it.each(TAB_REQUESTS)(
  "observes documented %s %s admin401 once and returns permission denial without invalidation",
  async (method, path) => {
    const methods: string[] = [];
    const f = fixture((index, init) => {
      methods.push(init?.method ?? "GET");
      return index === 0
        ? response({ errorMessages: ["Administrator permission required"] }, 401)
        : response(IDENTITY);
    });
    const statuses: number[] = [];
    const result = await executeAtlassianWriteRequest(
      {
        http: f.deps.httpBodyPortFactory(f.metadata, undefined, {
          onResponse: (_request, status) => {
            statuses.push(status);
            return true;
          },
        }),
      },
      {
        method,
        url: request(path).url,
        ...(method === "DELETE" ? {} : { bodyJson: '{"name":"Reviewed"}' }),
        expect: "none",
      },
    );
    expect(result).toMatchObject({ ok: false, reason: "permission-denied", httpStatus: 401 });
    expect(f.urls).toEqual([request(path).url, `${BASE}/rest/api/2/myself`]);
    expect(methods).toEqual([method, "GET"]);
    expect(statuses).toEqual([401]);
    expect(f.current()).toEqual(f.metadata);
    expect(f.invalidated).toEqual([]);
    expect(JSON.stringify(f.events)).not.toMatch(
      /Administrator permission|required|synthetic-user|Reviewed|https:/u,
    );
  },
);
it.each([
  ["POST", "screens/1/tabs/2"],
  ["PUT", "screens/1/tabs"],
  ["DELETE", "screens/1/tabs"],
  ["POST", "screens/0/tabs"],
  ["PUT", "screens/1/tabs/0"],
  ["DELETE", "screens/1/tabs/2/fields"],
  ["POST", "screens/1/tabs/2/move/-1"],
  ["PUT", "project/1"],
  ["POST", "monitoring/app"],
  ["POST", "monitoring/ipd"],
  ["POST", "monitoring/jmx/startExposing"],
  ["POST", "monitoring/jmx/stopExposing"],
] as const)("retains ordinary credential failure for unlisted %s %s", async (method, path) => {
  const f = fixture(() => response({}, 401));
  await f.deps.httpBodyPortFactory(f.metadata)(tabRequest(method, path));
  expect(f.urls).toEqual([request(path).url, `${BASE}/rest/api/2/myself`]);
  expect(f.invalidated).toEqual([2]);
});
it.each(TAB_REQUESTS)(
  "still invalidates expired credentials confirmed after %s %s",
  async (method, path) => {
    const f = fixture(() => response({}, 401));
    const result = await f.deps.httpBodyPortFactory(f.metadata)(tabRequest(method, path));
    expect(result).toMatchObject({ status: 401 });
    expect(result).not.toHaveProperty("authentication");
    expect(f.urls).toHaveLength(2);
    expect(f.invalidated).toEqual([2]);
  },
);
it.each(["expired", "cancelled", "revision", "generation"] as const)(
  "cannot apply positive tab-write auth evidence after %s changes",
  async (state) => {
    const controller = new AbortController();
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture((index) => {
      if (index === 0) return response({}, 401);
      if (state === "expired") now += 2000;
      if (state === "cancelled") controller.abort();
      if (state === "generation")
        f.deps.custody.updateLivePod(f.metadata.authRef, {
          expectedGeneration: 1,
          apiToken: ["replacement", "synthetic", "credential"].join("-"),
        });
      if (state === "revision") {
        const ticket = f.deps.custody.beginVerification(f.metadata.authRef);
        if (ticket === undefined) throw new TypeError("Missing verification ticket");
        f.deps.custody.finishVerification(f.metadata.authRef, 1, ticket.revision, "ok");
      }
      return response(IDENTITY);
    });
    const result = await f.deps.httpBodyPortFactory(f.metadata)({
      ...tabRequest("PUT", "screens/1/tabs/2"),
      signal: controller.signal,
    });
    expect(result).toMatchObject({ status: 401 });
    expect(result).toMatchObject({ authentication: "unconfirmed" });
    expect(f.urls).toHaveLength(2);
    expect(f.current().livePod?.verificationStatus).toBe(
      state === "generation" ? "unverified" : "ok",
    );
  },
);
it("stops a tab-write auth probe when original authority is revoked and never repeats DELETE", async () => {
  let allowed = true;
  const f = fixture(() => {
    allowed = false;
    return response({}, 401);
  });
  expect(
    await f.deps.httpBodyPortFactory(f.metadata, undefined, {
      beforeDispatch: () => allowed,
    })(tabRequest("DELETE", "screens/1/tabs/2")),
  ).toMatchObject({ status: 401, authentication: "unconfirmed" });
  expect(f.urls).toHaveLength(1);
  expect(f.current()).toEqual(f.metadata);
});
it("spends only the tab-write's subsecond remaining deadline on identity IO", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  let probeSignal: AbortSignal | null | undefined;
  let entered: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = fixture((index, init) => {
    if (index === 0) {
      vi.setSystemTime(1990);
      return response({}, 401);
    }
    probeSignal = init?.signal;
    entered?.();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          reject(new Error("Synthetic identity probe aborted"));
        },
        { once: true },
      );
    });
  });
  const pending = f.deps.httpBodyPortFactory(f.metadata)(tabRequest("POST", "screens/1/tabs"));
  await ready;
  expect(probeSignal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(10);
  await pending;
  expect(probeSignal?.aborted).toBe(true);
  expect(f.urls).toHaveLength(2);
  expect(f.current()).toEqual(f.metadata);
});

const DOCUMENTED_NATIVE_WRITE_401 = [
  { method: "PUT", path: "applicationrole" },
  { method: "PUT", path: "applicationrole/jira-software" },
  { method: "DELETE", path: "user/columns?username=synthetic-user" },
  { method: "PUT", path: "cluster/index-snapshot/node-1" },
  { method: "DELETE", path: "cluster/node/node-1" },
  { method: "PUT", path: "cluster/node/node-1/offline" },
  { method: "PUT", path: "cluster/node/node-%C3%A4/offline" },
  { method: "POST", path: "cluster/zdu/approve" },
  { method: "POST", path: "cluster/zdu/cancel" },
  { method: "POST", path: "cluster/zdu/retryUpgrade" },
  { method: "POST", path: "cluster/zdu/start" },
  { method: "POST", path: "index-snapshot" },
  { method: "POST", path: "reindex/request" },
  { method: "POST", path: "workflowscheme" },
  { method: "PUT", path: "workflowscheme/1" },
  { method: "DELETE", path: "workflowscheme/1" },
  { method: "POST", path: "workflowscheme/1/createdraft" },
  { method: "PUT", path: "workflowscheme/1/draft" },
  { method: "DELETE", path: "workflowscheme/1/draft" },
  { method: "PUT", path: "workflowscheme/1/default" },
  { method: "DELETE", path: "workflowscheme/1/default" },
  { method: "PUT", path: "workflowscheme/1/draft/default" },
  { method: "DELETE", path: "workflowscheme/1/draft/default" },
  { method: "PUT", path: "workflowscheme/1/issuetype/2" },
  { method: "DELETE", path: "workflowscheme/1/issuetype/2" },
  { method: "PUT", path: "workflowscheme/1/draft/issuetype/2" },
  { method: "DELETE", path: "workflowscheme/1/draft/issuetype/2" },
  { method: "PUT", path: "workflowscheme/1/workflow" },
  { method: "DELETE", path: "workflowscheme/1/workflow" },
  { method: "PUT", path: "workflowscheme/1/draft/workflow" },
  { method: "DELETE", path: "workflowscheme/1/draft/workflow" },
  { method: "PUT", path: "issue/SYN-1/assignee" },
  { method: "POST", path: "issue/SYN-1/watchers" },
  { method: "DELETE", path: "issue/SYN-1/watchers" },
  { method: "POST", path: "screens/addToDefault/customfield_10000" },
  { method: "POST", path: "screens/1/tabs/2/fields" },
  { method: "DELETE", path: "screens/1/tabs/2/fields/1" },
  { method: "POST", path: "screens/1/tabs/2/fields/1/move" },
  { method: "PUT", path: "screens/1/tabs/2/fields/1/updateShowWhenEmptyIndicator/false" },
  { method: "POST", path: "screens/1/tabs/2/move/0" },
] as const;
it.each(DOCUMENTED_NATIVE_WRITE_401)(
  "keeps the actual $method $path permission refusal without credential loss or write replay",
  async ({ method, path }) => {
    const methods: string[] = [];
    const f = fixture((index, init) => {
      methods.push(init?.method ?? "GET");
      return index === 0
        ? response({ errorMessages: ["Native permission or WebSudo required"] }, 401)
        : response(IDENTITY);
    });
    const result = await executeAtlassianWriteRequest(
      { http: f.deps.httpBodyPortFactory(f.metadata) },
      {
        method,
        url: request(path).url,
        expect: "none",
        ...(method === "DELETE" ? {} : { bodyJson: "{}" }),
      },
    );
    expect(result).toMatchObject({ ok: false, reason: "permission-denied", httpStatus: 401 });
    expect(methods).toEqual([method, "GET"]);
    expect(f.urls).toEqual([request(path).url, `${BASE}/rest/api/2/myself`]);
    expect(f.current()).toEqual(f.metadata);
    expect(f.invalidated).toEqual([]);
    expect(JSON.stringify(f.events)).not.toMatch(
      /Native permission|WebSudo|synthetic-user|https:/u,
    );
  },
);
it.each(DOCUMENTED_NATIVE_WRITE_401)(
  "keeps expired credentials definitive after $method $path",
  async ({ method, path }) => {
    const f = fixture(() => response({}, 401));
    const result = await f.deps.httpBodyPortFactory(f.metadata)({
      ...request(path),
      method,
      ...(method === "DELETE" ? {} : { bodyJson: "{}" }),
    });
    expect(result).toMatchObject({ status: 401 });
    expect(result).not.toHaveProperty("authentication");
    expect(f.urls).toEqual([request(path).url, `${BASE}/rest/api/2/myself`]);
    expect(f.invalidated).toEqual([2]);
  },
);
it.each([
  { method: "POST", path: "workflowscheme/1/draft" },
  { method: "PUT", path: "workflowscheme/1/createdraft" },
  { method: "PUT", path: "workflowscheme/0" },
  { method: "PUT", path: "workflowscheme/9223372036854775808" },
  { method: "DELETE", path: "workflowscheme/1/unknown" },
  { method: "POST", path: "screens/1/tabs/2/fields/3/move/unknown" },
  { method: "PUT", path: "screens/1/tabs/2/fields/3/updateShowWhenEmptyIndicator/0" },
  { method: "POST", path: "screens/1/tabs/2/move/2147483648" },
  { method: "POST", path: "issue/SYN-1/assignee" },
  { method: "PUT", path: "issue/SYN-1/watchers" },
  { method: "POST", path: "issue/SYN-1/notify" },
] as const)(
  "never widens documented native auth facts to $method $path: only the identity probe decides",
  async ({ method, path }) => {
    const f = fixture(() => response({}, 401));
    await f.deps.httpBodyPortFactory(f.metadata)({
      ...request(path),
      method,
      ...(method === "DELETE" ? {} : { bodyJson: "{}" }),
    });
    expect(f.urls).toEqual([request(path).url, `${BASE}/rest/api/2/myself`]);
    expect(f.invalidated).toEqual([2]);
  },
);

it("refuses an encoded slash before dispatch, authentication probing or credential revocation", async () => {
  const f = fixture(() => response({}, 401));
  await expect(
    f.deps.httpBodyPortFactory(f.metadata)({
      ...request("screens/addToDefault/unsafe%2Ffield"),
      method: "POST",
      bodyJson: "{}",
    }),
  ).rejects.toMatchObject({ code: "invalid-input" });
  expect(f.urls).toEqual([]);
  expect(f.invalidated).toEqual([]);
  expect(f.current()).toEqual(f.metadata);
  expect(
    ambiguousJiraAuthenticationResponse(f.metadata, {
      ...request("screens/addToDefault/unsafe%2Ffield"),
      method: "POST",
    }),
  ).toBe(false);
});

// #4353: the identity probe is the structural rule for every 401 that is not the identity route
// itself. These routes stood in no list; a project key never matched the numeric-id wildcard.
const UNLISTED_READS = [
  "project/KER/role",
  "project/KER/role/10002",
  "synthetic-unlisted/resource",
  "issue/SYN-1/transitions",
  "serverInfo",
] as const;
it.each(UNLISTED_READS)(
  "classifies a GET 401 on the unlisted route %s as decided by the identity probe",
  (path) => {
    const f = fixture(() => response({}, 401));
    expect(ambiguousJiraAuthenticationResponse(f.metadata, request(path))).toBe(true);
  },
);
it("never classifies the identity route, another origin or another context path as ambiguous", () => {
  const f = fixture(() => response({}, 401));
  expect(ambiguousJiraAuthenticationResponse(f.metadata, request("myself"))).toBe(false);
  expect(
    ambiguousJiraAuthenticationResponse(f.metadata, {
      ...request("project/KER/role"),
      url: "https://other.example.invalid/context/rest/api/2/project/KER/role",
    }),
  ).toBe(false);
  expect(
    ambiguousJiraAuthenticationResponse(f.metadata, {
      ...request("project/KER/role"),
      url: "https://jira.example.invalid/other/rest/api/2/project/KER/role",
    }),
  ).toBe(false);
});
it.each(UNLISTED_READS)(
  "keeps a valid credential after a permission-shaped 401 on the unlisted GET %s",
  async (path) => {
    const f = fixture((index) => (index === 0 ? response({}, 401) : response(IDENTITY)));
    const result = await f.deps.httpBodyPortFactory(f.metadata, "unlisted-401")(request(path));
    expect(result).toMatchObject({ kind: "response", status: 401, authentication: "confirmed" });
    expect(f.urls).toEqual([request(path).url, `${BASE}/rest/api/2/myself`]);
    expect(f.current()).toEqual(f.metadata);
    expect(f.invalidated).toEqual([]);
  },
);
it.each(UNLISTED_READS)(
  "still detects an actually invalid credential after a 401 on the unlisted GET %s",
  async (path) => {
    const f = fixture(() => response({}, 401));
    const result = await f.deps.httpBodyPortFactory(f.metadata, "unlisted-401")(request(path));
    expect(result).toMatchObject({ status: 401 });
    expect(result).not.toHaveProperty("authentication");
    expect(f.urls).toEqual([request(path).url, `${BASE}/rest/api/2/myself`]);
    expect(f.current()).toMatchObject({
      generation: 2,
      livePod: { verificationStatus: "auth-failed" },
    });
    expect(f.invalidated).toEqual([2]);
  },
);
it("answers a 401 on the identity route itself without a second probe and revokes the credential", async () => {
  const f = fixture(() => response({}, 401));
  await f.deps.httpBodyPortFactory(f.metadata)(request("myself"));
  expect(f.urls).toEqual([request("myself").url]);
  expect(f.invalidated).toEqual([2]);
});
it("returns an actionable permission failure through the real project-role read", async () => {
  // The lab actor reads the project but may not read its roles: the role read answers 401.
  const f = fixture((index) => {
    if (index === 0) return response({ id: "10000", key: "KER", name: "Keiko" });
    return index === 1 ? response({}, 401) : response(IDENTITY);
  });
  const provider = createJiraProviderForCatalog(
    () => ({
      deployment: "data-center",
      baseUrl: BASE,
      http: f.deps.httpBodyPortFactory(f.metadata),
    }),
    ["jira.project-roles"],
  );
  const tool = provider.tools()[0];
  if (tool === undefined) throw new TypeError("Missing Jira read");
  const result = await tool.execute(
    { projectIdOrKey: "KER" },
    {
      invocationId: "project-roles",
      correlationId: "project-roles",
      signal: new AbortController().signal,
      beforeEffect: () => true,
    },
  );
  expect(result.data).toMatchObject({ outcome: "failed", reason: "permission-denied" });
  expect(f.urls).toEqual([
    `${BASE}/rest/api/2/project/KER`,
    `${BASE}/rest/api/2/project/10000/role`,
    `${BASE}/rest/api/2/myself`,
  ]);
  expect(f.current()).toEqual(f.metadata);
  expect(f.invalidated).toEqual([]);
});

it("decides a synthetic unlisted GET 401 by the probe alone: confirmed identity keeps the credential", async () => {
  const f = fixture(() => response({}, 401));
  const port = vi.fn(() => Promise.resolve({ kind: "response", status: 401 } as const));
  const probe = vi.fn(() => Promise.resolve("confirmed" as const));
  const result = await withJiraAuthenticationObservation(
    f.metadata,
    port,
    () => true,
    probe,
  )(request("synthetic-unlisted/resource"));
  expect(result).toEqual({ kind: "response", status: 401, authentication: "confirmed" });
  expect(port).toHaveBeenCalledTimes(1);
  expect(probe).toHaveBeenCalledTimes(1);
});
it("settles each probe outcome distinctly: rejected stays bare, everything else is unconfirmed", async () => {
  const f = fixture(() => response({}, 401));
  const port = (): Promise<{ readonly kind: "response"; readonly status: 401 }> =>
    Promise.resolve({ kind: "response", status: 401 });
  const request401 = request("project/KER/role");
  const settle = (
    outcome: "confirmed" | "rejected" | "inconclusive",
    current = true,
    onUnsettled = vi.fn(),
  ): Promise<unknown> =>
    withJiraAuthenticationObservation(
      f.metadata,
      port,
      () => current,
      () => Promise.resolve(outcome),
      { onUnsettled },
    )(request401);
  expect(await settle("rejected")).toEqual({ kind: "response", status: 401 });
  expect(await settle("inconclusive")).toEqual({
    kind: "response",
    status: 401,
    authentication: "unconfirmed",
  });
  const stale = vi.fn();
  expect(await settle("confirmed", false, stale)).toMatchObject({ authentication: "unconfirmed" });
  expect(stale).toHaveBeenCalledWith("stale");
  const failing = vi.fn();
  expect(
    await withJiraAuthenticationObservation(
      f.metadata,
      port,
      () => true,
      () => Promise.reject(new TypeError("synthetic probe failure")),
      { onUnsettled: failing },
    )(request401),
  ).toMatchObject({ authentication: "unconfirmed" });
  expect(failing).toHaveBeenCalledWith("probe-error", expect.any(TypeError));
});
it("never probes a non-401 answer or the identity route", async () => {
  const f = fixture(() => response({}, 401));
  const probe = vi.fn(() => Promise.resolve("confirmed" as const));
  const ok = withJiraAuthenticationObservation(
    f.metadata,
    () => Promise.resolve({ kind: "response", status: 403 } as const),
    () => true,
    probe,
  );
  await ok(request("project/KER/role"));
  await withJiraAuthenticationObservation(
    f.metadata,
    () => Promise.resolve({ kind: "response", status: 401 } as const),
    () => true,
    probe,
  )(request("myself"));
  expect(probe).not.toHaveBeenCalled();
});

// #4353 review point 1: the PAT port of the private owner serves the same observed credential.
function privateSessionScope(
  f: Fixture,
): Parameters<NonNullable<Fixture["deps"]["jiraPrivatePortFactory"]>>[2]["sessionScope"] {
  if (f.metadata.livePod === undefined) throw new TypeError("Missing Live Pod");
  return {
    context: {
      kind: "chat",
      chatId: "synthetic-chat",
      podId: f.metadata.livePod.podId,
      bindingGeneration: 1,
    },
    authority: { runId: "synthetic-run", envelopeDigest: "a".repeat(64) },
    principalDigest: "a".repeat(64),
    authRef: f.metadata.authRef,
    authenticationGeneration: f.metadata.generation,
    verificationRevision: f.metadata.livePod.verificationRevision,
    expiresAt: Date.now() + 60_000,
  };
}
function privateIdentityPorts(
  f: Fixture,
  metadata: JiraMetadata = f.metadata,
): ReturnType<NonNullable<Fixture["deps"]["jiraPrivatePortFactory"]>> {
  const factory = f.deps.jiraPrivatePortFactory;
  if (factory === undefined) throw new TypeError("Missing private port factory");
  return factory(
    metadata,
    {
      invocationId: "private-401",
      correlationId: "private-401",
      signal: new AbortController().signal,
      beforeEffect: () => true,
    },
    { sessionScope: privateSessionScope(f) },
  );
}
it("discards the credential after a 401 on the identity read of the private PAT port", async () => {
  const f = fixture(() => response({}, 401));
  await privateIdentityPorts(f).identity.session("logout", "synthetic-key");
  expect(f.urls).toEqual([`${BASE}/rest/api/2/myself`]);
  expect(f.invalidated).toEqual([2]);
});
it("pins the credential by value for the private port as for the ordinary ports", async () => {
  const f = fixture(() => response({}, 401));
  const mutable = structuredClone(f.metadata);
  const ports = privateIdentityPorts(f, mutable);
  // The caller advances its own copy; the observed generation and revision stay pinned.
  if (mutable.livePod === undefined) throw new TypeError("Missing Live Pod");
  Object.assign(mutable, { generation: 99 });
  Object.assign(mutable.livePod, { verificationRevision: 99 });
  await ports.identity.session("logout", "synthetic-key");
  expect(f.invalidated).toEqual([2]);
});

// #4353 review point 2: a 401 the identity read could not settle is neither an expired token nor
// a permission denial. The request is refused with its own closed outcome, the credential is kept.
type Inconclusive =
  | { readonly name: string; readonly probe: () => Response | Promise<Response> }
  | { readonly name: string; readonly change: "abort" | "stale" | "expired" | "dispatch-throw" };
const INCONCLUSIVE: readonly Inconclusive[] = [
  { name: "403", probe: () => response({}, 403) },
  { name: "404", probe: () => response({}, 404) },
  { name: "429", probe: () => response({}, 429, { "retry-after": "3" }) },
  { name: "503", probe: () => response({}, 503) },
  {
    name: "redirect",
    probe: () => new Response(null, { status: 302, headers: { location: "/x" } }),
  },
  { name: "non-JSON", probe: () => new Response("not-json") },
  { name: "inactive identity", probe: () => response({ ...IDENTITY, active: false }) },
  { name: "network failure", probe: () => Promise.reject(new TypeError("synthetic network")) },
  { name: "aborted request", change: "abort" },
  { name: "stale observation", change: "stale" },
  { name: "expired deadline", change: "expired" },
  { name: "dispatch refusal during the probe", change: "dispatch-throw" },
];
const PROBE_CAUSES: Readonly<Record<string, string>> = {
  "403": "http-4xx",
  "404": "http-4xx",
  "429": "http-429",
  "503": "http-5xx",
  redirect: "redirect",
  "non-JSON": "invalid-body",
  "inactive identity": "invalid-body",
  "network failure": "network",
  "aborted request": "cancelled-or-expired",
  "stale observation": "stale",
  "expired deadline": "cancelled-or-expired",
  "dispatch refusal during the probe": "probe-error",
};
it.each(INCONCLUSIVE)(
  "refuses an inconclusive identity read ($name) as auth-unverified and keeps the credential",
  async (kind) => {
    const controller = new AbortController();
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let dispatches = 0;
    const f = fixture((index) => {
      if (index === 0) {
        if ("change" in kind) {
          if (kind.change === "abort") controller.abort();
          if (kind.change === "expired") now += 2000;
          if (kind.change === "stale") {
            const ticket = f.deps.custody.beginVerification(f.metadata.authRef);
            if (ticket === undefined) throw new TypeError("Missing verification ticket");
            f.deps.custody.finishVerification(f.metadata.authRef, 1, ticket.revision, "ok");
          }
        }
        return response({}, 401);
      }
      return "probe" in kind ? kind.probe() : response(IDENTITY);
    });
    const http = f.deps.httpBodyPortFactory(f.metadata, "inconclusive-probe", {
      beforeDispatch: () => {
        dispatches += 1;
        if ("change" in kind && kind.change === "dispatch-throw" && dispatches > 1)
          throw new AtlassianCredentialCustodyError("credential-changed");
        return true;
      },
    });
    const result = await http({ ...request("project/KER/role"), signal: controller.signal });
    expect(result).toMatchObject({ kind: "response", status: 401, authentication: "unconfirmed" });
    // Never replayed, never revoked, and the end-to-end outcome is the closed one.
    expect(f.invalidated).toEqual([]);
    expect(f.current().livePod?.verificationStatus).toBe("ok");
    expect(f.current().generation).toBe(1);
    const outcome = await executeAtlassianWriteRequest(
      { http: () => Promise.resolve(result) },
      { method: "GET", url: request("project/KER/role").url, expect: "json" },
    );
    expect(outcome).toMatchObject({ ok: false, reason: "auth-unverified", httpStatus: 401 });
    // The registered line says why the identity read could not settle (closed cause only).
    const line = f.events
      .filter((event) => event.op === "atlassian.connection.checked")
      .map((event) => event.extra)
      .at(-1);
    expect(line).toMatchObject({
      outcome: "probe-inconclusive",
      probeCause: PROBE_CAUSES[kind.name],
    });
    expect(JSON.stringify(line)).not.toMatch(/https:|synthetic-user/u);
  },
);
it("keeps a probe that actually answers 401 as the one rejected-token outcome", async () => {
  const f = fixture(() => response({}, 401));
  const result = await f.deps.httpBodyPortFactory(f.metadata)(request("project/KER/role"));
  expect(result).not.toHaveProperty("authentication");
  const outcome = await executeAtlassianWriteRequest(
    { http: () => Promise.resolve(result) },
    { method: "GET", url: request("project/KER/role").url, expect: "json" },
  );
  expect(outcome).toMatchObject({ ok: false, reason: "auth-failed", httpStatus: 401 });
  expect(f.invalidated).toEqual([2]);
});

// #4353 review point 3: a credential change thrown out of the probe port is a defined outcome.
it("settles a throw out of the probe as unconfirmed with one closed log line", async () => {
  const f = fixture(() => response({}, 401));
  let dispatches = 0;
  const result = await f.deps.httpBodyPortFactory(f.metadata, "probe-throw", {
    beforeDispatch: () => {
      dispatches += 1;
      if (dispatches > 1) throw new AtlassianCredentialCustodyError("credential-changed");
      return true;
    },
  })(request("project/KER/role"));
  expect(result).toMatchObject({ status: 401, authentication: "unconfirmed" });
  expect(f.urls).toHaveLength(1);
  expect(
    f.events.filter((event) => event.op === "atlassian.connection.checked").map((e) => e.extra),
  ).toMatchObject([{ outcome: "probe-inconclusive", decision: "probe", routeClass: "other" }]);
});

// #4353 review point 4: one positive identity read vouches for a short, fixed window.
it("reuses a positive identity read for the same generation within the window only", async () => {
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = fixture((index) => (index === 1 ? response(IDENTITY) : response({}, 401)));
  const http = f.deps.httpBodyPortFactory(f.metadata, "probe-window");
  const urls = ["project/KER/role", "issue/SYN-1/transitions", "serverInfo"];
  for (const path of urls)
    expect(await http(request(path))).toMatchObject({ authentication: "confirmed" });
  // Three 401s, one identity read: the other two reuse its window.
  expect(f.urls.filter((url) => url.endsWith("/myself"))).toHaveLength(1);
  now += JIRA_IDENTITY_PROBE_WINDOW_MS + 1;
  await http(request(urls[0] ?? "x"));
  expect(f.urls.filter((url) => url.endsWith("/myself"))).toHaveLength(2);
  const decisions = f.events
    .filter((event) => event.op === "atlassian.connection.checked")
    .map((event) => event.extra?.decision);
  expect(decisions).toEqual(["probe", "probe-window", "probe-window", "probe"]);
});
it("never reuses an inconclusive or rejected identity read", async () => {
  const now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = fixture((index) => (index % 2 === 0 ? response({}, 401) : response({}, 503)));
  const http = f.deps.httpBodyPortFactory(f.metadata, "no-negative-cache");
  await http(request("project/KER/role"));
  await http(request("project/KER/role"));
  expect(f.urls.filter((url) => url.endsWith("/myself"))).toHaveLength(2);
  expect(f.invalidated).toEqual([]);
  const rejecting = fixture(() => response({}, 401));
  const rejectingHttp = rejecting.deps.httpBodyPortFactory(rejecting.metadata);
  await rejectingHttp(request("project/KER/role"));
  expect(rejecting.invalidated).toEqual([2]);
});
it("does not carry a positive window across a credential generation", async () => {
  const f = fixture((index) => (index === 1 ? response(IDENTITY) : response({}, 401)));
  await f.deps.httpBodyPortFactory(f.metadata)(request("project/KER/role"));
  f.deps.custody.updateLivePod(f.metadata.authRef, {
    expectedGeneration: 1,
    apiToken: ["replacement", "synthetic", "credential"].join("-"),
  });
  const rotated = f.current();
  const ticket = f.deps.custody.beginVerification(rotated.authRef);
  if (ticket === undefined) throw new TypeError("Missing verification ticket");
  f.deps.custody.finishVerification(rotated.authRef, 2, ticket.revision, "ok");
  const before = f.urls.length;
  await f.deps.httpBodyPortFactory(f.current())(request("project/KER/role"));
  // The rotated credential is probed itself: the first window never vouches for it.
  expect(f.urls.slice(before).filter((url) => url.endsWith("/myself"))).toHaveLength(1);
});

// #4353 review point 5: the log line says what decided and which route class triggered it.
it("records identity-route and probe-decided discards with distinct closed fields", async () => {
  const route = fixture(() => response({}, 401));
  await route.deps.httpBodyPortFactory(route.metadata, "identity-route")(request("myself"));
  expect(
    route.events.filter((e) => e.op === "atlassian.connection.checked").map((e) => e.extra),
  ).toMatchObject([{ outcome: "auth-failed", decision: "identity-route", routeClass: "identity" }]);
  const probed = fixture(() => response({}, 401));
  await probed.deps.httpBodyPortFactory(
    probed.metadata,
    "probe-decided",
  )(request("project/KER/role"));
  expect(
    probed.events.filter((e) => e.op === "atlassian.connection.checked").map((e) => e.extra),
  ).toMatchObject([{ outcome: "auth-failed", decision: "probe", routeClass: "other" }]);
});

// #4353 review point 6: rules of the closed issues, pinned by name.
it.each(["project/KER/role", "workflow", "screens", "screens/1/tabs"])(
  "#4314 AC6: an administrative 401 on %s keeps a valid credential",
  async (path) => {
    const f = fixture((index) => (index === 0 ? response({}, 401) : response(IDENTITY)));
    await f.deps.httpBodyPortFactory(f.metadata)(request(path));
    expect(f.invalidated).toEqual([]);
    expect(f.current()).toEqual(f.metadata);
  },
);
it.each(["cluster/nodes", "cluster/zdu/state", "index-snapshot/isRunning", "index-snapshot"])(
  "#4316: the GET %s keeps a valid credential after a permission 401",
  async (path) => {
    const f = fixture((index) => (index === 0 ? response({}, 401) : response(IDENTITY)));
    await f.deps.httpBodyPortFactory(f.metadata)(request(path));
    expect(f.invalidated).toEqual([]);
  },
);
it("#4316: index/summary still discards an invalid credential", async () => {
  const f = fixture(() => response({}, 401));
  await f.deps.httpBodyPortFactory(f.metadata)(request("index/summary"));
  expect(f.invalidated).toEqual([2]);
});
it.each(["project/KER/role", "workflow", "cluster/nodes", "index/summary", "myself"])(
  "#4305, #4306, #4309: a 403 on %s is a missing permission and never touches the credential",
  async (path) => {
    const f = fixture(() => response({}, 403));
    await f.deps.httpBodyPortFactory(f.metadata)(request(path));
    expect(f.urls).toEqual([request(path).url]);
    expect(f.invalidated).toEqual([]);
    expect(f.current()).toEqual(f.metadata);
  },
);

// #4353 audit B: only a 401 that Jira itself authored shows a rejected token. Jira behind a
// single sign-on proxy answers 401 everywhere, /myself included, once the proxy session ends, and
// a captcha lock adds X-Authentication-Denied-Reason; neither may cost a person their token.
const FOREIGN_401 = [
  ["a single sign-on proxy's HTML 401", { "Content-Type": "text/html" }, "foreign-401"],
  ["an empty gateway 401", {}, "foreign-401"],
  [
    "a Jira 401 that carries a denial reason (captcha challenge)",
    { ...JIRA_401_HEADERS, "X-Authentication-Denied-Reason": "CAPTCHA_CHALLENGE; login-url=x" },
    "captcha",
  ],
] as const;
it.each(FOREIGN_401)(
  "keeps the credential when the identity read answers %s",
  async (_name, headers, cause) => {
    const f = fixture((index) =>
      index === 0
        ? response({}, 401)
        : new Response("<html>sign in</html>", { status: 401, headers }),
    );
    const result = await f.deps.httpBodyPortFactory(
      f.metadata,
      "foreign-probe",
    )(request("project/KER/role"));
    expect(result).toMatchObject({ status: 401, authentication: "unconfirmed" });
    expect(f.invalidated).toEqual([]);
    expect(f.current()).toEqual(f.metadata);
    expect(
      f.events.filter((e) => e.op === "atlassian.connection.checked").map((e) => e.extra),
    ).toMatchObject([{ outcome: "probe-inconclusive", probeCause: cause, decision: "probe" }]);
  },
);
it.each(FOREIGN_401)(
  "keeps the credential when the identity route itself answers %s",
  async (_name, headers, cause) => {
    const f = fixture(() => new Response("<html>sign in</html>", { status: 401, headers }));
    const result = await f.deps.httpBodyPortFactory(
      f.metadata,
      "foreign-identity",
    )(request("myself"));
    expect(result).toMatchObject({ status: 401, authentication: "unconfirmed" });
    expect(f.urls).toEqual([request("myself").url]);
    expect(f.invalidated).toEqual([]);
    expect(f.current()).toEqual(f.metadata);
    expect(
      f.events.filter((e) => e.op === "atlassian.connection.checked").map((e) => e.extra),
    ).toMatchObject([
      { outcome: "probe-inconclusive", probeCause: cause, decision: "identity-route" },
    ]);
  },
);
it("still discards on the Jira-authored shape observed for an unknown, expired or revoked token", async () => {
  const f = fixture(
    () =>
      new Response(
        '{"message":"Client must be authenticated to access this resource.","status-code":401,"sub-code":-1}',
        { status: 401, headers: { ...JIRA_401_HEADERS, "WWW-Authenticate": "OAuth realm=x" } },
      ),
  );
  await f.deps.httpBodyPortFactory(f.metadata, "jira-authored")(request("myself"));
  expect(f.invalidated).toEqual([2]);
});
it("keeps an anonymous identity answer Jira-authored: the probe still discards", async () => {
  const f = fixture((index) =>
    index === 0
      ? response({}, 401)
      : response(IDENTITY, 200, {
          "X-AREQUESTID": "synthetic-request",
          "X-AUSERNAME": "anonymous",
        }),
  );
  await f.deps.httpBodyPortFactory(f.metadata)(request("project/KER/role"));
  expect(f.invalidated).toEqual([2]);
});

// #4353 audit C: concurrent 401s share one identity read per credential generation and revision.
it.each([
  ["a throttled Jira (429)", (): Response => response({}, 429)],
  ["a healthy Jira", (): Response => response(IDENTITY)],
] as const)("shares one identity read among ten parallel 401s on %s", async (_name, probe) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(async (index) => {
    if (index < 10) return response({}, 401);
    await gate;
    return probe();
  });
  const http = f.deps.httpBodyPortFactory(f.metadata, "parallel-401");
  const calls = Array.from({ length: 10 }, (_unused, index) =>
    http(request(`resource/${String(index)}`)),
  );
  await vi.waitFor(() => {
    expect(f.urls.filter((url) => url.endsWith("/myself")).length).toBeGreaterThan(0);
  });
  release();
  const results = await Promise.all(calls);
  expect(f.urls.filter((url) => url.endsWith("/myself"))).toHaveLength(1);
  const expected = _name.includes("healthy") ? "confirmed" : "unconfirmed";
  for (const result of results) expect(result).toMatchObject({ authentication: expected });
  expect(f.invalidated).toEqual([]);
  expect(
    f.events
      .filter((e) => e.op === "atlassian.connection.checked")
      .map((e) => e.extra?.decision)
      .filter((decision) => decision === "probe-shared"),
  ).toHaveLength(9);
});
it("lets every sharer see a rejection of the one shared identity read", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(async (index) => {
    if (index >= 5) await gate;
    return response({}, 401);
  });
  const http = f.deps.httpBodyPortFactory(f.metadata, "parallel-rejection");
  const calls = Array.from({ length: 5 }, (_unused, index) =>
    http(request(`resource/${String(index)}`)),
  );
  await vi.waitFor(() => {
    expect(f.urls.filter((url) => url.endsWith("/myself")).length).toBe(1);
  });
  release();
  for (const result of await Promise.all(calls))
    expect(result).not.toHaveProperty("authentication");
  expect(f.urls.filter((url) => url.endsWith("/myself"))).toHaveLength(1);
  expect(f.invalidated).toEqual([2]);
});

// #4353 audit F: the probe exception takes the same closed diagnostic as its siblings.
it("reports a probe exception once through the diagnostic port with the closed summary", async () => {
  const record = vi
    .spyOn(defaultServerDiagnosticSink, "record")
    .mockImplementation(() => undefined);
  const f = fixture(() => response({}, 401));
  let dispatches = 0;
  await f.deps.httpBodyPortFactory(f.metadata, "probe-diagnostic", {
    beforeDispatch: () => {
      dispatches += 1;
      if (dispatches > 1) throw new AtlassianCredentialCustodyError("credential-changed");
      return true;
    },
  })(request("project/KER/role"));
  const probeRecords = record.mock.calls
    .map(([entry]) => entry)
    .filter((entry) => entry.source === "atlassian.identity-probe");
  expect(probeRecords).toHaveLength(1);
  expect(probeRecords[0]).toMatchObject({
    correlationId: "probe-diagnostic",
    operation: "atlassian.connection.checked",
    errorClass: "AtlassianCredentialCustodyError",
    message: "server-operation-failed",
  });
  expect(JSON.stringify(probeRecords)).not.toMatch(/https:|synthetic-credential/u);
});
