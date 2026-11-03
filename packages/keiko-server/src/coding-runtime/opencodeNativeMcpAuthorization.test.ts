import { describe, expect, it, vi } from "vitest";
import type { ServerLogEvent, ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import {
  createOpenCodeMcpAuthorizationRunPort,
  type McpAuthorizationRun,
} from "./opencodeNativeMcpAuthorization.js";
import type { OpenCodeV2McpServer, OpenCodeV2OAuthAttempt } from "./opencodeV2HttpClient.js";

const RUN_ID = "run-mcp-auth";
const INTEGRATION = "mcp_52c0335c7b3cc683";
const ATTEMPT = "con_171d58c8b001Enf2VrA2cAq2Bb";
const ENDPOINT = "https://login.example.test/tenant/authorize";
const SERVER_URL = "https://issues.example.test/mcp";

function authorizationUrl(overrides: Readonly<Record<string, string>> = {}): string {
  const url = new URL(ENDPOINT);
  const parameters = {
    response_type: "code",
    client_id: "dyn-client",
    code_challenge: "8xuX6Gi9-BrC2n9SONDWs_4APgkF-0oCxIAKcF6Ql_w",
    code_challenge_method: "S256",
    redirect_uri: "http://127.0.0.1:65464/callback",
    state: "aGQraAavph4Je-ws9BhjZ2NuiTvbiMeT5v9aR4Rtkos",
    resource: SERVER_URL,
    ...overrides,
  };
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  return url.href;
}

interface Fixture {
  readonly run: McpAuthorizationRun;
  readonly records: ServerLogEvent[];
  readonly client: {
    readonly mcpServers: ReturnType<typeof vi.fn>;
    readonly connectMcpOAuth: ReturnType<typeof vi.fn>;
    readonly mcpOAuthStatus: ReturnType<typeof vi.fn>;
    readonly cancelMcpOAuth: ReturnType<typeof vi.fn>;
  };
  readonly authorized: string[];
  readonly port: ReturnType<typeof createOpenCodeMcpAuthorizationRunPort>;
}

function fixture(
  listed: readonly OpenCodeV2McpServer[],
  attempt: OpenCodeV2OAuthAttempt = {
    attemptId: ATTEMPT,
    url: authorizationUrl(),
    mode: "auto",
    expiresAtMs: 1_792_911_782_987,
  },
): Fixture {
  const client = {
    mcpServers: vi.fn(() => Promise.resolve(listed)),
    connectMcpOAuth: vi.fn(() => Promise.resolve(attempt)),
    mcpOAuthStatus: vi.fn(() => Promise.resolve("complete" as const)),
    cancelMcpOAuth: vi.fn(() => Promise.resolve()),
  };
  const run: McpAuthorizationRun = {
    runId: RUN_ID,
    workspaceRoot: "/workspace",
    mcp: {
      actions: new Map(),
      servers: new Map([
        ["issues", { remote: true }],
        ["docs", { remote: false }],
      ]),
    },
    mcpOAuth: new Map([
      [
        "issues",
        {
          url: SERVER_URL,
          oauth: { issuer: "https://login.example.test/tenant" },
          metadataUrl: "https://login.example.test/.well-known/oauth-authorization-server/tenant",
          authorizationEndpoint: ENDPOINT,
        },
      ],
    ]),
    client,
  };
  const records: ServerLogEvent[] = [];
  const sink: ServerLogSink = { write: (event) => void records.push(event) };
  const authorized: string[] = [];
  const port = createOpenCodeMcpAuthorizationRunPort({
    readyRun: (runId) => (runId === RUN_ID ? run : undefined),
    activityLog: sink,
    onAuthorized: (_run, server) => authorized.push(server),
  });
  return { run, records, client, authorized, port };
}

function lines(records: readonly ServerLogEvent[]): readonly Readonly<Record<string, unknown>>[] {
  return records.map((record) =>
    expectActivityLogProof(
      "coding-runtime.mcp-authorization.emitted-line",
      formatActivityLogProofLine(record),
    ),
  );
}

const NEEDS_AUTH: OpenCodeV2McpServer = {
  name: "issues",
  status: "needs-auth",
  integrationId: INTEGRATION,
};

describe("a native run's MCP servers and their authorization (#3903 AC3)", () => {
  it("lists the admitted servers with their status, a server not connected yet as pending", async () => {
    const { port, records } = fixture([NEEDS_AUTH]);
    expect(await port.listMcpServers(RUN_ID, "cor-1")).toEqual([
      { name: "docs", status: "pending", authorization: "none" },
      { name: "issues", status: "needs-authorization", authorization: "oauth" },
    ]);
    expect(lines(records)).toEqual([
      expect.objectContaining({
        action: "listed",
        outcome: "ok",
        serverCount: 2,
        needsAuthorizationCount: 1,
      }),
    ]);
    expect(await port.listMcpServers("another-run")).toBeUndefined();
  });

  it("starts the runtime's own authorization and hands back its validated URL", async () => {
    const { port, client, records } = fixture([NEEDS_AUTH]);
    const start = await port.startMcpAuthorization(RUN_ID, "issues", "cor-2");
    expect(start).toEqual({
      outcome: "started",
      attemptId: ATTEMPT,
      authorizationUrl: authorizationUrl(),
      expiresAtMs: 1_792_911_782_987,
    });
    expect(client.connectMcpOAuth).toHaveBeenCalledWith(INTEGRATION, "/workspace");
    const [line] = lines(records);
    expect(line).toMatchObject({ action: "started", outcome: "ok" });
    expect(line?.serverSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(records)).not.toContain("login.example.test");
  });

  it.each([
    [
      "another endpoint",
      { url: authorizationUrl().replace("login.", "evil.") },
      "endpoint-mismatch",
    ],
    [
      "another resource",
      { url: authorizationUrl({ resource: "https://evil.test/mcp" }) },
      "resource-mismatch",
    ],
    ["a pasted code", { mode: "code" as const }, "mode-unsupported"],
  ])("withdraws an attempt whose request names %s", async (_label, change, urlRefusal) => {
    const { port, client, records } = fixture([NEEDS_AUTH], {
      attemptId: ATTEMPT,
      url: authorizationUrl(),
      mode: "auto",
      expiresAtMs: 1,
      ...change,
    });
    expect(await port.startMcpAuthorization(RUN_ID, "issues")).toEqual({
      outcome: "refused",
      reason: "url-refused",
    });
    expect(client.cancelMcpOAuth).toHaveBeenCalledWith(INTEGRATION, ATTEMPT, "/workspace");
    expect(lines(records)).toEqual([
      expect.objectContaining({ action: "started", outcome: "url-refused", urlRefusal }),
    ]);
    expect(records[0]?.level).toBe("warn");
  });

  it.each([
    ["a server without OAuth", "docs", [NEEDS_AUTH], "not-oauth"],
    ["a server the run did not admit", "other", [NEEDS_AUTH], "not-oauth"],
    [
      "a connected server",
      "issues",
      [{ ...NEEDS_AUTH, status: "connected" as const }],
      "connected",
    ],
    ["a server not listed yet", "issues", [], "unavailable"],
  ] as const)("refuses %s without starting anything", async (_label, server, listed, reason) => {
    const { port, client } = fixture(listed);
    expect(await port.startMcpAuthorization(RUN_ID, server)).toEqual({
      outcome: "refused",
      reason,
    });
    expect(client.connectMcpOAuth).not.toHaveBeenCalled();
  });

  it("reports a completed attempt once and keeps its credential", async () => {
    const { port, authorized, records } = fixture([NEEDS_AUTH]);
    await port.startMcpAuthorization(RUN_ID, "issues");
    expect(await port.mcpAuthorizationStatus(RUN_ID, "issues", ATTEMPT)).toBe("complete");
    expect(authorized).toEqual(["issues"]);
    // A settled attempt is forgotten: it cannot be read or cancelled again.
    expect(await port.mcpAuthorizationStatus(RUN_ID, "issues", ATTEMPT)).toBe("unavailable");
    expect(lines(records).map((line) => [line.action, line.outcome])).toEqual([
      ["started", "ok"],
      ["status", "complete"],
      ["status", "unavailable"],
    ]);
  });

  it("binds an attempt to its run and server and cancels it", async () => {
    const { port, client } = fixture([NEEDS_AUTH]);
    await port.startMcpAuthorization(RUN_ID, "issues");
    expect(await port.mcpAuthorizationStatus(RUN_ID, "docs", ATTEMPT)).toBe("unavailable");
    expect(await port.cancelMcpAuthorization(RUN_ID, "issues", ATTEMPT)).toBe("cancelled");
    expect(client.cancelMcpOAuth).toHaveBeenCalledWith(INTEGRATION, ATTEMPT, "/workspace");
    expect(client.mcpOAuthStatus).not.toHaveBeenCalled();
  });

  it("records a failed runtime call with its frames and refuses", async () => {
    const { port, client, records } = fixture([NEEDS_AUTH]);
    client.connectMcpOAuth.mockRejectedValueOnce(new Error("opencode-v2-envelope-invalid"));
    expect(await port.startMcpAuthorization(RUN_ID, "issues")).toEqual({
      outcome: "refused",
      reason: "failed",
    });
    const [line] = lines(records);
    expect(line).toMatchObject({ action: "started", outcome: "failed" });
    expect(line?.frames).toEqual(expect.any(Array));
    expect(records[0]?.errorKind).toBe("internal");
  });
});
