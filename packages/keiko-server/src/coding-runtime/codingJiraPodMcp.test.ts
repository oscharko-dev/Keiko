import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerLogEvent, ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import type {
  AtlassianCredentialMetadata,
  AtlassianHttpBodyPort,
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
} from "@oscharko-dev/keiko-connectors";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { ManagedMcpError } from "@oscharko-dev/keiko-mcp";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import {
  fixtureRead,
  fixtureWrite,
  response,
  type SyntheticJira,
} from "../../../../tests/support/jira-managed-remote.js";
import {
  createCodingJiraPods,
  type CodingJiraConnections,
  type CodingJiraPodDeps,
  type CodingJiraPods,
} from "./codingJiraPodMcp.js";
import { buildUiStoreOverDatabase } from "../store/index.js";
import { runMigrations } from "../store/schema.js";
import { CODING_JIRA_TOOL_RISKS, type CodingJiraPodBinding } from "./codingJiraPodBinding.js";
import { JIRA_TOOL_GUIDANCE } from "../atlassian/jiraToolGuidance.js";

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

function harness(options: { readonly attach?: boolean; readonly template?: string } = {}): Harness {
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
  const log: ServerLogSink = { write: (event) => void records.push(event) };
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
  const recover = vi.fn<() => void>();
  const context: ManagedMcpInvocationContext = {
    invocationId: "invocation-1",
    correlationId: "run-jira-1",
    signal: new AbortController().signal,
    beforeEffect: () => true,
    onUncertainMutation: recover,
    beginMutation: ({ toolName }) => {
      begun.push(toolName);
      return {
        invocationId: "durable-native-call",
        acknowledge: () => undefined,
        fail: () => undefined,
      };
    },
  };
  cleanup.push(() => pods.close());
  return { pods, pod, http, records, context, recover, begun, state, tokenHeaderSeen };
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
}

// The relay's wire as the runtime's own client speaks it: stateless Streamable HTTP JSON-RPC.
function connect(h: Harness, connections: CodingJiraConnections): Client {
  let id = 0;
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
    const json = text.startsWith("{")
      ? text
      : text
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);
    const parsed = JSON.parse(json ?? "null") as { result?: RpcResult; error?: unknown };
    if (parsed.result === undefined) return { isError: true };
    return parsed.result;
  };
  return {
    initialize: () =>
      rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "coding-jira-test", version: "1" },
      }),
    list: async () => (await rpc("tools/list", {})).tools?.map((tool) => tool.name) ?? [],
    descriptions: async () =>
      (await rpc("tools/list", {})).tools?.map((tool) => tool.description ?? "") ?? [],
    call: (name, args) => rpc("tools/call", { name, arguments: args }),
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
    h.pods.recordBind("run-jira-1", { outcome: "bound" });
    h.pods.recordBind("run-jira-2", { outcome: "refused", reason: "pod-not-ready" });
    const [bound_, refused] = proofLines(h);
    expect(bound_).toMatchObject({
      op: "coding-runtime.jira-pod",
      correlationId: "run-jira-1",
      action: "bind",
      outcome: "bound",
      toolCount: Object.keys(CODING_JIRA_TOOL_RISKS).length,
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
    const connections = h.pods.connections(base, bound(h));
    const other = { name: "wiki", enabled: true } as never;
    connections.generation(other, "run-jira-1");
    await connections.serve("wiki", new Request("https://x.invalid/mcp"), h.context);
    expect(base.generation).toHaveBeenCalledOnce();
    expect(base.serve).toHaveBeenCalledOnce();
    expect(h.http).not.toHaveBeenCalled();
  });

  it("fails closed for another server when the run has no managed connections", async () => {
    const h = harness();
    const connections = h.pods.connections(undefined, bound(h));
    await expect(
      connections.serve("wiki", new Request("https://x.invalid/mcp"), h.context),
    ).rejects.toBeInstanceOf(ManagedMcpError);
  });

  // Pin (#4178): the rules every Jira tool shares reach the runtime once, as the server's MCP
  // instructions, instead of in each tool description of the list it receives on every round.
  it("gives the shared Jira rules once as server instructions, not in each tool", async () => {
    const h = harness();
    const client = connect(h, h.pods.connections(undefined, bound(h)));
    expect((await client.initialize()).instructions).toBe(JIRA_TOOL_GUIDANCE);
    const descriptions = await client.descriptions();
    expect(descriptions).toHaveLength(Object.keys(CODING_JIRA_TOOL_RISKS).length);
    for (const description of descriptions)
      expect(description).not.toMatch(/untrusted data|Data Center only|Never retry/u);
  });

  it("offers exactly the Jira tools, reads and writes, with their declared risks", async () => {
    const h = harness();
    const client = connect(h, h.pods.connections(undefined, bound(h)));
    expect([...(await client.list())].sort()).toEqual(Object.keys(CODING_JIRA_TOOL_RISKS).sort());
    expect(h.http).not.toHaveBeenCalled();
  });

  // #4176: an attachment reads Chat-connected files, which a Coding run has no authority over, so
  // the tool is neither offered nor defaulted to a risk; a call to it never reaches Jira.
  it("neither offers nor accepts jira.attach and never touches Jira for it", async () => {
    const h = harness();
    const client = connect(h, h.pods.connections(undefined, bound(h)));
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
    const client = connect(h, h.pods.connections(undefined, bound(h)));
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
        tool: "jira.issue",
        risk: "read",
      }),
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/SYN-1|jira\.example|Fix it/u);
  });

  it("binds a report to the Pod and logs it on the run's correlation (jira.report)", async () => {
    const h = harness();
    const client = connect(h, h.pods.connections(undefined, bound(h)));
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
    const client = connect(h, h.pods.connections(undefined, bound(h)));
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
      expect.objectContaining({ tool: "jira.comment", risk: "write", outcome: "completed" }),
    ]);
  });

  const THREE_LINKS = ["SYN-7", "SYN-8", "SYN-9"].map((issueKey) => ({
    type: "Relates",
    direction: "outward",
    issueKey,
  }));
  it("links several issues through separate calls and counts them on its one line (#4176)", async () => {
    const h = harness();
    const client = connect(h, h.pods.connections(undefined, bound(h)));
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
        tool: "jira.edit",
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
    const client = connect(h, h.pods.connections(undefined, bound(h)));
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
    const client = connect(h, h.pods.connections(undefined, bound(h)));
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
    const h = harness();
    h.http.mockResolvedValue(response({}, 403));
    const client = connect(h, h.pods.connections(undefined, bound(h)));
    const result = await client.call("jira.issue", { issueKey: "SYN-1" });
    expect(result).toMatchObject({ isError: true, structuredContent: { outcome: "failed" } });
    expect(proofLines(h)).toEqual([
      expect.objectContaining({ outcome: "failed", reason: "tool-failed", level: "warn" }),
    ]);
  });
});

describe("the customer's issue templates bind a Coding run's Jira writes (#4177)", () => {
  const writes = (h: Harness): number =>
    h.http.mock.calls.filter(([request]) => request.method !== "GET").length;

  it("refuses an edit that leaves the issue violating its template, before any PUT", async () => {
    const h = harness({ template: EDIT_TEMPLATE });
    const client = connect(h, h.pods.connections(undefined, bound(h)));
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
    const client = connect(h, h.pods.connections(undefined, bound(h)));
    await client.call("jira.edit", { issueKey: "SYN-1", fields: { summary: "Too short" } });
    expect(writes(h)).toBe(1);
  });

  it("refuses requirement references a Coding run cannot trace, and still writes without them", async () => {
    const h = harness();
    const client = connect(h, h.pods.connections(undefined, bound(h)));
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
    const connections = h.pods.connections(undefined, bound(h));
    const client = connect(h, connections);
    await client.call("jira.issue", { issueKey: "SYN-1" });
    h.http.mockClear();
    change(h.pod);

    await expect(client.call("jira.issue", { issueKey: "SYN-1" })).rejects.toBeInstanceOf(
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
    const client = connect(h, h.pods.connections(undefined, bound(h)));
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
    const client = connect(h, h.pods.connections(undefined, bound(h)));

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
    const connections = h.pods.connections(undefined, old);
    const server = { name: "jira", enabled: true } as never;
    const signal = connections.generation(server, "run-jira-1");
    expect(signal.aborted).toBe(false);

    h.pod.generation += 1;
    await expect(connect(h, connections).list()).rejects.toBeInstanceOf(ManagedMcpError);
    expect(signal.aborted).toBe(true);
    expect(connections.generation(server, "run-jira-1").aborted).toBe(true);
    // A new run binds the new identity and works again.
    expect(h.pods.connections(undefined, bound(h)).generation(server, "run-jira-2").aborted).toBe(
      false,
    );
  });

  it("refuses to serve once the application graph is closed", async () => {
    const h = harness();
    const connections = h.pods.connections(undefined, bound(h));
    await h.pods.close();
    await expect(
      connections.serve("jira", new Request("https://x.invalid/mcp"), h.context),
    ).rejects.toBeInstanceOf(ManagedMcpError);
  });
});

describe("a write that does not complete", () => {
  it("reports a Jira refusal as an uncertain mutation to the relay's recovery owner", async () => {
    const h = harness();
    h.http.mockImplementation((request) =>
      Promise.resolve(
        request.method === "GET"
          ? fixtureRead(new URL(request.url).pathname.replace("/context/rest/api/2", ""), h.state)
          : response({}, 400),
      ),
    );
    const client = connect(h, h.pods.connections(undefined, bound(h)));
    const result = await client.call("jira.comment", { issueKey: "SYN-1", body: "Rejected" });
    expect(result.isError).toBe(true);
    expect(h.http.mock.calls.filter(([request]) => request.method !== "GET")).toHaveLength(1);
    expect(h.recover).toHaveBeenCalledOnce();
  });
});
