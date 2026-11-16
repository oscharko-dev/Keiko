import { describe, expect, it, vi } from "vitest";
import type {
  CatalogDigest,
  CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { createManagedMcpHost } from "@oscharko-dev/keiko-mcp";
import { catalogJsonBytes, validateToolResultEnvelope } from "@oscharko-dev/keiko-tool-catalog";
import { createGatewayAtlassianHttpBodyPort } from "./httpPort.js";
import { createJiraProviderForCatalog, jiraOperationForTool } from "./jiraManagedProvider.js";

// #4357: a person can confirm both the account and the Jira they are connected to. The instance is
// the host of the base URL the connection holds, in the result the model RECEIVES: the real provider,
// the managed host's own result capture, then the catalog's result validation and byte bound.
const BASE = "https://jira.example.invalid/context";
const AUTH = `atlassian-cred:${"Cc3-_".repeat(4)}Xx`;
const PROJECTION = "c".repeat(64) as CatalogDigest;
const MYSELF = {
  key: "JIRAUSER10000",
  name: "ann.example",
  displayName: "Ann Example",
  active: true,
  deleted: false,
  emailAddress: "ann@example.invalid",
  self: "https://jira.example.invalid/context/rest/api/2/user?username=ann.example",
};

function requestedUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}
interface Received {
  readonly data: CatalogJsonObject;
  readonly requests: readonly string[];
}
async function receive(
  tool: "jira.myself" | "jira.server-info",
  native: { readonly status: number; readonly body?: unknown },
  baseUrl = BASE,
): Promise<Received> {
  const fetchImpl = vi.fn<typeof fetch>(() =>
    Promise.resolve(
      native.body === undefined
        ? new Response(null, { status: native.status })
        : Response.json(native.body, { status: native.status }),
    ),
  );
  const port = createGatewayAtlassianHttpBodyPort({
    baseUrl,
    authRef: AUTH,
    credentials: { resolveForExecution: () => ({ scheme: "bearer-pat", apiToken: "synthetic" }) },
    beforeDispatch: () => true,
    fetchImpl,
  });
  const provider = createJiraProviderForCatalog(
    () => ({ deployment: "data-center", baseUrl, http: port }),
    [tool],
  );
  const host = createManagedMcpHost({ providers: [provider], log: { write: () => undefined } });
  const context: ManagedMcpInvocationContext = {
    invocationId: "whoami",
    correlationId: "whoami",
    signal: new AbortController().signal,
    beforeEffect: () => true,
  };
  try {
    await host.admit("whoami");
    const data = await host.call(tool, {}, context).catch((caught: unknown) => {
      const structured = (caught as { structuredResult?: CatalogJsonObject }).structuredResult;
      if (structured === undefined) throw caught;
      return structured;
    });
    const descriptor = jiraOperationForTool(tool)?.declaration.descriptor;
    if (descriptor === undefined) throw new TypeError("Missing descriptor");
    const failed = data.outcome === "failed";
    validateToolResultEnvelope(
      {
        schemaVersion: 1,
        invocationId: "whoami",
        toolRef: descriptor.toolRef,
        projectionDigest: PROJECTION,
        effectStarted: false,
        status: failed ? "failed" : "completed",
        reason: failed ? "provider-reported-error" : "none",
        data,
        page: failed ? null : { truncated: false, reason: "none", cursor: null },
        metrics: {
          inputBytes: 2,
          outputBytes: catalogJsonBytes(data),
          resultCount: failed ? 0 : 1,
          durationMs: 1,
        },
      },
      { descriptor, projectionDigest: PROJECTION },
    );
    return { data, requests: fetchImpl.mock.calls.map(([input]) => requestedUrl(input)) };
  } finally {
    await host.close();
  }
}

describe("jira.myself names the account and the Jira it is connected to (#4357)", () => {
  it("returns the account and the host of the connection's base URL in one request", async () => {
    const received = await receive("jira.myself", { status: 200, body: MYSELF });
    expect(received.data).toMatchObject({
      outcome: "succeeded",
      key: "JIRAUSER10000",
      name: "ann.example",
      instance: { host: "jira.example.invalid" },
    });
    expect(received.requests).toEqual([`${BASE}/rest/api/2/myself`]);
  });
  it("keeps the port the person typed, and nothing else of the address", async () => {
    const received = await receive(
      "jira.myself",
      { status: 200, body: MYSELF },
      "https://Jira.Example.invalid:8443/context/",
    );
    expect(received.data.instance).toEqual({ host: "jira.example.invalid:8443" });
  });
  it("never lets the path of the base URL into the result", async () => {
    // The gateway port already refuses a base URL with credentials, query or fragment; the connector's
    // own host rule for those is pinned in jira-connection-instance.test.ts.
    const received = await receive(
      "jira.myself",
      { status: 200, body: MYSELF },
      "https://jira.example.invalid/private-path/",
    );
    expect(received.data.instance).toEqual({ host: "jira.example.invalid" });
    const text = JSON.stringify(received.data);
    for (const leaked of ["private-path", "https://"]) expect(text, leaked).not.toContain(leaked);
  });
  it("adds no instance to a failed read", async () => {
    const received = await receive("jira.myself", { status: 403 });
    expect(received.data).toMatchObject({ outcome: "failed", reason: "permission-denied" });
    expect(received.data).not.toHaveProperty("instance");
  });
  it("adds the instance to jira.myself only", async () => {
    const received = await receive("jira.server-info", {
      status: 200,
      body: { version: "9.12.0", serverTitle: "Example Jira" },
    });
    expect(received.data).not.toHaveProperty("instance");
  });
  it("says in the description that it answers which account and which Jira", () => {
    const description = jiraOperationForTool("jira.myself")?.declaration.descriptor.description;
    expect(description).toContain("instance.host");
    expect(description).toContain("which account and which Jira");
  });
});
