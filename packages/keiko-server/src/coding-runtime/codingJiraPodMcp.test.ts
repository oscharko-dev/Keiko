import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import { createServerLogger, setServerLogger } from "../observability/index.js";

import type { ServerLogEvent, ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  jiraTemplateViolationGuidance,
  type AtlassianCredentialMetadata,
  type AtlassianHttpBodyPort,
  type AtlassianHttpBodyRequest,
  type AtlassianHttpBodyResult,
} from "@oscharko-dev/keiko-connectors";
import type { CodingWorkbenchConnectorScope } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { ManagedMcpError } from "@oscharko-dev/keiko-mcp";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import {
  fixtureRead,
  fixtureWrite,
  field,
  response,
  type SyntheticJira,
} from "../../../../tests/support/jira-managed-remote.js";
import {
  createCodingJiraPods,
  type CodingJiraConnections,
  type CodingJiraRunAuthority,
  type CodingJiraPodDeps,
  type CodingJiraPods,
} from "./codingJiraPodMcp.js";
import { buildUiStoreOverDatabase } from "../store/index.js";
import { runMigrations } from "../store/schema.js";
import {
  CODING_JIRA_TOOL_RISKS,
  codingJiraServerDefinition,
  type CodingJiraPodBinding,
} from "./codingJiraPodBinding.js";
import { JIRA_TOOL_GUIDANCE } from "../atlassian/jiraToolGuidance.js";
import { jiraOperationDefinitions } from "../atlassian/jiraOperationRegistry.js";
import { postAndIdentityReadTransport } from "../../../../tests/support/jira-post-and-identity-read-fixture.js";

const POD = "d5f5681e-ce98-4c3c-b27e-51d707c9d018";
const PRINCIPAL = "operator-principal";
const BASE_URL = "https://jira.example.invalid/context";
const TOKEN = "synthetic-pod-token-never-in-a-line";

function ownerOf(principal: string): string {
  return createHash("sha256").update(principal).digest("hex");
}

interface PodState {
  generation: number;
  revision: number;
  status: "ok" | "unverified";
  owner: string;
  operation?: "delete" | "replace-token";
  deleted: boolean;
}

function metadata(pod: PodState): AtlassianCredentialMetadata {
  return {
    schemaVersion: "1",
    authRef: "synthetic-credential",
    displayName: "Synthetic Jira",
    baseUrl: BASE_URL,
    createdAt: 1,
    generation: pod.generation,
    provider: "jira",
    deployment: "data-center",
    authScheme: "bearer-pat",
    livePod: {
      podId: POD,
      ownerDigest: pod.owner,
      creationRequestId: "d5f5681e-ce98-4c3c-b27e-51d707c9d019",
      verificationRevision: pod.revision,
      verificationInProgress: false,
      verificationStatus: pod.status,
      ...(pod.operation === undefined ? {} : { credentialOperation: pod.operation }),
    },
  };
}

type PodChange = (pod: PodState) => void;
function setPod<Key extends keyof PodState>(key: Key, value: PodState[Key]): PodChange {
  return (pod): void => {
    pod[key] = value;
  };
}
function bumpPod(key: "generation" | "revision"): PodChange {
  return (pod): void => {
    pod[key] += 1;
  };
}

interface Harness {
  readonly pods: CodingJiraPods;
  readonly pod: PodState;
  readonly http: ReturnType<typeof vi.fn<AtlassianHttpBodyPort>>;
  readonly records: ServerLogEvent[];
  readonly context: ManagedMcpInvocationContext;
  readonly recover: ReturnType<typeof vi.fn<() => void>>;
  readonly begun: string[];
  readonly dispatched: ReturnType<typeof vi.fn<() => boolean>>;
  readonly released: ReturnType<typeof vi.fn<() => void>>;
  readonly state: SyntheticJira;
  readonly tokenHeaderSeen: string[];
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const EDIT_TEMPLATE = [
  "---",
  "keiko: jira-issue-template",
  "version: 1",
  "project: SYN",
  "issueType: Story",
  "activateOn: [edit]",
  "summaryMinLength: 40",
  "---",
  "# Story",
].join("\n");

function templateStore(template: string | undefined): CodingJiraPodDeps["store"] {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  const store = buildUiStoreOverDatabase(db);
  cleanup.push(() => {
    store.close();
    return Promise.resolve();
  });
  if (template !== undefined) {
    store.markdownSkills.import({
      fileName: "story-template.md",
      contentBase64: Buffer.from(template).toString("base64"),
    });
  }
  return store;
}

function harness(
  options: {
    readonly attach?: boolean;
    readonly template?: string;
    readonly failSerializationLog?: boolean;
  } = {},
): Harness {
  const pod: PodState = {
    generation: 3,
    revision: 1,
    status: "ok",
    owner: ownerOf(PRINCIPAL),
    deleted: false,
  };
  const state: SyntheticJira = {
    fields: {
      summary: "Fix it",
      project: { key: "SYN" },
      issuetype: { id: "10001", name: "Story" },
      assignee: { name: "previous-user" },
      status: { id: "1" },
      labels: [],
    },
    comment: "",
  };
  const http = vi.fn<AtlassianHttpBodyPort>((request: AtlassianHttpBodyRequest) => {
    const path = new URL(request.url).pathname.replace("/context/rest/api/2/", "");
    const result: AtlassianHttpBodyResult =
      request.method === "GET"
        ? fixtureRead(`/${path}`, state)
        : fixtureWrite(`/${path}`, request.bodyJson, state);
    return Promise.resolve(result);
  });
  const tokenHeaderSeen: string[] = [];
  const records: ServerLogEvent[] = [];
  const log: ServerLogSink = {
    write: (event) => {
      records.push(event);
      if (options.failSerializationLog === true && event.extra?.action === "serialize-description")
        throw new Error("Synthetic serialization audit failure");
    },
  };
  const pods = createCodingJiraPods(log);
  const deps: CodingJiraPodDeps = {
    store: templateStore(options.template),
    serverPrincipal: () => PRINCIPAL,
    atlassianConnectorCredentials: {
      custody: {
        list: () => (pod.deleted ? [] : [metadata(pod)]),
      } as unknown as NonNullable<CodingJiraPodDeps["atlassianConnectorCredentials"]>["custody"],
      httpBodyPortFactory: (_metadata, _correlation, lifecycle) => async (request) => {
        if (lifecycle?.beforeDispatch?.(request) === false) return { kind: "network-error" };
        tokenHeaderSeen.push(TOKEN);
        const result = await http(request);
        if (result.kind === "response") lifecycle?.onResponse?.(request, result.status);
        return result;
      },
    },
  };
  if (options.attach !== false) pods.attach(deps);
  const begun: string[] = [];
  const dispatched = vi.fn(() => true);
  const released = vi.fn<() => void>();
  const recover = vi.fn<() => void>();
  const context: ManagedMcpInvocationContext = {
    invocationId: "invocation-1",
    correlationId: "run-jira-1",
    signal: new AbortController().signal,
    beforeEffect: () => true,
    onUncertainMutation: recover,
    beginReadCapture: () => ({
      invocationId: "mcp-read-synthetic",
      retainProviderResult: (result) => result,
      retainLocalFailure: () => undefined,
      retainRelayFailure: () => undefined,
      release: () => undefined,
    }),
    beginMutation: ({ toolName }) => {
      begun.push(toolName);
      return {
        invocationId: "durable-native-call",
        dispatch: dispatched,
        release: released,
        acknowledge: () => undefined,
        fail: () => undefined,
      };
    },
  };
  cleanup.push(() => pods.close());
  return {
    pods,
    pod,
    http,
    records,
    context,
    recover,
    begun,
    dispatched,
    released,
    state,
    tokenHeaderSeen,
  };
}

function runAuthority(h: Harness): CodingJiraRunAuthority {
  return {
    runId: h.context.correlationId,
    catalogFits: () => true,
    currentScopes: () => ["issue-tracker.read", "issue-tracker.write", "issue-tracker.admin"],
  };
}

function retainingHarness(h: Harness): Harness & {
  readonly retained: ManagedMcpToolResult[];
  readonly localFailures: string[];
  readonly capture: ReturnType<
    typeof vi.fn<(result: ManagedMcpToolResult) => ManagedMcpToolResult>
  >;
} {
  const retained: ManagedMcpToolResult[] = [];
  const localFailures: string[] = [];
  const capture = vi.fn((result: ManagedMcpToolResult) => {
    retained.push(result);
    return result;
  });
  const context: ManagedMcpInvocationContext = {
    ...h.context,
    beginReadCapture: (request) => {
      expect(request.localProvider).toBe("jira");
      const read = h.context.beginReadCapture?.(request);
      if (read === undefined) throw new Error("Expected private read capture");
      return {
        ...read,
        retainProviderResult: capture,
        retainLocalFailure: (reason): void => {
          localFailures.push(reason);
        },
      };
    },
    beginMutation: (request) => {
      expect(request.localProvider).toBe("jira");
      const permit = h.context.beginMutation?.(request);
      if (permit === undefined) throw new Error("Expected native mutation permit");
      return {
        ...permit,
        retainProviderResult: capture,
        retainLocalFailure: (reason): void => {
          localFailures.push(reason);
        },
      };
    },
  };
  return { ...h, context, retained, capture, localFailures };
}

function bound(h: Harness): CodingJiraPodBinding {
  const resolution = h.pods.resolve(POD);
  if (!resolution.ok) throw new Error(`unexpected refusal ${resolution.reason}`);
  return resolution.binding;
}

interface RpcResult {
  readonly content?: readonly { readonly text?: string }[];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
  readonly tools?: readonly { readonly name: string; readonly description?: string }[];
  readonly instructions?: string;
}
interface Client {
  readonly initialize: () => Promise<RpcResult>;
  readonly list: () => Promise<readonly string[]>;
  readonly descriptions: () => Promise<readonly string[]>;
  readonly call: (name: string, args: Record<string, unknown>) => Promise<RpcResult>;
  readonly rawCall: (name: string, args: Record<string, unknown>) => Promise<RpcResult>;
  readonly select: (identities: readonly string[]) => Promise<RpcResult>;
  readonly notifications: string[];
}

// The relay's wire as the runtime's own client speaks it: stateless Streamable HTTP JSON-RPC.
function connect(h: Harness, connections: CodingJiraConnections): Client {
  let id = 0;
  const notifications: string[] = [];
  const rpc = async (method: string, params: unknown): Promise<RpcResult> => {
    const reply = await connections.serve(
      "jira",
      new Request("https://relay.example.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-03-26",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      }),
      h.context,
    );
    const text = await reply.text();
    const messages = text.startsWith("{")
      ? [text]
      : text
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6));
    const frames = messages.map(
      (json) => JSON.parse(json) as { result?: RpcResult; error?: unknown; method?: string },
    );
    for (const frame of frames) if (frame.method !== undefined) notifications.push(frame.method);
    const parsed = frames.find((frame) => frame.result !== undefined || frame.error !== undefined);
    if (parsed?.result === undefined) return { isError: true };
    return parsed.result;
  };
  return {
    notifications,
    initialize: () =>
      rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "coding-jira-test", version: "1" },
      }),
    list: async () => (await rpc("tools/list", {})).tools?.map((tool) => tool.name) ?? [],
    descriptions: async () =>
      (await rpc("tools/list", {})).tools?.map((tool) => tool.description ?? "") ?? [],
    rawCall: (name, args) => rpc("tools/call", { name, arguments: args }),
    select: (identities) => rpc("tools/call", { name: "jira.describe", arguments: { identities } }),
    // Existing native lifecycle cases explicitly traverse the same describe -> typed call path.
    call: async (name, args): Promise<RpcResult> => {
      const definition = jiraOperationDefinitions().find((entry) => entry.tool === name);
      if (definition !== undefined) {
        const selection = await rpc("tools/call", {
          name: "jira.describe",
          arguments: { identities: [definition.identity] },
        });
        if (selection.isError === true) return selection;
      }
      return rpc("tools/call", { name, arguments: args });
    },
  };
}

function proofLines(h: Harness): readonly Readonly<Record<string, unknown>>[] {
  return h.records
    .filter((record) => record.op === "coding-runtime.jira-pod")
    .map((record) =>
      expectActivityLogProof(
        "coding-runtime.jira-pod.emitted-line",
        formatActivityLogProofLine(record),
      ),
    );
}

describe("resolving the Pod the human chose", () => {
  it("binds the caller's own, ready Pod to its exact credential identity", () => {
    const h = harness();
    expect(h.pods.resolve(POD)).toEqual({
      ok: true,
      binding: { podId: POD, authenticationGeneration: 3, verificationRevision: 1 },
    });
  });

  const REFUSALS: readonly (readonly [string, PodChange, "pod-not-found" | "pod-not-ready"])[] = [
    ["a Pod owned by another principal", setPod("owner", ownerOf("someone-else")), "pod-not-found"],
    ["a Pod that does not exist", setPod("deleted", true), "pod-not-found"],
    ["a Pod whose connection is unverified", setPod("status", "unverified"), "pod-not-ready"],
    ["a Pod with unfinished custody work", setPod("operation", "delete"), "pod-not-ready"],
  ];

  it.each(REFUSALS)("refuses %s with a closed reason", (_name, change, reason) => {
    const h = harness();
    change(h.pod);
    expect(h.pods.resolve(POD)).toEqual({ ok: false, reason });
  });

  it("is unavailable until the custody graph is attached", () => {
    expect(harness({ attach: false }).pods.resolve(POD)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("logs the binding decision with closed values and no Pod identity", () => {
    const h = harness();
    h.pods.recordBind(
      "run-jira-1",
      { outcome: "bound" },
      runAuthority(h).currentScopes("discovery"),
    );
    h.pods.recordBind("run-jira-2", { outcome: "refused", reason: "pod-not-ready" });
    const [bound_, refused] = proofLines(h);
    expect(bound_).toMatchObject({
      op: "coding-runtime.jira-pod",
      correlationId: "run-jira-1",
      action: "bind",
      outcome: "bound",
      toolCount: Object.keys(CODING_JIRA_TOOL_RISKS).length - 2,
    });
    expect(refused).toMatchObject({
      correlationId: "run-jira-2",
      action: "bind",
      outcome: "refused",
      reason: "pod-not-ready",
      level: "warn",
    });
    expect(JSON.stringify([bound_, refused])).not.toContain(POD);
  });
});

describe("serving the bound Pod through the relay", () => {
  it("delegates every other server to the operator's managed connections", async () => {
    const h = harness();
    const base = {
      generation: vi.fn(() => new AbortController().signal),
      serve: vi.fn(() => Promise.resolve(new Response("ok"))),
    };
    const connections = h.pods.connections(base, bound(h), runAuthority(h));
    const other = { name: "wiki", enabled: true } as never;
    connections.generation(other, "run-jira-1");
    await connections.serve("wiki", new Request("https://x.invalid/mcp"), h.context);
    expect(base.generation).toHaveBeenCalledOnce();
    expect(base.serve).toHaveBeenCalledOnce();
    expect(h.http).not.toHaveBeenCalled();
  });

  it("fails closed for another server when the run has no managed connections", async () => {
    const h = harness();
    const connections = h.pods.connections(undefined, bound(h), runAuthority(h));
    await expect(
      connections.serve("wiki", new Request("https://x.invalid/mcp"), h.context),
    ).rejects.toBeInstanceOf(ManagedMcpError);
  });

  // Pin (#4178): the rules every Jira tool shares reach the runtime once, as the server's MCP
  // instructions, instead of in each tool description of the list it receives on every round.
  it("gives the shared Jira rules once as server instructions, not in each tool", async () => {
    const h = harness();
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    expect((await client.initialize()).instructions).toBe(JIRA_TOOL_GUIDANCE);
    const descriptions = await client.descriptions();
    expect(descriptions).toHaveLength(2);
    for (const description of descriptions)
      expect(description).not.toMatch(/untrusted data|Data Center only|Never retry/u);
  });

  it("starts with only local discovery, then replaces the exact selected typed tools", async () => {
    const h = harness();
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    expect(await client.list()).toEqual(["jira.discover", "jira.describe"]);
    expect(await client.rawCall("jira.projects", {})).toMatchObject({ isError: true });
    expect(await client.select(["GET /rest/api/2/project"])).not.toHaveProperty("isError", true);
    expect(await client.list()).toEqual(["jira.discover", "jira.describe", "jira.projects"]);
    expect(client.notifications).toEqual(["notifications/tools/list_changed"]);
    await client.select(["GET /rest/api/2/issue/{issueIdOrKey}"]);
    expect(await client.list()).toEqual(["jira.discover", "jira.describe", "jira.issue"]);
    await client.select([]);
    expect(await client.list()).toEqual(["jira.discover", "jira.describe"]);
    expect(h.http).not.toHaveBeenCalled();
  });

  it("pages only admitted metadata without inventing native history or mutation receipts", async () => {
    const h = retainingHarness(harness());
    const client = connect(
      h,
      h.pods.connections(undefined, bound(h), {
        runId: h.context.correlationId,
        catalogFits: () => true,
        currentScopes: () => ["issue-tracker.read"],
      }),
    );
    const first = await client.rawCall("jira.discover", { maxResults: 1 });
    expect(first.structuredContent).toMatchObject({
      startAt: 0,
      nextStartAt: 1,
      items: [expect.any(Object)],
    });
    const second = await client.rawCall("jira.discover", { startAt: 1, maxResults: 1 });
    expect(second.structuredContent).toMatchObject({ startAt: 1, nextStartAt: 2 });
    expect(second.structuredContent?.items).not.toEqual(first.structuredContent?.items);
    await client.select(["GET /rest/api/2/project"]);
    expect(h.http).not.toHaveBeenCalled();
    expect(h.retained).toEqual([]);
    expect(h.begun).toEqual([]);
    expect(h.recover).not.toHaveBeenCalled();
  });

  it("opens the real MCP Pod before provider usage exists and refuses only schema expansion", async () => {
    const h = retainingHarness(harness());
    let fits: boolean | undefined;
    const client = connect(
      h,
      h.pods.connections(undefined, bound(h), {
        ...runAuthority(h),
        catalogFits: () => fits,
      }),
    );
    expect(await client.list()).toEqual(["jira.discover", "jira.describe"]);
    expect(
      (await client.rawCall("jira.discover", { maxResults: 1 })).structuredContent,
    ).toMatchObject({ outcome: "succeeded" });
    expect((await client.select(["GET /rest/api/2/project"])).structuredContent).toMatchObject({
      outcome: "failed",
      reason: "selection-unavailable",
    });
    expect(await client.list()).toEqual(["jira.discover", "jira.describe"]);
    expect(client.notifications).toEqual([]);
    fits = true;
    await client.select(["GET /rest/api/2/project"]);
    expect(await client.list()).toContain("jira.projects");
    fits = false;
    expect(
      (await client.select(["GET /rest/api/2/issue/{issueIdOrKey}"])).structuredContent,
    ).toMatchObject({ outcome: "failed", reason: "budget-exhausted" });
    expect(await client.list()).toContain("jira.projects");
    expect(client.notifications).toEqual(["notifications/tools/list_changed"]);
    expect(h.http).not.toHaveBeenCalled();
    expect(h.retained).toEqual([]);
    expect(h.begun).toEqual([]);
  });

  // #4176: an attachment reads Chat-connected files, which a Coding run has no authority over, so
  // the tool is neither offered nor defaulted to a risk; a call to it never reaches Jira.
  it("neither offers nor accepts jira.attach and never touches Jira for it", async () => {
    const h = harness();
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    expect(await client.list()).not.toContain("jira.attach");
    expect(CODING_JIRA_TOOL_RISKS).not.toHaveProperty("jira.attach");
    await expect(
      client.call("jira.attach", {
        issueKey: "SYN-1",
        source: { kind: "connected-file", path: "docs/report.txt" },
      }),
    ).resolves.toMatchObject({ isError: true });
    expect(h.http).not.toHaveBeenCalled();
    expect(h.begun).toEqual([]);
  });

  it("reads an issue as untrusted data through the Pod's own transport and logs the call", async () => {
    const h = harness();
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    const result = await client.call("jira.issue", { issueKey: "SYN-1" });
    expect(result).toMatchObject({ structuredContent: { outcome: "succeeded" } });
    expect(JSON.stringify(result)).toContain("SYN-1");
    expect(h.http).toHaveBeenCalled();
    expect(
      h.http.mock.calls.every(([request]) => request.url.startsWith(`${BASE_URL}/rest/api/2/`)),
    ).toBe(true);
    const lines = proofLines(h);
    expect(lines).toEqual([
      expect.objectContaining({
        correlationId: "run-jira-1",
        action: "call",
        outcome: "completed",
        toolClass: "jira-read",
        toolDigest: createHash("sha256").update("jira.issue").digest("hex"),
        risk: "read",
      }),
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/SYN-1|jira\.example|Fix it/u);
  });

  it("binds a report to the Pod and logs it on the run's correlation (jira.report)", async () => {
    const h = harness();
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    const first = await client.call("jira.report", { jql: "project = SYN" });
    const id = first.structuredContent?.reportId;
    expect(typeof id).toBe("string");
    const second = await client.call("jira.report", { reportId: id });
    expect(second.structuredContent).toMatchObject({ outcome: "succeeded", reportId: id });
    const lines = h.records.filter((record) => record.op === "atlassian.jira-report");
    expect(lines).toHaveLength(2);
    for (const record of lines) {
      const line = expectActivityLogProof(
        "atlassian.jira-report.line",
        formatActivityLogProofLine(record),
      );
      expect(line).toMatchObject({ correlationId: "run-jira-1", phase: "read", scopeKind: "jql" });
      expect(JSON.stringify(line)).not.toMatch(/SYN|jira\.example/u);
    }
  });

  it("comments on the ticket after the relay's durable mutation permit, and reports the receipt", async () => {
    const h = harness();
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    const result = await client.call("jira.comment", {
      issueKey: "SYN-1",
      body: "Implemented in the draft pull request",
    });
    expect(h.begun).toEqual(["jira.comment"]);
    expect(result).toMatchObject({
      structuredContent: { outcome: "succeeded", issueKey: "SYN-1", commentId: "10002" },
    });
    expect(h.http.mock.calls.filter(([request]) => request.method !== "GET")).toHaveLength(1);
    expect(h.state.comment).toBe("Implemented in the draft pull request");
    expect(h.recover).not.toHaveBeenCalled();
    expect(proofLines(h)).toEqual([
      expect.objectContaining({
        toolClass: "jira-write",
        toolDigest: createHash("sha256").update("jira.comment").digest("hex"),
        risk: "write",
        outcome: "completed",
      }),
    ]);
  });

  const THREE_LINKS = ["SYN-7", "SYN-8", "SYN-9"].map((issueKey) => ({
    type: "Relates",
    direction: "outward",
    issueKey,
  }));
  it("links several issues through separate calls and counts them on its one line (#4176)", async () => {
    const h = harness();
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    const result = await client.call("jira.edit", { issueKey: "SYN-1", links: THREE_LINKS });
    expect(result).toMatchObject({
      structuredContent: { outcome: "succeeded", issueKey: "SYN-1", linksRequested: 3 },
    });
    const writes = h.http.mock.calls
      .filter(([request]) => request.method !== "GET")
      .map(([request]) => new URL(request.url).pathname.replace(/^.*\/api\/2\//u, ""));
    expect(writes).toEqual(["issue/SYN-1", "issueLink", "issueLink"]);
    expect(proofLines(h)).toEqual([
      expect.objectContaining({
        toolClass: "jira-write",
        toolDigest: createHash("sha256").update("jira.edit").digest("hex"),
        outcome: "completed",
        linkRequestedCount: 3,
        linkCreatedCount: 3,
        linkFailedCount: 0,
      }),
    ]);
  });

  it("treats a partial link effect as an uncertain mutation and counts it, never retrying (#4176)", async () => {
    const h = harness();
    const dispatch = h.http.getMockImplementation();
    h.http.mockImplementation((request) =>
      request.url.endsWith("/issueLink")
        ? Promise.resolve(response({ errorMessages: ["No permission"], errors: {} }, 403))
        : (dispatch?.(request) ?? Promise.resolve(response({}, 404))),
    );
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    const result = await client.call("jira.edit", { issueKey: "SYN-1", links: THREE_LINKS });
    // A failed write is not delivered as data in a Coding run: the relay marks the permit failed
    // and hands the run to the existing uncertain-mutation recovery.
    expect(result).toMatchObject({ isError: true });
    expect(h.recover).toHaveBeenCalledOnce();
    const writes = h.http.mock.calls.filter(([request]) => request.method !== "GET");
    expect(writes.map(([request]) => new URL(request.url).pathname.split("/").at(-1))).toEqual([
      "SYN-1",
      "issueLink",
    ]);
    expect(proofLines(h)).toEqual([
      expect.objectContaining({
        outcome: "failed",
        reason: "tool-failed",
        linkRequestedCount: 3,
        linkCreatedCount: 1,
        linkFailedCount: 2,
        level: "warn",
      }),
    ]);
    expect(JSON.stringify(proofLines(h))).not.toMatch(/SYN-/u);
  });

  it("transitions the ticket", async () => {
    const h = harness();
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    const result = await client.call("jira.transition", {
      issueKey: "SYN-1",
      transitionId: "31",
      fields: { customfield_10000: "done" },
    });
    expect(result).toMatchObject({
      structuredContent: { outcome: "succeeded", transitionId: "31" },
    });
  });

  it("hands the model a failed read as data, not as a broken run", async () => {
    const h = retainingHarness(harness());
    h.http.mockResolvedValue(response({}, 403));
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    const result = await client.call("jira.issue", { issueKey: "SYN-1" });
    expect(result).toMatchObject({ isError: true, structuredContent: { outcome: "failed" } });
    expect(h.retained).toEqual([{ data: result.structuredContent, isError: true }]);
    expect(h.begun).toEqual([]);
    expect(h.recover).not.toHaveBeenCalled();
    expect(proofLines(h)).toEqual([
      expect.objectContaining({ outcome: "failed", reason: "tool-failed", level: "warn" }),
    ]);
    const fact = h.records.find(({ op }) => op === "jira.operation.issues");
    expect(
      expectActivityLogProof("jira.operation.issues.line", formatActivityLogProofLine(fact ?? {})),
    ).toMatchObject({
      operation: "jira.issue",
      stage: "coding-call",
      outcome: "failed",
      reason: "tool-failed",
    });
  });

  it("keeps an exact typed write fact when native prerequisite permission denies the effect", async () => {
    const h = retainingHarness(harness());
    h.http.mockResolvedValue(
      response({ errorMessages: ["Synthetic denied prerequisite"], errors: {} }, 403),
    );
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    const result = await client.call("jira.edit", {
      issueKey: "SYN-1",
      fields: { summary: "Synthetic private summary" },
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { reason: "permission-denied" },
    });
    expect(h.http.mock.calls.map(([request]) => [request.method, request.url])).toEqual([
      ["GET", "https://jira.example.invalid/context/rest/api/2/issue/SYN-1/editmeta"],
    ]);
    expect(h.dispatched).not.toHaveBeenCalled();
    expect(h.released).toHaveBeenCalledOnce();
    expect(h.recover).not.toHaveBeenCalled();
    const fact = h.records.find(({ op }) => op === "jira.operation.core");
    const line = formatActivityLogProofLine(fact ?? {});
    expect(expectActivityLogProof("jira.operation.core.line", line)).toMatchObject({
      operation: "jira.edit",
      stage: "coding-call",
      outcome: "failed",
      reason: "tool-failed",
    });
    expect(line).not.toMatch(/SYN-1|Synthetic|commentBody|jira\.example|synthetic-pod-token/u);
  });

  it("retains validated issue reads without acquiring an effect permit", async () => {
    const h = retainingHarness(harness());
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    const result = await client.call("jira.issue", { issueKey: "SYN-1" });
    expect(h.retained).toEqual([{ data: result.structuredContent }]);
    expect(h.retained[0]?.data).toMatchObject({ outcome: "succeeded", items: [{ key: "SYN-1" }] });
    expect(h.begun).toEqual([]);
    expect(h.dispatched).not.toHaveBeenCalled();
    expect(h.recover).not.toHaveBeenCalled();
  });

  it("records a technical read exception once through the existing failure owner without exposing its body", async () => {
    const h = retainingHarness(harness());
    const privateMessage = "Synthetic private provider exception body";
    h.http.mockRejectedValue(new TypeError(privateMessage));
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    const result = await client.call("jira.issue", { issueKey: "SYN-1" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(h.retained).toEqual([]);
    expect(h.begun).toEqual([]);
    expect(h.recover).not.toHaveBeenCalled();
    expect(proofLines(h)).toEqual([
      expect.objectContaining({ outcome: "failed", reason: "internal", level: "warn" }),
    ]);
    expect(JSON.stringify([result, h.records])).not.toContain(privateMessage);
  });

  it("retains a closed read scope refusal without inventing Jira data or an effect", async () => {
    const h = retainingHarness(harness());
    let admitted = true;
    const client = connect(
      h,
      h.pods.connections(undefined, bound(h), {
        runId: h.context.correlationId,
        catalogFits: () => true,
        currentScopes: (phase) => (phase === "discovery" || admitted ? ["issue-tracker.read"] : []),
      }),
    );
    expect(await client.select(["GET /rest/api/2/issue/{issueIdOrKey}"])).not.toHaveProperty(
      "isError",
      true,
    );
    admitted = false;
    const result = await client.rawCall("jira.issue", { issueKey: "SYN-1" });
    expect(result.isError).toBe(true);
    expect(h.localFailures).toEqual(["connector-scope-missing"]);
    expect(h.retained).toEqual([]);
    expect(h.http).not.toHaveBeenCalled();
    expect(h.begun).toEqual([]);
    expect(h.recover).not.toHaveBeenCalled();
  });

  it("refuses read delivery on capture failure without creating a write recovery state", async () => {
    const h = retainingHarness(harness());
    h.capture.mockImplementation(() => {
      throw new Error("Synthetic durable store unavailable");
    });
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    const result = await client.call("jira.issue", { issueKey: "SYN-1" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(h.capture).toHaveBeenCalledOnce();
    expect(h.begun).toEqual([]);
    expect(h.recover).not.toHaveBeenCalled();
  });
});

describe("the customer's issue templates bind a Coding run's Jira writes (#4177)", () => {
  const writes = (h: Harness): number =>
    h.http.mock.calls.filter(([request]) => request.method !== "GET").length;

  it("hands its validated success receipt to the private capture owner before returning it", async () => {
    const h = retainingHarness(harness());
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    const result = await client.call("jira.comment", {
      issueKey: "SYN-1",
      body: "Synthetic comment",
    });
    expect(h.retained).toHaveLength(1);
    expect(h.retained[0]?.data).toMatchObject({
      outcome: "succeeded",
      issueKey: "SYN-1",
      commentId: "10002",
    });
    const operationBinding = h.retained[0]?.data.operationBinding;
    if (
      operationBinding === null ||
      typeof operationBinding !== "object" ||
      Array.isArray(operationBinding) ||
      !("identity" in operationBinding) ||
      !("contractDigest" in operationBinding)
    )
      throw new TypeError("Missing retained operation binding");
    expect(typeof operationBinding.identity).toBe("string");
    expect(typeof operationBinding.contractDigest).toBe("string");
    expect(result.structuredContent).toEqual(h.retained[0]?.data);
    expect(writes(h)).toBe(1);
  });

  it("enters recovery instead of delivering success when durable capture throws after HTTP ACK", async () => {
    const h = retainingHarness(harness());
    h.capture.mockImplementation(() => {
      throw new Error("Synthetic durable store unavailable");
    });
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    const result = await client.call("jira.comment", {
      issueKey: "SYN-1",
      body: "Synthetic comment",
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(writes(h)).toBe(1);
    expect(h.capture).toHaveBeenCalledOnce();
    expect(h.released).not.toHaveBeenCalled();
    expect(h.recover).toHaveBeenCalledOnce();
  });

  it("retains a known tool's local scope refusal without inventing a native Jira permission result", async () => {
    const h = retainingHarness(harness());
    let admitted = true;
    const client = connect(
      h,
      h.pods.connections(undefined, bound(h), {
        runId: h.context.correlationId,
        catalogFits: () => true,
        currentScopes: (phase) =>
          phase === "discovery" || admitted
            ? ["issue-tracker.read", "issue-tracker.write"]
            : ["issue-tracker.read"],
      }),
    );
    expect(
      await client.select(["POST /rest/api/2/issue/{issueIdOrKey}/comment"]),
    ).not.toHaveProperty("isError", true);
    admitted = false;
    const result = await client.rawCall("jira.comment", {
      issueKey: "SYN-1",
      body: "Synthetic comment",
    });
    expect(h.localFailures).toEqual(["connector-scope-missing"]);
    expect(h.retained).toEqual([]);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("connector access");
    expect(h.http).not.toHaveBeenCalled();
    expect(h.released).toHaveBeenCalledOnce();
    expect(h.recover).not.toHaveBeenCalled();
  });

  it("retains known comment identity when scope is revoked after ACK and before readback", async () => {
    const h = retainingHarness(harness());
    let scopes: readonly CodingWorkbenchConnectorScope[] = [
      "issue-tracker.read",
      "issue-tracker.write",
    ];
    const transport = h.http.getMockImplementation();
    if (transport === undefined) throw new Error("Expected Jira transport");
    h.http.mockImplementation(async (request) => {
      const response = await transport(request);
      if (request.method === "POST") scopes = ["issue-tracker.read"];
      return response;
    });
    const client = connect(
      h,
      h.pods.connections(undefined, bound(h), {
        runId: h.context.correlationId,
        catalogFits: () => true,
        currentScopes: () => scopes,
      }),
    );
    const result = await client.call("jira.comment", {
      issueKey: "SYN-1",
      body: "Synthetic comment",
    });
    expect(h.retained).toMatchObject([
      {
        isError: true,
        data: {
          outcome: "succeeded-unconfirmed",
          issueKey: "SYN-1",
          commentId: "10002",
        },
      },
    ]);
    expect(h.localFailures).toEqual([]);
    expect(result.isError).toBe(true);
    expect(writes(h)).toBe(1);
    expect(h.released).not.toHaveBeenCalled();
    expect(h.recover).toHaveBeenCalledOnce();
  });

  it("keeps template correction data readable and releases only a never-dispatched call", async () => {
    const h = retainingHarness(harness({ template: EDIT_TEMPLATE }));
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    const result = await client.call("jira.edit", {
      issueKey: "SYN-1",
      fields: { summary: "Updated" },
    });
    expect(result.isError).toBe(true);
    expect(h.retained).toHaveLength(1);
    expect(result.structuredContent).toEqual(h.retained[0]?.data);
    expect(result.structuredContent).toMatchObject({
      outcome: "rejected",
      reason: "field-validation",
      violations: [
        { ruleId: "summary-too-short", subject: "at least 40 characters", template: "SYN/Story" },
      ],
    });
    expect(result.structuredContent?.violations).toEqual([
      { ruleId: "summary-too-short", subject: "at least 40 characters", template: "SYN/Story" },
    ]);
    expect(result.structuredContent?.guidance).toBe(
      jiraTemplateViolationGuidance([
        { ruleId: "summary-too-short", subject: "at least 40 characters", template: "SYN/Story" },
      ]),
    );
    expect(writes(h)).toBe(0);
    expect(h.dispatched).not.toHaveBeenCalled();
    expect(h.released).toHaveBeenCalledOnce();
    expect(h.recover).not.toHaveBeenCalled();
  });

  function descriptionTransport(h: Harness, refuseWrite = false): void {
    const original = h.http.getMockImplementation();
    if (original === undefined) throw new TypeError("Missing Jira transport");
    h.http.mockImplementation((request) => {
      if (request.method === "GET" && request.url.endsWith("/editmeta"))
        return Promise.resolve(
          response({ fields: { description: field("description", "string") } }),
        );
      if (refuseWrite && request.method === "PUT")
        return Promise.resolve(
          response({ errorMessages: ["Synthetic write refusal"], errors: {} }, 403),
        );
      return original(request);
    });
  }

  it("records body-only Markdown projection without content or a fabricated heading count", async () => {
    const h = harness();
    h.state.fields.description = null;
    descriptionTransport(h);
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    const result = await client.call("jira.edit", {
      issueKey: "SYN-1",
      fields: { description: { format: "markdown", text: "**Exact body**" } },
    });
    expect(result).toMatchObject({ structuredContent: { outcome: "succeeded" } });
    expect(h.state.fields.description).toBe("*Exact body*");
    const evidence = proofLines(h).find((line) => line.action === "serialize-description");
    expect(evidence).toMatchObject({
      descriptionProjection: "supported-markdown",
      outcome: "completed",
    });
    expect(evidence).not.toHaveProperty("descriptionConvertedHeadingCount");
    expect(JSON.stringify(evidence)).not.toMatch(/Exact body|SYN-1/u);
    expect(result.structuredContent).not.toHaveProperty("descriptionProjection");
  });

  it("preserves a confirmed write when its serialization audit sink throws", async () => {
    const h = harness({ failSerializationLog: true });
    // Jira includes an unset selected description as null, allowing before/after confirmation.
    h.state.fields.description = null;
    descriptionTransport(h);
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    const result = await client.call("jira.edit", {
      issueKey: "SYN-1",
      fields: { description: { format: "markdown", text: "## Goal\nKept content." } },
    });
    expect(result).toMatchObject({
      structuredContent: { outcome: "succeeded", issueKey: "SYN-1" },
    });
    expect(writes(h)).toBe(1);
    expect(h.state.fields.description).toBe("h2. Goal\nKept content.");
    expect(h.recover).not.toHaveBeenCalled();
    expect(
      h.records.filter((event) => event.extra?.action === "serialize-description"),
    ).toHaveLength(1);
  });

  it("does not log a refused formatted write as completed", async () => {
    const h = harness();
    descriptionTransport(h, true);
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    const result = await client.call("jira.edit", {
      issueKey: "SYN-1",
      fields: { description: { format: "markdown", text: "## Goal\nKept content." } },
    });
    expect(result.isError).toBe(true);
    expect(writes(h)).toBe(1);
    expect(h.state.fields).not.toHaveProperty("description");
    expect(proofLines(h).find((line) => line.action === "serialize-description")).toMatchObject({
      outcome: "failed",
      descriptionConvertedHeadingCount: 1,
    });
  });

  it("refuses an edit that leaves the issue violating its template, before any PUT", async () => {
    const h = harness({ template: EDIT_TEMPLATE });
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    const result = await client.call("jira.edit", {
      issueKey: "SYN-1",
      fields: { summary: "Too short" },
    });
    // The relay hands the model a generic tool error for any refused write; the point here is
    // that the gate held: the same edit without a template (below) is sent.
    expect(result.isError).toBe(true);
    expect(writes(h)).toBe(0);
  });

  it("lets the same edit through when no template governs it", async () => {
    const h = harness();
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    await client.call("jira.edit", { issueKey: "SYN-1", fields: { summary: "Too short" } });
    expect(writes(h)).toBe(1);
  });

  describe("the dry run before the human is asked (#4354 L4)", () => {
    const LONG_SUMMARY =
      "A summary that is long enough for the forty character minimum of the rule";

    it("hands the model the refusal of a write that breaks a template and sends nothing", async () => {
      const h = harness({ template: EDIT_TEMPLATE });
      const refusal = await h.pods.preflightWrite(bound(h), runAuthority(h), {
        tool: "jira.edit",
        arguments: { issueKey: "SYN-1", fields: { summary: "Too short" } },
      });
      expect(refusal).toContain("Nothing was changed");
      expect(refusal).toContain("summary");
      expect(writes(h)).toBe(0);
    });

    it("logs the refusal on the template admission line, pre-approval, under the run's correlation", async () => {
      const sink = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink, level: "debug" }));
      try {
        const h = harness({ template: EDIT_TEMPLATE });
        await h.pods.preflightWrite(bound(h), runAuthority(h), {
          tool: "jira.edit",
          arguments: { issueKey: "SYN-1", fields: { summary: "Too short" } },
        });
        const events = sink.events.filter(({ op }) => op === "jira.template.admission");
        expect(events).toHaveLength(1);
        expect(events[0]?.correlationId).toBe(runAuthority(h).runId);
        expect(events[0]?.extra).toMatchObject({
          operation: "jira.edit",
          stage: "pre-approval",
          ruleIds: ["summary-too-short"],
        });
      } finally {
        resetServerLogger();
      }
    });

    it("logs a refusal by Keiko's own field validation, which has no violations, on the field admission line", async () => {
      const sink = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink, level: "debug" }));
      try {
        const h = harness();
        const refusal = await h.pods.preflightWrite(bound(h), runAuthority(h), {
          tool: "jira.edit",
          arguments: { issueKey: "SYN-1", fields: { notAField: "x" } },
        });
        expect(refusal).toContain('"reason":"field-validation"');
        const events = sink.events.filter(({ op }) => op === "jira.field.admission");
        expect(events).toHaveLength(1);
        expect(events[0]?.extra).toMatchObject({ stage: "pre-approval", refusedCount: 1 });
        expect(sink.lines().join("\n")).not.toContain("notAField");
      } finally {
        resetServerLogger();
      }
    });

    it("logs an attachment call the release switch refuses before any card, as one closed line", async () => {
      const sink = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink, level: "debug" }));
      try {
        const h = harness();
        const refusal = await h.pods.preflightWrite(bound(h), runAuthority(h), {
          tool: "jira.attach",
          arguments: { issueKey: "SYN-1", fileName: "private-report.txt" },
        });
        expect(refusal).toContain('"reason":"unavailable"');
        const events = sink.events.filter(({ op }) => op.startsWith("jira.operation."));
        expect(events).toHaveLength(1);
        expect(events[0]?.extra).toMatchObject({
          operation: "jira.attach",
          stage: "release-scope",
          outcome: "refused",
          reason: "unavailable",
        });
        expect(sink.lines().join("\n")).not.toContain("private-report");
        expect(writes(h)).toBe(0);
      } finally {
        resetServerLogger();
      }
    });

    it("leaves a conforming write, and a write no template governs, to the human's card", async () => {
      const governed = harness({ template: EDIT_TEMPLATE });
      await expect(
        governed.pods.preflightWrite(bound(governed), runAuthority(governed), {
          tool: "jira.edit",
          arguments: { issueKey: "SYN-1", fields: { summary: LONG_SUMMARY } },
        }),
      ).resolves.toBeUndefined();
      const free = harness();
      await expect(
        free.pods.preflightWrite(bound(free), runAuthority(free), {
          tool: "jira.edit",
          arguments: { issueKey: "SYN-1", fields: { summary: "Too short" } },
        }),
      ).resolves.toBeUndefined();
      expect(writes(governed) + writes(free)).toBe(0);
    });

    it("refuses a creation no template governs, naming the way out, before any card", async () => {
      const h = harness();
      const refusal = await h.pods.preflightWrite(bound(h), runAuthority(h), {
        tool: "jira.create",
        arguments: {
          projectId: "10000",
          issueTypeId: "3",
          fields: { summary: LONG_SUMMARY, customfield_10000: "x" },
        },
      });
      expect(refusal).toContain("template-missing");
      expect(writes(h)).toBe(0);
    });

    it("does nothing for a name that is not a registered Jira write", async () => {
      const h = harness({ template: EDIT_TEMPLATE });
      await expect(
        h.pods.preflightWrite(bound(h), runAuthority(h), {
          tool: "jira.search",
          arguments: { jql: "project = SYN" },
        }),
      ).resolves.toBeUndefined();
      expect(h.http).not.toHaveBeenCalled();
    });
  });

  it("refuses requirement references a Coding run cannot trace, and still writes without them", async () => {
    const h = harness();
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    const refused = await client.call("jira.edit", {
      issueKey: "SYN-1",
      fields: { summary: "Traced" },
      requirementIds: ["UNKNOWN-999"],
    });
    // The relay hands the model a generic tool error for any refused write; the point is that
    // the reference is not silently dropped and nothing is sent.
    expect(refused.isError).toBe(true);
    expect(writes(h)).toBe(0);
    await client.call("jira.edit", { issueKey: "SYN-1", fields: { summary: "Untraced" } });
    expect(writes(h)).toBe(1);
  });

  it("cannot be attached without the skill library that holds the templates", () => {
    const pods = createCodingJiraPods(undefined);
    // @ts-expect-error `store` is required: a Pod wired without it would write unchecked.
    const deps: CodingJiraPodDeps = { serverPrincipal: () => PRINCIPAL };
    expect(deps.store).toBeUndefined();
    expect(pods.resolve(POD)).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("a Pod that is no longer the one the human chose", () => {
  const CHANGES: readonly (readonly [string, PodChange])[] = [
    ["a replaced token (new credential generation)", bumpPod("generation")],
    ["a re-verification", bumpPod("revision")],
    ["a connection that is no longer verified", setPod("status", "unverified")],
    ["a Pod being deleted", setPod("operation", "delete")],
    ["a deleted Pod", setPod("deleted", true)],
    ["a Pod handed to another principal", setPod("owner", ownerOf("someone-else"))],
  ];

  it.each(CHANGES)("refuses reads after %s with zero HTTP", async (_name, change) => {
    const h = harness();
    const connections = h.pods.connections(undefined, bound(h), runAuthority(h));
    const client = connect(h, connections);
    await client.call("jira.issue", { issueKey: "SYN-1" });
    h.http.mockClear();
    change(h.pod);

    await expect(client.rawCall("jira.issue", { issueKey: "SYN-1" })).rejects.toBeInstanceOf(
      ManagedMcpError,
    );
    expect(h.http).not.toHaveBeenCalled();
    expect(proofLines(h).at(-1)).toMatchObject({
      action: "call",
      outcome: "refused",
      reason: "pod-changed",
      level: "warn",
    });
  });

  it.each(CHANGES)("refuses writes after %s without any request", async (_name, change) => {
    const h = harness();
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    change(h.pod);

    await expect(
      client.call("jira.comment", { issueKey: "SYN-1", body: "Too late" }),
    ).rejects.toBeInstanceOf(ManagedMcpError);
    expect(h.http).not.toHaveBeenCalled();
    expect(h.state.comment).toBe("");
  });

  it("refuses the write itself when the Pod changes after the run's own metadata reads", async () => {
    const h = harness();
    const original = h.http.getMockImplementation();
    if (original === undefined) throw new Error("Expected HTTP fixture");
    let reads = 0;
    h.http.mockImplementation(async (request) => {
      const result = await original(request);
      // The token is replaced while the transition's metadata is being read.
      if (request.method === "GET" && ++reads === 1) h.pod.generation += 1;
      return result;
    });
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));

    const result = await client.call("jira.transition", {
      issueKey: "SYN-1",
      transitionId: "31",
      fields: { customfield_10000: "Screen value" },
    });

    expect(result.isError).toBe(true);
    expect(h.http.mock.calls.length).toBeGreaterThan(0);
    expect(h.http.mock.calls.filter(([request]) => request.method !== "GET")).toHaveLength(0);
    expect(h.state.fields.status).toEqual({ id: "1" });
    expect(h.recover).toHaveBeenCalledOnce();
  });

  it("revokes the relay's generation signal and binds no new relay for the old identity", async () => {
    const h = harness();
    const old = bound(h);
    const connections = h.pods.connections(undefined, old, runAuthority(h));
    const server = { name: "jira", enabled: true } as never;
    const signal = connections.generation(server, "run-jira-1");
    expect(signal.aborted).toBe(false);

    h.pod.generation += 1;
    await expect(connect(h, connections).list()).rejects.toBeInstanceOf(ManagedMcpError);
    expect(signal.aborted).toBe(true);
    expect(connections.generation(server, "run-jira-1").aborted).toBe(true);
    // A new run binds the new identity and works again.
    expect(
      h.pods
        .connections(undefined, bound(h), { ...runAuthority(h), runId: "run-jira-2" })
        .generation(server, "run-jira-2").aborted,
    ).toBe(false);
  });
  it("ends the Jira entry with its owning run signal without closing unrelated Pods", async () => {
    const h = harness();
    const controller = new AbortController();
    const authority = { ...runAuthority(h), signal: controller.signal };
    const binding = bound(h);
    const server = codingJiraServerDefinition(binding);
    const connections = h.pods.connections(undefined, binding, authority);
    const signal = connections.generation(server, h.context.correlationId);
    await connect(h, connections).initialize();
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
    await expect(connect(h, connections).list()).rejects.toBeInstanceOf(ManagedMcpError);
    const other = h.pods.connections(undefined, binding, {
      ...runAuthority(h),
      runId: "run-jira-next",
    });
    expect(other.generation(server, "run-jira-next").aborted).toBe(false);
    expect(h.http).not.toHaveBeenCalled();
  });
  it("keeps evicted entries inside the cap until closeRun has awaited their disposal", async () => {
    const h = harness();
    const binding = bound(h);
    const server = codingJiraServerDefinition(binding);
    const generations: AbortSignal[] = [];
    for (let index = 0; index < 8; index += 1) {
      const runId = `capacity-run-${String(index)}`;
      const connections = h.pods.connections(undefined, binding, { ...runAuthority(h), runId });
      generations.push(connections.generation(server, runId));
    }
    const next = h.pods.connections(undefined, binding, {
      ...runAuthority(h),
      runId: "capacity-run-next",
    });
    expect(() => next.generation(server, "capacity-run-next")).toThrow(ManagedMcpError);
    await h.pods.closeRun("capacity-run-0");
    expect(generations[0]?.aborted).toBe(true);
    expect(generations.slice(1).every((signal) => !signal.aborted)).toBe(true);
    expect(next.generation(server, "capacity-run-next").aborted).toBe(false);
    expect(h.http).not.toHaveBeenCalled();
  });

  it("refuses to serve once the application graph is closed", async () => {
    const h = harness();
    const connections = h.pods.connections(undefined, bound(h), runAuthority(h));
    await h.pods.close();
    await expect(
      connections.serve("jira", new Request("https://x.invalid/mcp"), h.context),
    ).rejects.toBeInstanceOf(ManagedMcpError);
  });
});

describe("a write that does not complete", () => {
  it("retains the leaf's acknowledged target receipt when independent Coding readback throws", async () => {
    const h = retainingHarness(harness());
    let written = false;
    h.http.mockImplementation((request) => {
      if (request.method === "POST") {
        written = true;
        return Promise.resolve(response(undefined, 204));
      }
      if (written) return Promise.reject(new TypeError("Synthetic readback failure"));
      return Promise.resolve(response({ enabled: false }));
    });
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    const result = await client.call("jira.set-app-monitoring", {
      enabled: true,
      expectedEnabled: false,
    });
    // The real leaf wraps only this post-ACK exception; the Coding owner validates its receipt.
    // The relay retains the typed result privately, then reports dispatched uncertainty through
    // its existing closed error. It must not return this as an undispatched refusal.
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.stringify(result)).toContain("The change may or may not have been applied");
    expect(h.retained).toHaveLength(1);
    expect(h.retained).toMatchObject([
      {
        isError: true,
        data: {
          outcome: "succeeded-unconfirmed",
          reason: "unavailable",
          monitoringEnabled: true,
        },
      },
    ]);
    expect(h.http.mock.calls.map(([request]) => request.method)).toEqual(["GET", "POST", "GET"]);
    expect(h.dispatched).toHaveBeenCalledOnce();
    expect(h.recover).toHaveBeenCalledOnce();
    expect(h.released).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("Synthetic readback failure");
  });

  it.each(["preflight", "write"] as const)(
    "does not invent ACK or retain an arbitrary receipt on a %s exception",
    async (phase) => {
      const h = retainingHarness(harness());
      h.http.mockImplementation((request) => {
        if (phase === "preflight" || request.method === "POST")
          return Promise.reject(
            Object.assign(new TypeError("Synthetic unacknowledged failure"), {
              receipt: { monitoringEnabled: true },
            }),
          );
        return Promise.resolve(response({ enabled: false }));
      });
      const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
      const result = await client.call("jira.set-app-monitoring", {
        enabled: true,
        expectedEnabled: false,
      });
      const outcome = phase === "preflight" ? "rejected" : "unknown";
      expect(result.isError).toBe(true);
      if (phase === "preflight")
        expect(result.structuredContent).toMatchObject({ outcome, reason: "unavailable" });
      else {
        expect(result.structuredContent).toBeUndefined();
        expect(JSON.stringify(result)).toContain("The change may or may not have been applied");
      }
      expect(h.retained).toHaveLength(1);
      expect(h.retained).toMatchObject([
        { isError: true, data: { outcome, reason: "unavailable" } },
      ]);
      expect(h.retained[0]?.data).not.toHaveProperty("monitoringEnabled");
      expect(h.http.mock.calls.map(([request]) => request.method)).toEqual(
        phase === "preflight" ? ["GET"] : ["GET", "POST"],
      );
      expect(h.recover).toHaveBeenCalledTimes(phase === "preflight" ? 0 : 1);
      expect(h.released).toHaveBeenCalledTimes(phase === "preflight" ? 1 : 0);
    },
  );

  it.each([400, 401, 403, 409, 429, 500])(
    "never treats native HTTP %s as an acknowledged successful write",
    async (status) => {
      const h = retainingHarness(harness());
      h.http.mockImplementation((request) =>
        Promise.resolve(
          request.method === "GET"
            ? fixtureRead(new URL(request.url).pathname.replace("/context/rest/api/2", ""), h.state)
            : response({ errorMessages: ["Native mutation refused"], errors: {} }, status),
        ),
      );
      const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
      const result = await client.call("jira.comment", {
        issueKey: "SYN-1",
        body: "Reviewed comment",
      });
      expect(result.isError).toBe(true);
      expect(h.retained).toMatchObject([{ isError: true, data: { outcome: "unknown" } }]);
      expect(h.http.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
      expect(h.recover).toHaveBeenCalledOnce();
      expect(h.released).not.toHaveBeenCalled();
    },
  );
  it("reports a Jira refusal as an uncertain mutation to the relay's recovery owner", async () => {
    const h = harness();
    h.http.mockImplementation((request) =>
      Promise.resolve(
        request.method === "GET"
          ? fixtureRead(new URL(request.url).pathname.replace("/context/rest/api/2", ""), h.state)
          : response({}, 400),
      ),
    );
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    const result = await client.call("jira.comment", { issueKey: "SYN-1", body: "Rejected" });
    expect(result.isError).toBe(true);
    expect(h.http.mock.calls.filter(([request]) => request.method !== "GET")).toHaveLength(1);
    expect(h.recover).toHaveBeenCalledOnce();
  });
});

describe("native POST reads and administration observations through the Coding relay", () => {
  it.each([
    { tool: "jira.search-post", args: { jql: "project = SYN" } },
    { tool: "jira.worklogs-by-id", args: { worklogIds: ["7", "8"] } },
  ] as const)(
    "retains $tool under read scope without a mutation permit, acknowledgement or recovery",
    async ({ tool, args }) => {
      const h = retainingHarness(harness());
      h.http.mockImplementation(postAndIdentityReadTransport);
      const client = connect(
        h,
        h.pods.connections(undefined, bound(h), {
          runId: h.context.correlationId,
          catalogFits: () => true,
          currentScopes: () => ["issue-tracker.read"],
        }),
      );
      const result = await client.call(tool, args);
      expect(result.isError).not.toBe(true);
      expect(h.retained).toEqual([{ data: result.structuredContent }]);
      expect(h.retained[0]?.data.outcome).toBe("succeeded");
      expect(h.begun).toEqual([]);
      expect(h.dispatched).not.toHaveBeenCalled();
      expect(h.recover).not.toHaveBeenCalled();
      expect(h.http.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
    },
  );

  it.each([
    { tool: "jira.anonymization-validation", args: { userKey: "USER1" } },
    { tool: "jira.anonymization-rerun-validation", args: { userKey: "USER1", oldUserKey: "OLD1" } },
    { tool: "jira.anonymization-progress", args: { taskId: "7" } },
  ] as const)(
    "requires the explicit additional grant for $tool while keeping its effect read-only",
    async ({ tool, args }) => {
      const h = retainingHarness(harness());
      const ordinary = connect(
        h,
        h.pods.connections(undefined, bound(h), {
          runId: h.context.correlationId,
          catalogFits: () => true,
          currentScopes: () => ["issue-tracker.read", "issue-tracker.write"],
        }),
      );
      expect(await ordinary.list()).not.toContain(tool);
      expect((await ordinary.call(tool, args)).isError).toBe(true);
      expect(h.http).not.toHaveBeenCalled();
      h.http.mockImplementation(postAndIdentityReadTransport);
      const admin = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
      const result = await admin.call(tool, args);
      expect(result.isError).not.toBe(true);
      expect(h.retained.at(-1)?.data.outcome).toBe("succeeded");
      expect(h.http.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
      expect(h.begun).toEqual([]);
      expect(h.dispatched).not.toHaveBeenCalled();
    },
  );
});

describe("Coding Jira's live, explicitly selected scopes", () => {
  it("never treats a Pod credential as connector authority", async () => {
    const h = harness();
    const client = connect(h, h.pods.connections(undefined, bound(h)));
    await expect(client.list()).rejects.toBeInstanceOf(ManagedMcpError);
    expect(h.http).not.toHaveBeenCalled();
  });

  it("omits administration from discovery and refuses a guessed admin call without HTTP", async () => {
    const h = harness();
    const authority: CodingJiraRunAuthority = {
      runId: h.context.correlationId,
      catalogFits: () => true,
      currentScopes: () => ["issue-tracker.read", "issue-tracker.write"],
    };
    const client = connect(h, h.pods.connections(undefined, bound(h), authority));
    expect(await client.list()).toEqual(["jira.discover", "jira.describe"]);
    expect(await client.list()).not.toContain("jira.set-app-monitoring");
    expect(
      await client.call("jira.set-app-monitoring", { enabled: true, expectedEnabled: false }),
    ).toMatchObject({ isError: true });
    expect(h.http).not.toHaveBeenCalled();
  });

  it("does not share an admin host with another run using the same Pod", async () => {
    const h = harness();
    const admin = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    await admin.select(["POST /rest/api/2/monitoring/app"]);
    expect(await admin.list()).toContain("jira.set-app-monitoring");
    const ordinary = connect(
      h,
      h.pods.connections(undefined, bound(h), {
        runId: h.context.correlationId,
        catalogFits: () => true,
        currentScopes: () => ["issue-tracker.read", "issue-tracker.write"],
      }),
    );
    expect(await ordinary.list()).not.toContain("jira.set-app-monitoring");
    expect(h.http).not.toHaveBeenCalled();
  });

  it("executes one explicitly admitted admin change with independent state readback", async () => {
    const h = harness();
    let enabled = false;
    h.http.mockImplementation((request) => {
      if (request.method === "POST") {
        enabled = true;
        return Promise.resolve(response(undefined, 204));
      }
      return Promise.resolve(response({ enabled }));
    });
    const client = connect(h, h.pods.connections(undefined, bound(h), runAuthority(h)));
    const result = await client.call("jira.set-app-monitoring", {
      enabled: true,
      expectedEnabled: false,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      outcome: "succeeded",
      monitoringEnabled: true,
    });
    expect(h.http.mock.calls.map(([request]) => request.method)).toEqual(["GET", "POST", "GET"]);
    expect(h.dispatched).toHaveBeenCalledOnce();
  });

  it("does not repeat an acknowledged change when admin access ends before readback", async () => {
    const h = retainingHarness(harness());
    let scopes: readonly CodingWorkbenchConnectorScope[] = [
      "issue-tracker.read",
      "issue-tracker.write",
      "issue-tracker.admin",
    ];
    h.http.mockImplementation((request) => {
      if (request.method === "POST") {
        scopes = ["issue-tracker.read", "issue-tracker.write"];
        return Promise.resolve(response(undefined, 204));
      }
      return Promise.resolve(response({ enabled: false }));
    });
    const client = connect(
      h,
      h.pods.connections(undefined, bound(h), {
        runId: h.context.correlationId,
        catalogFits: () => true,
        currentScopes: () => scopes,
      }),
    );
    const result = await client.call("jira.set-app-monitoring", {
      enabled: true,
      expectedEnabled: false,
    });
    expect(h.http.mock.calls.map(([request]) => request.method)).toEqual(["GET", "POST"]);
    expect(h.recover).toHaveBeenCalledOnce();
    expect(h.dispatched).toHaveBeenCalledOnce();
    expect(h.released).not.toHaveBeenCalled();
    expect(h.localFailures).toEqual([]);
    expect(h.retained).toMatchObject([
      {
        isError: true,
        data: {
          outcome: "succeeded-unconfirmed",
          monitoringEnabled: true,
        },
      },
    ]);
    expect(JSON.stringify(result)).toContain("connector access");
    expect(JSON.stringify(result)).toContain("may or may not have been applied");
  });

  it("rechecks exact scope after discovery and before the native effect", async () => {
    const h = harness();
    let scopes: readonly CodingWorkbenchConnectorScope[] = [
      "issue-tracker.read",
      "issue-tracker.write",
      "issue-tracker.admin",
    ];
    const authority: CodingJiraRunAuthority = {
      runId: h.context.correlationId,
      catalogFits: () => true,
      currentScopes: () => scopes,
    };
    const client = connect(h, h.pods.connections(undefined, bound(h), authority));
    await client.select(["POST /rest/api/2/monitoring/app"]);
    expect(await client.list()).toContain("jira.set-app-monitoring");
    h.http.mockImplementation(() => {
      scopes = ["issue-tracker.read", "issue-tracker.write"];
      return Promise.resolve(response({ enabled: false }));
    });
    const result = await client.rawCall("jira.set-app-monitoring", {
      enabled: true,
      expectedEnabled: false,
    });
    expect(h.http.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
    expect(h.http).toHaveBeenCalledTimes(1);
    expect(h.dispatched).not.toHaveBeenCalled();
    expect(h.released).toHaveBeenCalledOnce();
    expect(h.recover).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain("connector access");
    expect(JSON.stringify(result)).toContain("Nothing was changed");
    expect(JSON.stringify(result)).not.toMatch(/reconnect|Pod changed/iu);
    expect(await client.list()).not.toContain("jira.set-app-monitoring");
  });

  it("refuses discovery once the live envelope is revoked", async () => {
    const h = harness();
    let revoked = false;
    const client = connect(
      h,
      h.pods.connections(undefined, bound(h), {
        runId: h.context.correlationId,
        catalogFits: () => true,
        currentScopes: () => (revoked ? undefined : ["issue-tracker.read"]),
      }),
    );
    expect(await client.list()).toEqual(["jira.discover", "jira.describe"]);
    revoked = true;
    await expect(client.list()).rejects.toBeInstanceOf(ManagedMcpError);
    expect(h.http).not.toHaveBeenCalled();
  });
});
