import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type {
  AtlassianCredentialMetadata,
  AtlassianHttpBodyRequest,
} from "@oscharko-dev/keiko-connectors";
import { executeAtlassianWriteRequest } from "@oscharko-dev/keiko-connectors";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import { buildAtlassianConnectorCredentialDeps } from "./wiring.js";
import { ambiguousJiraAuthenticationResponse } from "./jiraAuthenticationObservation.js";
import { createAtlassianCredentialMetadataStore } from "./credentialMetadataStore.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";

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
function response(value: unknown = {}, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status,
    ...(headers === undefined ? {} : { headers }),
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
          : response(IDENTITY, 200, { "x-ausername": "anonymous" }),
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
  "myself",
])("keeps ordinary401 invalidation on %s without a probe", async (path) => {
  const f = fixture(() => response({}, 401));
  await f.deps.httpBodyPortFactory(f.metadata)(request(path));
  expect(f.urls).toEqual([request(path).url]);
  expect(f.invalidated).toEqual([2]);
});
it.each([
  "workflowscheme/1/unknown",
  "workflow",
  "screens",
  "cluster/nodes",
  "cluster/zdu/state",
  "index-snapshot/isRunning",
  "user/columns",
  "index-snapshot",
])("does not classify a %s write as an ambiguous administrator read", async (path) => {
  const f = fixture(() => response({}, 401));
  await f.deps.httpBodyPortFactory(f.metadata)({ ...request(path), method: "PUT", bodyJson: "{}" });
  expect(f.urls).toHaveLength(1);
  expect(f.invalidated).toEqual([2]);
});
it("honors authority revocation between the primary response and identity probe", async () => {
  let allowed = true;
  const f = fixture(() => {
    allowed = false;
    return response({}, 401);
  });
  await expect(
    f.deps.httpBodyPortFactory(f.metadata, undefined, {
      beforeDispatch: () => allowed,
    })(request()),
  ).rejects.toMatchObject({ code: "invalid-input" });
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
    expect(result).not.toHaveProperty("authentication");
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
  "never borrows issue-link permission evidence for $method $path",
  async ({ method, path }) => {
    const f = fixture(() => response({}, 401));
    await f.deps.httpBodyPortFactory(f.metadata)({ ...request(path), method });
    expect(f.urls).toEqual([request(path).url]);
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
  expect(f.urls).toHaveLength(1);
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
    expect(result).not.toHaveProperty("authentication");
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
  await expect(
    f.deps.httpBodyPortFactory(f.metadata, undefined, {
      beforeDispatch: () => allowed,
    })(tabRequest("DELETE", "screens/1/tabs/2")),
  ).rejects.toMatchObject({ code: "invalid-input" });
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
  "never widens documented native auth facts to $method $path",
  async ({ method, path }) => {
    const f = fixture(() => response({}, 401));
    await f.deps.httpBodyPortFactory(f.metadata)({
      ...request(path),
      method,
      ...(method === "DELETE" ? {} : { bodyJson: "{}" }),
    });
    expect(f.urls).toEqual([request(path).url]);
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
