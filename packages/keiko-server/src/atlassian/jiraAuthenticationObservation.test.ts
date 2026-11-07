import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type {
  AtlassianCredentialMetadata,
  AtlassianHttpBodyRequest,
} from "@oscharko-dev/keiko-connectors";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import { buildAtlassianConnectorCredentialDeps } from "./wiring.js";
import { createAtlassianCredentialMetadataStore } from "./credentialMetadataStore.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";

const BASE = "https://jira.example.invalid/context";
const IDENTITY = { name: "synthetic-user", key: "synthetic-key", active: true };
const PATHS = [
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
  return { method: "GET", url: `${BASE}/rest/api/2/${path}`, timeoutMs: 1000, maxBodyBytes: 4096 };
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
it.each(["project", "issuetypescheme/1", "workflowscheme/1/unknown", "workflow/unknown", "screens/1/tabs/2", "readonly-mode", "myself"])(
  "keeps ordinary401 invalidation on %s without a probe",
  async (path) => {
    const f = fixture(() => response({}, 401));
    await f.deps.httpBodyPortFactory(f.metadata)(request(path));
    expect(f.urls).toEqual([request(path).url]);
    expect(f.invalidated).toEqual([2]);
  },
);
it.each(["workflowscheme/1", "workflow", "screens"])("does not classify a %s write as an ambiguous administrator read", async (path) => {
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
    const result = await tool.execute(
      args,
      {
        invocationId: "admin-read",
        correlationId: "admin-read",
        signal: new AbortController().signal,
        beforeEffect: () => true,
      },
    );
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
