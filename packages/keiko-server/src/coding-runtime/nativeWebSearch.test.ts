import { describe, expect, it } from "vitest";

import type { GatewayFetchOptions } from "@oscharko-dev/keiko-model-gateway/internal/http";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  answerNativeWebSearch,
  createNativeWebSearch,
  nativeWebSearchConfigFromEnv,
  parseNativeWebSearchAnswer,
  parseNativeWebSearchRequest,
  type NativeWebSearchFetch,
} from "./nativeWebSearch.js";

// #3903 AC3 (PR #4064 review 4372361272): the search the original `websearch` reaches through
// Keiko's provider, against the operator's admitted integration only.

const TEXT = [
  "Title: First result\nURL: https://example.test/one\nPublished: 2026-10-01T00:00:00.000Z\nText: The first page.",
  "Title: N/A\nURL: javascript:alert(1)\nText: Not a web page.",
  "Title: Second result\nURL: https://example.test/two\nPublished: N/A\nHighlights:\nA highlight.",
].join("\n\n---\n\n");

function answer(text: string, sse = true): string {
  const message = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text }] },
  });
  return sse ? `event: message\ndata: ${message}\n\n` : message;
}

function fixture(
  body: string,
  status = 200,
): {
  readonly fetchImpl: NativeWebSearchFetch;
  readonly calls: { readonly url: string; readonly options: GatewayFetchOptions }[];
} {
  const calls: { readonly url: string; readonly options: GatewayFetchOptions }[] = [];
  return {
    calls,
    fetchImpl: (url, options): Promise<Response> => {
      calls.push({ url, options });
      return Promise.resolve(new Response(body, { status }));
    },
  };
}

describe("the admitted web search integration (#3903 AC3)", () => {
  it("admits only an https endpoint or a loopback http service, without credentials", () => {
    expect(nativeWebSearchConfigFromEnv({})).toBeUndefined();
    expect(
      nativeWebSearchConfigFromEnv({ KEIKO_CODING_WEBSEARCH_ENDPOINT: "https://mcp.exa.ai/mcp" })
        ?.endpoint.href,
    ).toBe("https://mcp.exa.ai/mcp");
    expect(
      nativeWebSearchConfigFromEnv({
        KEIKO_CODING_WEBSEARCH_ENDPOINT: "http://127.0.0.1:9/mcp",
        KEIKO_CODING_WEBSEARCH_API_KEY: " key ",
      }),
    ).toMatchObject({ apiKey: "key" });
    for (const refused of [
      "http://search.example.test/mcp",
      "https://user:secret@search.example.test/mcp",
      "https://search.example.test/mcp#fragment",
      "file:///etc/passwd",
      "not a url",
    ])
      expect(
        nativeWebSearchConfigFromEnv({ KEIKO_CODING_WEBSEARCH_ENDPOINT: refused }),
      ).toBeUndefined();
  });

  it("reads the provider's answer as bounded web results, in either transport", () => {
    const sse = parseNativeWebSearchAnswer(answer(TEXT))?.results;
    expect(sse).toEqual([
      {
        url: "https://example.test/one",
        title: "First result",
        content: "The first page.",
        published: Date.parse("2026-10-01T00:00:00.000Z"),
      },
      { url: "https://example.test/two", title: "Second result", content: "A highlight." },
    ]);
    expect(parseNativeWebSearchAnswer(answer(TEXT, false))?.results).toEqual(sse);
    expect(parseNativeWebSearchAnswer(JSON.stringify({ jsonrpc: "2.0", id: 1 }))).toBeUndefined();
    expect(
      parseNativeWebSearchAnswer(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [] } }),
      ),
    ).toBeUndefined();
    const long = `Title: ${"t".repeat(600)}\nURL: https://example.test/x\nText: ${"c".repeat(5_000)}`;
    const [bounded] = parseNativeWebSearchAnswer(answer(long))?.results ?? [];
    expect(bounded?.title?.length).toBeLessThanOrEqual(513);
    expect(bounded?.content?.length).toBeLessThanOrEqual(4_001);
    // Labels are read line by line, so a hostile run of blanks is scanned once, not backtracked.
    const blanks = " ".repeat(200_000);
    const hostile = `Title:${blanks}\nURL:${blanks}https://example.test/y\nText:${blanks}\n${blanks}`;
    expect(parseNativeWebSearchAnswer(answer(hostile))).toEqual({
      results: [{ url: "https://example.test/y" }],
      credentialRedacted: false,
    });
  });

  // PR #4064 review: the provider receives the operator's key in its query string and can echo it
  // in any field. Every occurrence goes, as sent, percent-encoded or form-encoded, before a field is
  // read or cut, so no title, URL or excerpt carries it whole or in part.
  it("removes the operator's key from every field a provider echoes it in", () => {
    const key = "operator-key/7+x=";
    const echoed = [
      `Title: Echo ${key}\nURL: https://example.test/a?k=${encodeURIComponent(key)}\nText: raw ${key}`,
      `Title: Form\nURL: https://example.test/b?${new URLSearchParams([["k", key]]).toString()}\nText: ok`,
      `Title: Cut\nURL: https://example.test/c\nText: ${"c".repeat(3_995)}${key}`,
    ].join("\n\n---\n\n");
    const parsed = parseNativeWebSearchAnswer(answer(echoed), key);
    expect(parsed?.credentialRedacted).toBe(true);
    expect(parsed?.results.map((result) => result.url)).toEqual([
      "https://example.test/a?k=[REDACTED]",
      "https://example.test/b?k=[REDACTED]",
      "https://example.test/c",
    ]);
    const visible = JSON.stringify(parsed?.results);
    for (const form of [key, encodeURIComponent(key), "operator-key"])
      expect(visible).not.toContain(form);
    expect(parseNativeWebSearchAnswer(answer(TEXT), key)?.credentialRedacted).toBe(false);
  });

  it("searches once for the query the run's policy allowed, through the configured endpoint only", async () => {
    const sink = createBufferedServerLogSink();
    const { fetchImpl, calls } = fixture(answer(TEXT));
    const search = createNativeWebSearch({
      config: { endpoint: new URL("https://search.example.test/mcp"), apiKey: "operator-key" },
      activityLog: sink,
      fetchImpl,
    });
    expect(search.admitted).toBe(true);
    await expect(search.search("run-1", "governed search", undefined)).resolves.toEqual({
      status: "refused",
      reason: "ungranted",
    });
    search.grant("run-1", "governed search");
    await expect(search.search("run-2", "governed search", undefined)).resolves.toMatchObject({
      reason: "ungranted",
    });
    await expect(search.search("run-1", "governed search", undefined)).resolves.toMatchObject({
      status: "completed",
      results: [{ url: "https://example.test/one" }, { url: "https://example.test/two" }],
    });
    // The grant is spent.
    await expect(search.search("run-1", "governed search", undefined)).resolves.toMatchObject({
      reason: "ungranted",
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(new URL(call?.url ?? "").origin).toBe("https://search.example.test");
    expect(new URL(call?.url ?? "").searchParams.get("exaApiKey")).toBe("operator-key");
    expect(call?.options).toMatchObject({
      method: "POST",
      redirect: "manual",
      egress: { denyLoopback: true },
    });
    const body = call?.options.body;
    expect(typeof body).toBe("string");
    expect(JSON.parse(typeof body === "string" ? body : "")).toMatchObject({
      method: "tools/call",
      params: { name: "web_search_exa", arguments: { query: "governed search" } },
    });
    const completed = sink.events.find((event) => event.extra?.outcome === "completed");
    expect(
      expectActivityLogProof(
        "coding-runtime.websearch.performed.emitted-line",
        formatActivityLogProofLine(completed ?? {}),
      ),
    ).toMatchObject({ outcome: "completed", resultCount: 2 });
    const lines = sink.lines().join("\n");
    for (const secret of ["governed search", "operator-key", "search.example.test", "First result"])
      expect(lines).not.toContain(secret);
  });

  it("hands back a provider's echo of the key without it, and records that it did", async () => {
    const sink = createBufferedServerLogSink();
    const echoed = `Title: Leak operator-key\nURL: https://example.test/one?k=operator-key\nText: operator-key`;
    const search = createNativeWebSearch({
      config: { endpoint: new URL("https://search.example.test/mcp"), apiKey: "operator-key" },
      activityLog: sink,
      fetchImpl: fixture(answer(echoed)).fetchImpl,
    });
    search.grant("run-1", "governed search");
    const outcome = await search.search("run-1", "governed search", undefined);
    expect(outcome).toMatchObject({ status: "completed", results: [{ title: "Leak [REDACTED]" }] });
    expect(JSON.stringify(outcome)).not.toContain("operator-key");
    expect(
      expectActivityLogProof(
        "coding-runtime.websearch.performed.emitted-line",
        formatActivityLogProofLine(sink.events[0] ?? {}),
      ),
    ).toMatchObject({ outcome: "completed", resultCount: 1, credentialRedacted: true });
    expect(sink.lines().join("\n")).not.toContain("operator-key");
  });

  it("refuses without an admitted integration and reports a provider failure with its evidence", async () => {
    const sink = createBufferedServerLogSink();
    const unadmitted = createNativeWebSearch({ config: undefined, activityLog: sink });
    unadmitted.grant("run-1", "query");
    await expect(unadmitted.search("run-1", "query", undefined)).resolves.toEqual({
      status: "refused",
      reason: "unconfigured",
    });
    const config = { endpoint: new URL("http://127.0.0.1:9/mcp") };
    const broken = createNativeWebSearch({
      config,
      activityLog: sink,
      fetchImpl: fixture("data: not json\n\n").fetchImpl,
    });
    broken.grant("run-1", "query");
    await expect(broken.search("run-1", "query", undefined)).resolves.toEqual({
      status: "failed",
      reason: "response",
    });
    const down = createNativeWebSearch({
      config,
      activityLog: sink,
      fetchImpl: (): Promise<Response> => Promise.reject(new TypeError("connect ECONNREFUSED")),
    });
    down.grant("run-1", "query");
    await expect(down.search("run-1", "query", undefined)).resolves.toEqual({
      status: "failed",
      reason: "transport",
    });
    const failure = sink.events.find((event) => event.extra?.reason === "transport");
    expect(failure).toMatchObject({ level: "warn", errorKind: "unavailable" });
    expect(failure?.extra?.frames).toEqual(expect.any(Array));
    expect(sink.lines().join("\n")).not.toContain("ECONNREFUSED");
  });

  it("answers the provider's request only for a live Full access run", async () => {
    expect(
      parseNativeWebSearchRequest({ action: "web-search", runId: "run-1", query: "q" }),
    ).toEqual({ runId: "run-1", query: "q" });
    for (const refused of [
      { action: "web-search", runId: "run-1", query: "" },
      { action: "web-search", runId: "run-1", query: "q", extra: true },
      { action: "native-policy", runId: "run-1", query: "q" },
      "web-search",
    ])
      expect(parseNativeWebSearchRequest(refused)).toBeUndefined();
    const search = createNativeWebSearch({
      config: { endpoint: new URL("http://127.0.0.1:9/mcp") },
      activityLog: createBufferedServerLogSink(),
      fetchImpl: fixture(answer(TEXT)).fetchImpl,
    });
    search.grant("run-1", "q");
    const request = { runId: "run-1", query: "q" };
    await expect(answerNativeWebSearch(search, request, false, undefined)).resolves.toMatchObject({
      status: 403,
    });
    const answered = await answerNativeWebSearch(search, request, true, undefined);
    expect(answered.status).toBe(200);
    expect((JSON.parse(answered.body) as { results: { url: string }[] }).results[0]?.url).toBe(
      "https://example.test/one",
    );
    await expect(answerNativeWebSearch(search, request, true, undefined)).resolves.toMatchObject({
      status: 403,
    });
  });
});
