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

describe("OpenCode V2 session agent switch", () => {
  function clientWith(respond: () => Response): {
    readonly client: ReturnType<typeof createOpenCodeV2HttpClient>;
    readonly fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
  } {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(respond()));
    return {
      client: createOpenCodeV2HttpClient({
        endpoint: "http://127.0.0.1:1984/",
        password: "test-only",
        fetch,
      }),
      fetch,
    };
  }

  it.each(["build", "plan"] as const)(
    "posts exactly the closed agent body to the session agent route (%s)",
    async (agent) => {
      const { client, fetch } = clientWith(() => new Response(null, { status: 204 }));

      await expect(client.switchAgent("ses_agent_1", agent)).resolves.toBeUndefined();

      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = fetch.mock.calls[0] ?? [];
      expect(url).toEqual(new URL("http://127.0.0.1:1984/api/session/ses_agent_1/agent"));
      expect(init).toMatchObject({ method: "POST", redirect: "manual" });
      expect(init?.body).toBe(JSON.stringify({ agent }));
      expect(init?.headers).toMatchObject({
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from("opencode:test-only", "utf8").toString("base64")}`,
      });
    },
  );

  it.each(["general", "explore", "Plan", "", "build,plan", "../plan", "plan\n"])(
    "refuses a foreign agent id before any request leaves the process (%j)",
    async (agent) => {
      const { client, fetch } = clientWith(() => new Response(null, { status: 204 }));

      await expect(client.switchAgent("ses_agent_1", agent as "plan")).rejects.toThrow(
        "opencode-v2-agent-invalid",
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["ses_", "ses_a/../b", "msg_agent_1", "ses_agent 1", ""])(
    "refuses an unsafe session id before any request leaves the process (%j)",
    async (sessionId) => {
      const { client, fetch } = clientWith(() => new Response(null, { status: 204 }));

      await expect(client.switchAgent(sessionId, "plan")).rejects.toThrow(
        "opencode-v2-session-invalid",
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([400, 401, 404, 500])(
    "surfaces a runtime refusal (%i) instead of reporting a switch that did not happen",
    async (status) => {
      const { client } = clientWith(
        () =>
          new Response(JSON.stringify({ _tag: "SessionNotFoundError" }), {
            status,
            headers: { "content-type": "application/json" },
          }),
      );

      await expect(client.switchAgent("ses_agent_1", "plan")).rejects.toThrow(
        "opencode-v2-response-invalid",
      );
    },
  );

  it("refuses a redirect instead of following it", async () => {
    const { client } = clientWith(() => {
      const response = new Response(null, { status: 204 });
      Object.defineProperty(response, "type", { value: "opaqueredirect" });
      return response;
    });

    await expect(client.switchAgent("ses_agent_1", "plan")).rejects.toThrow(
      "opencode-v2-redirect-denied",
    );
  });
});
