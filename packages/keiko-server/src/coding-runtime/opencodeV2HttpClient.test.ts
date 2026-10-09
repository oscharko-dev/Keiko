import { describe, expect, it, vi } from "vitest";

import {
  createOpenCodeV2HttpClient,
  parseOpenCodeV2ChildEndpoint,
} from "./opencodeV2HttpClient.js";

describe("OpenCode V2 child readiness", () => {
  // Pinned CLI server-process.ts emits this closed record in native `serve --stdio` mode.
  it("accepts native stdin-lease readiness while retaining ordinary serve readiness", () => {
    expect(parseOpenCodeV2ChildEndpoint('{"url":"http://127.0.0.1:43123"}\n')).toBe(
      "http://127.0.0.1:43123",
    );
    expect(parseOpenCodeV2ChildEndpoint("server listening on http://127.0.0.1:43123\n")).toBe(
      "http://127.0.0.1:43123",
    );
  });

  it.each([
    '{"url":"http://127.0.0.1:43123","password":"test-only"}\n',
    '{"url":"http://127.0.0.1:43123"}',
    '{"url":"http://127.0.0.1:43123"}\nsecond\n',
    'server listening on http://127.0.0.1:43123"}\n',
    '{"url":"http://127.0.0.1:43123\n',
    '{"url":"http://127.0.0.1:0"}\n',
    '{"url":"http://127.0.0.1:65536"}\n',
    '{"url":"http://127.0.0.1:080"}\n',
    '{"url":"http://127.0.0.1:43123/path"}\n',
    '{"url":"http://127.0.0.1:43123?query=1"}\n',
    '{"url":"http://127.0.0.1:43123#fragment"}\n',
    '{"url":"http://user:password@127.0.0.1:43123"}\n',
    '{"url":"https://127.0.0.1:43123"}\n',
    '{"url":"http://localhost:43123"}\n',
    '{"url":"http://example.invalid:43123"}\n',
    '{"url":null}\n',
    '[{"url":"http://127.0.0.1:43123"}]\n',
    `{${" ".repeat(1024)}"url":"http://127.0.0.1:43123"}\n`,
  ])("refuses noncanonical or content-bearing startup records", (output) => {
    expect(parseOpenCodeV2ChildEndpoint(output)).toBeUndefined();
  });
});

describe("OpenCode V2 local HTTP deadline", () => {
  it("keeps a delayed history transport alive past ten seconds", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              resolve(
                new Response(JSON.stringify({ data: [] }), {
                  headers: { "content-type": "application/json" },
                }),
              );
            }, 12_000);
            init?.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new Error("local-history-aborted"));
              },
              { once: true },
            );
          }),
      );
      const client = createOpenCodeV2HttpClient({
        endpoint: "http://127.0.0.1:1984/",
        password: "test-only",
        fetch,
      });
      const history = client.messages("ses_test");
      const completed = expect(history).resolves.toEqual([]);

      await vi.advanceTimersByTimeAsync(12_000);
      await completed;
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
