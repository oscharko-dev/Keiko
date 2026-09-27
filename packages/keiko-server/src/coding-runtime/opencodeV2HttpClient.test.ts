import { describe, expect, it, vi } from "vitest";

import { createOpenCodeV2HttpClient } from "./opencodeV2HttpClient.js";

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
