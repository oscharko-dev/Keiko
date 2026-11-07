import { describe, expect, it, vi } from "vitest";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type {
  AtlassianHttpBodyPort,
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
} from "./atlassian-http-port.js";
import {
  JIRA_DRAFT_READ_MEMO_BYTES_MAX,
  JIRA_DRAFT_READ_MEMO_ENTRIES_MAX,
  JIRA_DRAFT_READ_MEMO_TTL_MS,
  withJiraCreateMetadataMemo,
  withJiraDraftReadMemo,
  type JiraDraftReadCounts,
} from "./jira-draft-read-memo.js";
import type { JiraManagedConnection } from "./jira-managed-connection.js";

function context(): ManagedMcpInvocationContext {
  return {
    invocationId: "i",
    correlationId: "c",
    signal: new AbortController().signal,
    beforeEffect: () => true,
  };
}
function ok(
  bodyText = "{}",
  extra: Partial<AtlassianHttpBodyResult> = {},
): AtlassianHttpBodyResult {
  return {
    kind: "response",
    status: 200,
    bodyText,
    bodyBytes: bodyText.length,
    truncated: false,
    ...extra,
  };
}
function connection(
  answer: (request: AtlassianHttpBodyRequest) => AtlassianHttpBodyResult = () => ok(),
): { readonly connection: JiraManagedConnection; readonly http: ReturnType<typeof vi.fn> } {
  const http = vi.fn<AtlassianHttpBodyPort>((request) => Promise.resolve(answer(request)));
  return {
    http,
    connection: { deployment: "data-center", baseUrl: "https://jira.example.invalid", http },
  };
}
function get(url: string, maxBodyBytes = 1000): AtlassianHttpBodyRequest {
  return { method: "GET", url, timeoutMs: 1, maxBodyBytes };
}
function counts(): JiraDraftReadCounts {
  return { made: 0, reused: 0 };
}

describe("withJiraDraftReadMemo", () => {
  it("answers an identical GET from the memo and counts sent and reused reads", async () => {
    const { connection: target, http } = connection();
    const tally = counts();
    const memoized = withJiraDraftReadMemo(target, context(), tally);
    for (let i = 0; i < 5; i += 1) await memoized.http(get("https://jira/a"));
    await memoized.http(get("https://jira/b"));
    expect(http).toHaveBeenCalledTimes(2);
    expect(tally).toEqual({ made: 2, reused: 4 });
  });

  it("expires an entry after its time to live", async () => {
    const { connection: target, http } = connection();
    let now = 1000;
    const memoized = withJiraDraftReadMemo(target, context(), counts(), () => now);
    await memoized.http(get("https://jira/a"));
    now += JIRA_DRAFT_READ_MEMO_TTL_MS - 1;
    await memoized.http(get("https://jira/a"));
    expect(http).toHaveBeenCalledTimes(1);
    now += 1;
    await memoized.http(get("https://jira/a"));
    expect(http).toHaveBeenCalledTimes(2);
  });

  it("never remembers a non-200 or truncated answer", async () => {
    const answers = [ok("{}", { status: 404 }), ok("{}", { truncated: true }), ok("{}")];
    const { connection: target, http } = connection(() => answers.shift() ?? ok());
    const memoized = withJiraDraftReadMemo(target, context(), counts());
    await memoized.http(get("https://jira/a"));
    await memoized.http(get("https://jira/a"));
    await memoized.http(get("https://jira/a"));
    await memoized.http(get("https://jira/a"));
    expect(http).toHaveBeenCalledTimes(3);
  });

  it("never remembers a failed transport result", async () => {
    const { connection: target, http } = connection(() => ({ kind: "timeout" }));
    const memoized = withJiraDraftReadMemo(target, context(), counts());
    await memoized.http(get("https://jira/a"));
    await memoized.http(get("https://jira/a"));
    expect(http).toHaveBeenCalledTimes(2);
  });

  it("sends every write and does not count it as a read", async () => {
    const { connection: target, http } = connection();
    const tally = counts();
    const memoized = withJiraDraftReadMemo(target, context(), tally);
    const write: AtlassianHttpBodyRequest = { ...get("https://jira/a"), method: "POST" };
    await memoized.http(write);
    await memoized.http(write);
    expect(http).toHaveBeenCalledTimes(2);
    expect(tally).toEqual({ made: 0, reused: 0 });
  });

  it("keeps another transport and another invocation apart", async () => {
    const shared = context();
    const first = connection();
    const second = connection();
    await withJiraDraftReadMemo(first.connection, shared, counts()).http(get("https://jira/a"));
    await withJiraDraftReadMemo(second.connection, shared, counts()).http(get("https://jira/a"));
    await withJiraDraftReadMemo(first.connection, context(), counts()).http(get("https://jira/a"));
    expect(first.http).toHaveBeenCalledTimes(2);
    expect(second.http).toHaveBeenCalledTimes(1);
  });

  it("keeps different response caps apart", async () => {
    const { connection: target, http } = connection();
    const memoized = withJiraDraftReadMemo(target, context(), counts());
    await memoized.http(get("https://jira/a", 100));
    await memoized.http(get("https://jira/a", 200));
    expect(http).toHaveBeenCalledTimes(2);
  });

  it("stays correct when full: bounded by entries, oldest evicted, recent still served", async () => {
    const { connection: target, http } = connection();
    const memoized = withJiraDraftReadMemo(target, context(), counts());
    for (let i = 0; i < JIRA_DRAFT_READ_MEMO_ENTRIES_MAX + 10; i += 1)
      await memoized.http(get(`https://jira/${String(i)}`));
    const sent = http.mock.calls.length;
    await memoized.http(get(`https://jira/${String(JIRA_DRAFT_READ_MEMO_ENTRIES_MAX + 9)}`));
    expect(http.mock.calls.length).toBe(sent);
    await memoized.http(get("https://jira/0"));
    expect(http.mock.calls.length).toBe(sent + 1);
  });

  it("is bounded by total bytes and never holds an answer larger than the bound", async () => {
    const chunk = "x".repeat(JIRA_DRAFT_READ_MEMO_BYTES_MAX / 2 + 1);
    const { connection: target, http } = connection((request) =>
      request.url.endsWith("/huge")
        ? ok("y".repeat(JIRA_DRAFT_READ_MEMO_BYTES_MAX + 1))
        : ok(chunk),
    );
    const memoized = withJiraDraftReadMemo(target, context(), counts());
    await memoized.http(get("https://jira/a"));
    await memoized.http(get("https://jira/b"));
    // The second answer pushed the first out: total bytes stay within the bound.
    await memoized.http(get("https://jira/b"));
    expect(http).toHaveBeenCalledTimes(2);
    await memoized.http(get("https://jira/a"));
    expect(http).toHaveBeenCalledTimes(3);
    await memoized.http(get("https://jira/huge"));
    await memoized.http(get("https://jira/huge"));
    expect(http).toHaveBeenCalledTimes(5);
  });

  it("drops expired entries to make room before evicting a current one", async () => {
    const { connection: target, http } = connection();
    let now = 0;
    const memoized = withJiraDraftReadMemo(target, context(), counts(), () => now);
    for (let i = 0; i < JIRA_DRAFT_READ_MEMO_ENTRIES_MAX - 1; i += 1)
      await memoized.http(get(`https://jira/old${String(i)}`));
    now += JIRA_DRAFT_READ_MEMO_TTL_MS;
    await memoized.http(get("https://jira/fresh1"));
    await memoized.http(get("https://jira/fresh2"));
    const sent = http.mock.calls.length;
    await memoized.http(get("https://jira/fresh1"));
    await memoized.http(get("https://jira/fresh2"));
    expect(http.mock.calls.length).toBe(sent);
  });
});

describe("withJiraCreateMetadataMemo", () => {
  const API = "https://jira/rest/api/2/";
  const METADATA = [
    `${API}issue/createmeta/1/issuetypes/2?startAt=0&maxResults=100`,
    `${API}project/1`,
    `${API}issuetype/2`,
    `${API}field`,
  ];
  const LIVE = [`${API}search?jql=labels%3D%22x%22`, `${API}issue/SYN-1?fields=summary`];

  it("serves the metadata once for items on one scope but keeps search and read-back live", async () => {
    const ctx = context();
    const scope = {};
    const tally = counts();
    const { connection: target, http } = connection();
    for (let item = 0; item < 5; item += 1) {
      // Each item gets its own transport, as the lifecycle-wrapped port of the create run does.
      const own = {
        ...target,
        http: (request: AtlassianHttpBodyRequest): Promise<AtlassianHttpBodyResult> =>
          target.http(request),
      };
      const memoized = withJiraCreateMetadataMemo(own, ctx, scope, tally);
      for (const url of [...METADATA, ...LIVE]) await memoized.http(get(url));
    }
    expect(http).toHaveBeenCalledTimes(METADATA.length + LIVE.length * 5);
    expect(tally).toEqual({ made: METADATA.length + LIVE.length * 5, reused: METADATA.length * 4 });
  });

  it("never answers a write and starts a new invocation empty", async () => {
    const scope = {};
    const { connection: target, http } = connection();
    const post = { method: "POST", url: `${API}issue`, timeoutMs: 1, maxBodyBytes: 10 } as const;
    const first = withJiraCreateMetadataMemo(target, context(), scope, counts());
    await first.http(post);
    await first.http(post);
    await first.http(get(METADATA[1] ?? ""));
    const second = withJiraCreateMetadataMemo(target, context(), scope, counts());
    await second.http(get(METADATA[1] ?? ""));
    expect(http).toHaveBeenCalledTimes(4);
  });

  it("does not remember a non-200 metadata answer", async () => {
    const ctx = context();
    const scope = {};
    const { connection: target, http } = connection(() => ok("{}", { status: 404 }));
    const memoized = withJiraCreateMetadataMemo(target, ctx, scope, counts());
    await memoized.http(get(METADATA[0] ?? ""));
    await memoized.http(get(METADATA[0] ?? ""));
    expect(http).toHaveBeenCalledTimes(2);
  });
});
