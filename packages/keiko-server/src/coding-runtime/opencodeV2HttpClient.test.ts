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

describe("OpenCode V2 prompt inputs", () => {
  const envelope = (): Response =>
    new Response(JSON.stringify({ data: { id: "msg_1" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  function promptClient(): {
    readonly client: ReturnType<typeof createOpenCodeV2HttpClient>;
    readonly fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
  } {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(envelope()));
    return {
      client: createOpenCodeV2HttpClient({
        endpoint: "http://127.0.0.1:1984/",
        password: "test-only",
        fetch,
      }),
      fetch,
    };
  }

  function sentBody(fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>): unknown {
    const body = fetch.mock.calls[0]?.[1]?.body;
    return typeof body === "string" ? JSON.parse(body) : undefined;
  }

  it("keeps the ordinary prompt body byte for byte: text alone, or text and the presentation", async () => {
    const { client, fetch } = promptClient();
    await client.prompt("ses_prompt_1", "plain");
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ text: "plain" }));
    const display = { displayText: "shown", hiddenContextSha256: "a".repeat(64) };
    await client.prompt("ses_prompt_1", "hidden\n\nshown", undefined, display, {});
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({
        text: "hidden\n\nshown",
        metadata: { keikoContextPresentationV1: display },
      }),
    );
  });

  it.each(["steer", "queue"] as const)(
    "sends delivery %s to the session prompt route beside the text",
    async (delivery) => {
      const { client, fetch } = promptClient();
      await client.prompt("ses_prompt_1", "also this", undefined, undefined, { delivery });
      expect(fetch.mock.calls[0]?.[0]).toEqual(
        new URL("http://127.0.0.1:1984/api/session/ses_prompt_1/prompt"),
      );
      expect(sentBody(fetch)).toEqual({ text: "also this", delivery });
    },
  );

  it("sends each file as the closed uri and name pair of the pinned attachment schema", async () => {
    const { client, fetch } = promptClient();
    const files = [
      { uri: "file:///work/space/src/app.ts", name: "app.ts" },
      { uri: "file:///work/space/my%20notes.md", name: "my notes.md" },
    ];
    await client.prompt("ses_prompt_1", "see @src/app.ts", undefined, undefined, {
      delivery: "steer",
      files,
    });
    expect(sentBody(fetch)).toEqual({ text: "see @src/app.ts", files, delivery: "steer" });
  });

  it("copies only the two admitted fields of a file, whatever else the caller object carries", async () => {
    const { client, fetch } = promptClient();
    const file = { uri: "file:///a/b.ts", name: "b.ts", description: "x", mention: { start: 0 } };
    await client.prompt("ses_prompt_1", "t", undefined, undefined, { files: [file] });
    expect(sentBody(fetch)).toEqual({
      text: "t",
      files: [{ uri: "file:///a/b.ts", name: "b.ts" }],
    });
  });

  it.each([
    ["a relative uri", { uri: "src/app.ts", name: "app.ts" }],
    ["a remote uri", { uri: "https://example.invalid/a.ts", name: "a.ts" }],
    ["a host uri", { uri: "file://host/a.ts", name: "a.ts" }],
    ["a query", { uri: "file:///a.ts?x=1", name: "a.ts" }],
    ["a fragment", { uri: "file:///a.ts#frag", name: "a.ts" }],
    ["a control character", { uri: "file:///a\u0000.ts", name: "a.ts" }],
    ["an empty name", { uri: "file:///a.ts", name: "" }],
    ["a control name", { uri: "file:///a.ts", name: "a\n.ts" }],
    ["an oversized name", { uri: "file:///a.ts", name: "n".repeat(256) }],
  ])("refuses a file with %s before any request leaves the process", async (_label, file) => {
    const { client, fetch } = promptClient();
    await expect(
      client.prompt("ses_prompt_1", "t", undefined, undefined, { files: [file] }),
    ).rejects.toThrow("opencode-v2-prompt-file-invalid");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses more than sixteen files and an unknown delivery", async () => {
    const { client, fetch } = promptClient();
    const files = Array.from({ length: 17 }, (_, index) => ({
      uri: `file:///work/f${String(index)}.ts`,
      name: `f${String(index)}.ts`,
    }));
    await expect(
      client.prompt("ses_prompt_1", "t", undefined, undefined, { files }),
    ).rejects.toThrow("opencode-v2-prompt-files-oversized");
    for (const delivery of ["interrupt", "", null, 1]) {
      await expect(
        client.prompt("ses_prompt_1", "t", undefined, undefined, {
          delivery: delivery as "steer",
        }),
      ).rejects.toThrow("opencode-v2-prompt-delivery-invalid");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces the runtime's refusal of a prompt instead of reporting it delivered", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ _tag: "InvalidRequestError", field: "files" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const client = createOpenCodeV2HttpClient({
      endpoint: "http://127.0.0.1:1984/",
      password: "test-only",
      fetch,
    });
    await expect(
      client.prompt("ses_prompt_1", "t", undefined, undefined, { delivery: "queue" }),
    ).rejects.toThrow("opencode-v2-response-invalid");
  });
});

describe("OpenCode V2 session diff and revert", () => {
  const AUTHORIZATION = `Basic ${Buffer.from("opencode:test-only", "utf8").toString("base64")}`;

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

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  const PATCH = "diff --git a/secret.txt b/secret.txt\n+the-model-wrote-this\n";

  it("reads the newest turn's diff with hunks only and keeps neither patch text nor extra fields", async () => {
    const { client, fetch } = clientWith(() =>
      json({
        data: [
          {
            file: "src/a.ts",
            patch: PATCH,
            additions: 3,
            deletions: 1,
            status: "modified",
            unexpected: "dropped",
          },
          { file: "src/b.ts", patch: PATCH, additions: 0, deletions: 4, status: "deleted" },
        ],
      }),
    );

    const diffs = await client.sessionDiff("ses_diff_1");

    expect(diffs).toEqual([
      { file: "src/a.ts", status: "modified", additions: 3, deletions: 1 },
      { file: "src/b.ts", status: "deleted", additions: 0, deletions: 4 },
    ]);
    expect(JSON.stringify(diffs)).not.toContain("the-model-wrote-this");
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toEqual(new URL("http://127.0.0.1:1984/api/session/ses_diff_1/diff?context=0"));
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(init?.headers).toMatchObject({ Authorization: AUTHORIZATION });
    expect(init?.body).toBeUndefined();
  });

  it.each([
    ["a non-array payload", { data: {} }],
    ["a missing data envelope", {}],
    ["an empty file name", { data: [{ file: "", additions: 1, deletions: 0, status: "added" }] }],
    ["a negative count", { data: [{ file: "a", additions: -1, deletions: 0, status: "added" }] }],
    [
      "a fractional count",
      { data: [{ file: "a", additions: 1.5, deletions: 0, status: "added" }] },
    ],
    ["an unknown status", { data: [{ file: "a", additions: 1, deletions: 0, status: "renamed" }] }],
    ["a non-object entry", { data: ["a"] }],
  ])("rejects a diff with %s instead of counting it", async (_name, body) => {
    const { client } = clientWith(() => json(body));

    await expect(client.sessionDiff("ses_diff_1")).rejects.toThrow(/opencode-v2-envelope-invalid/u);
  });

  it("rejects a diff that names more files than the client admits", async () => {
    const files = Array.from({ length: 4097 }, (_, index) => ({
      file: `f${String(index)}`,
      additions: 1,
      deletions: 0,
      status: "added",
    }));
    const { client } = clientWith(() => json({ data: files }));

    await expect(client.sessionDiff("ses_diff_1")).rejects.toThrow("opencode-v2-envelope-invalid");
  });

  it("stages a revert at a user message with the closed body and returns the restored files", async () => {
    const { client, fetch } = clientWith(() =>
      json({
        data: {
          messageID: "msg_boundary_1",
          snapshot: "abc",
          files: [{ file: "a", patch: PATCH, additions: 2, deletions: 2, status: "modified" }],
        },
      }),
    );

    await expect(client.stageRevert("ses_revert_1", "msg_boundary_1")).resolves.toEqual({
      messageId: "msg_boundary_1",
      files: [{ file: "a", status: "modified", additions: 2, deletions: 2 }],
    });

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toEqual(new URL("http://127.0.0.1:1984/api/session/ses_revert_1/revert/stage"));
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(init?.body).toBe(JSON.stringify({ messageID: "msg_boundary_1", files: true }));
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: AUTHORIZATION,
    });
  });

  it("reads a staged revert that restored no file as an empty list", async () => {
    const { client } = clientWith(() => json({ data: { messageID: "msg_boundary_1" } }));

    await expect(client.stageRevert("ses_revert_1", "msg_boundary_1")).resolves.toEqual({
      messageId: "msg_boundary_1",
      files: [],
    });
  });

  it.each([
    ["no message id", { data: { files: [] } }],
    ["a foreign message id", { data: { messageID: "ses_boundary_1" } }],
    ["a malformed file entry", { data: { messageID: "msg_boundary_1", files: [{}] } }],
    ["a non-object payload", { data: [] }],
  ])("rejects a staged revert with %s", async (_name, body) => {
    const { client } = clientWith(() => json(body));

    await expect(client.stageRevert("ses_revert_1", "msg_boundary_1")).rejects.toThrow(
      "opencode-v2-envelope-invalid",
    );
  });

  it.each(["", "ses_boundary_1", "msg_", "msg_a/../b", "msg_a b", "msg_a\n"])(
    "refuses an unsafe message id before any request leaves the process (%j)",
    async (messageId) => {
      const { client, fetch } = clientWith(() => json({ data: { messageID: "msg_x" } }));

      await expect(client.stageRevert("ses_revert_1", messageId)).rejects.toThrow(
        "opencode-v2-message-invalid",
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["", "msg_revert_1", "ses_", "ses_a/../b", "ses_a b"])(
    "refuses an unsafe session id on every revert and diff route (%j)",
    async (sessionId) => {
      const { client, fetch } = clientWith(() => new Response(null, { status: 204 }));

      await expect(client.sessionDiff(sessionId)).rejects.toThrow("opencode-v2-session-invalid");
      await expect(client.stageRevert(sessionId, "msg_revert_1")).rejects.toThrow(
        "opencode-v2-session-invalid",
      );
      await expect(client.commitRevert(sessionId)).rejects.toThrow("opencode-v2-session-invalid");
      await expect(client.clearRevert(sessionId)).rejects.toThrow("opencode-v2-session-invalid");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("commits and clears a staged revert without a request body", async () => {
    const { client, fetch } = clientWith(() => new Response(null, { status: 204 }));

    await expect(client.commitRevert("ses_revert_1")).resolves.toBeUndefined();
    await expect(client.clearRevert("ses_revert_1")).resolves.toBeUndefined();

    const [commit, clear] = fetch.mock.calls;
    expect(commit?.[0]).toEqual(
      new URL("http://127.0.0.1:1984/api/session/ses_revert_1/revert/commit"),
    );
    expect(commit?.[1]).toMatchObject({ method: "POST", redirect: "manual" });
    expect(clear?.[0]).toEqual(new URL("http://127.0.0.1:1984/api/session/ses_revert_1/revert"));
    expect(clear?.[1]).toMatchObject({ method: "DELETE", redirect: "manual" });
    for (const call of fetch.mock.calls) {
      expect(call[1]?.body).toBeUndefined();
      expect(call[1]?.headers).not.toHaveProperty("Content-Type");
    }
  });

  it("surfaces the runtime's refusal of a busy session instead of reporting a revert", async () => {
    const { client } = clientWith(() =>
      json({ _tag: "SessionBusyError", sessionID: "ses_revert_1", message: "busy" }, 409),
    );

    await expect(client.stageRevert("ses_revert_1", "msg_revert_1")).rejects.toThrow(
      "opencode-v2-response-invalid",
    );
    await expect(client.commitRevert("ses_revert_1")).rejects.toThrow(
      "opencode-v2-response-invalid",
    );
    await expect(client.clearRevert("ses_revert_1")).rejects.toThrow(
      "opencode-v2-response-invalid",
    );
  });
});
