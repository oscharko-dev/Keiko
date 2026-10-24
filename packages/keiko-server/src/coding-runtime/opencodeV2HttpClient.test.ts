import { describe, expect, it, vi } from "vitest";

import {
  OpenCodeV2HttpStatusError,
  OpenCodeV2PromptRefusedError,
  OpenCodeV2ReceiptMismatchError,
  classifyOpenCodeV2PromptFailure,
  createOpenCodeV2HttpClient,
  OPENCODE_PROMPT_FILE_MAX_BYTES,
  openCodeV2PromptFileData,
  OPENCODE_PROMPT_MEDIA_MAX_BYTES,
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

  // r4368344091: Keiko's verification continuation is marked on its message, beside a presentation.
  it("marks a turn Keiko started to continue the request in the message metadata", async () => {
    const { client, fetch } = promptClient();
    await client.prompt("ses_prompt_1", "verify", undefined, undefined, {
      origin: "verification-continuation",
    });
    expect(sentBody(fetch)).toEqual({
      text: "verify",
      metadata: { keikoTurnOriginV1: "verification-continuation" },
    });
    const display = { displayText: "shown", hiddenContextSha256: "a".repeat(64) };
    await client.prompt("ses_prompt_1", "hidden\n\nshown", undefined, display, {
      origin: "verification-continuation",
    });
    const second = fetch.mock.calls[1]?.[1]?.body;
    expect(typeof second === "string" ? JSON.parse(second) : undefined).toEqual({
      text: "hidden\n\nshown",
      metadata: {
        keikoContextPresentationV1: display,
        keikoTurnOriginV1: "verification-continuation",
      },
    });
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
      { uri: openCodeV2PromptFileData(Buffer.from("export const app = 1;\n")), name: "app.ts" },
      { uri: openCodeV2PromptFileData(Buffer.from("")), name: "my notes.md" },
    ];
    await client.prompt("ses_prompt_1", "see @src/app.ts", undefined, undefined, {
      delivery: "steer",
      files,
    });
    expect(sentBody(fetch)).toEqual({ text: "see @src/app.ts", files, delivery: "steer" });
  });

  // #3906 AC1: an admitted image or PDF travels inline under its own type, up to its own ceiling.
  it("sends an admitted image and PDF inline under their own types", async () => {
    const { client, fetch } = promptClient();
    const files = [
      { uri: openCodeV2PromptFileData(Buffer.from("png"), "image/png"), name: "screen.png" },
      {
        uri: openCodeV2PromptFileData(
          Buffer.alloc(OPENCODE_PROMPT_MEDIA_MAX_BYTES, 37),
          "application/pdf",
        ),
        name: "spec.pdf",
      },
    ];
    await client.prompt("ses_prompt_1", "see these", undefined, undefined, { files });
    expect(sentBody(fetch)).toEqual({ text: "see these", files });
  });

  it("copies only the two admitted fields of a file, whatever else the caller object carries", async () => {
    const { client, fetch } = promptClient();
    const uri = openCodeV2PromptFileData(Buffer.from("b"));
    const file = { uri, name: "b.ts", description: "x", mention: { start: 0 } };
    await client.prompt("ses_prompt_1", "t", undefined, undefined, { files: [file] });
    expect(sentBody(fetch)).toEqual({ text: "t", files: [{ uri, name: "b.ts" }] });
  });

  it.each([
    ["a relative uri", { uri: "src/app.ts", name: "app.ts" }],
    ["a remote uri", { uri: "https://example.invalid/a.ts", name: "a.ts" }],
    // A path the runtime would open itself, after Keiko's check (#3897 review).
    ["a file uri", { uri: "file:///work/space/a.ts", name: "a.ts" }],
    ["another media type", { uri: "data:text/html;base64,PGI+", name: "a.ts" }],
    ["an image type no model receives", { uri: "data:image/svg+xml;base64,PGI+", name: "a.svg" }],
    [
      "an oversized image",
      {
        uri: openCodeV2PromptFileData(
          Buffer.alloc(OPENCODE_PROMPT_MEDIA_MAX_BYTES + 1, 1),
          "image/png",
        ),
        name: "a.png",
      },
    ],
    ["non-canonical base64", { uri: "data:text/plain;base64,YQ", name: "a.ts" }],
    ["base64 noise", { uri: "data:text/plain;base64,Y Q==", name: "a.ts" }],
    [
      "an oversized attachment",
      {
        uri: openCodeV2PromptFileData(Buffer.alloc(OPENCODE_PROMPT_FILE_MAX_BYTES + 1, 97)),
        name: "a.ts",
      },
    ],
    ["an empty name", { uri: openCodeV2PromptFileData(Buffer.from("a")), name: "" }],
    ["a control name", { uri: openCodeV2PromptFileData(Buffer.from("a")), name: "a\n.ts" }],
    [
      "an oversized name",
      { uri: openCodeV2PromptFileData(Buffer.from("a")), name: "n".repeat(256) },
    ],
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

// A delivery whose acknowledgement is lost must be retried under the SAME native message id: the
// client sends the id the caller bound, reconciles the receipt against it, and classifies every
// failure by what it proves about the producer's side (PR #4064 review, ADR-0137 D10).
describe("OpenCode V2 prompt identity", () => {
  const SESSION = "ses_prompt_1";
  const MESSAGE = "msg_16b08469d001DaT0xxHG2PAKe6";

  const receipt = (overrides: Record<string, unknown> = {}): Response =>
    new Response(
      JSON.stringify({
        data: { id: MESSAGE, sessionID: SESSION, type: "user", delivery: "queue", ...overrides },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  function clientFor(respond: () => Promise<Response>): {
    readonly client: ReturnType<typeof createOpenCodeV2HttpClient>;
    readonly fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
  } {
    const fetch = vi.fn<typeof globalThis.fetch>(respond);
    return {
      client: createOpenCodeV2HttpClient({
        endpoint: "http://127.0.0.1:1984/",
        password: "test-only",
        fetch,
      }),
      fetch,
    };
  }

  const send = (client: ReturnType<typeof createOpenCodeV2HttpClient>): Promise<void> =>
    client.prompt(SESSION, "also this", undefined, undefined, { id: MESSAGE, delivery: "queue" });

  async function failureOf(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error("expected the prompt to fail");
  }

  it("sends the message id beside the text and accepts the receipt that names it", async () => {
    const { client, fetch } = clientFor(() => Promise.resolve(receipt()));
    await expect(send(client)).resolves.toBeUndefined();
    const sent = fetch.mock.calls[0]?.[1]?.body;
    expect(typeof sent === "string" ? JSON.parse(sent) : undefined).toEqual({
      text: "also this",
      id: MESSAGE,
      delivery: "queue",
    });
  });

  it.each([
    ["an id other than the one sent", { id: "msg_16b08469d002OTHEROTHEROTH" }],
    ["another session", { sessionID: "ses_other_1" }],
    ["no id at all", { id: undefined }],
  ])(
    "fails as accepted-under-another-identity when the receipt names %s",
    async (_label, change) => {
      const { client } = clientFor(() => Promise.resolve(receipt(change)));
      const error = await failureOf(send(client));
      expect(error).toBeInstanceOf(OpenCodeV2ReceiptMismatchError);
      expect(classifyOpenCodeV2PromptFailure(error)).toBe("receipt-mismatch");
    },
  );

  it("does not hold a prompt that carries no id to a receipt", async () => {
    const { client } = clientFor(() => Promise.resolve(receipt({ id: "msg_anything" })));
    await expect(client.prompt(SESSION, "plain")).resolves.toBeUndefined();
  });

  it.each([
    ["a malformed id", { id: "not-a-message-id" }],
    ["an id with a path separator", { id: "msg_a/../b" }],
    ["an oversized id", { id: `msg_${"a".repeat(252)}` }],
  ])("refuses %s before any request leaves the process", async (_label, inputs) => {
    const { client, fetch } = clientFor(() => Promise.resolve(receipt()));
    const error = await failureOf(client.prompt(SESSION, "t", undefined, undefined, inputs));
    expect(error).toBeInstanceOf(OpenCodeV2PromptRefusedError);
    expect((error as Error).message).toBe("opencode-v2-message-invalid");
    expect(classifyOpenCodeV2PromptFailure(error)).toBe("not-submitted");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps every pre-send refusal's own message and classifies it as not submitted", async () => {
    const { client, fetch } = clientFor(() => Promise.resolve(receipt()));
    const cases: readonly [Promise<unknown>, string][] = [
      [client.prompt(SESSION, "x".repeat(65_537)), "opencode-v2-prompt-oversized"],
      [client.prompt("not-a-session", "t"), "opencode-v2-session-invalid"],
      [
        client.prompt(SESSION, "t", undefined, { displayText: "d", hiddenContextSha256: "x" }),
        "opencode-v2-prompt-display-invalid",
      ],
    ];
    for (const [attempt, message] of cases) {
      const error = await failureOf(attempt);
      expect((error as Error).message).toBe(message);
      expect(classifyOpenCodeV2PromptFailure(error)).toBe("not-submitted");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([400, 401, 404, 409])(
    "classifies the declared HTTP %i refusal as not submitted",
    async (status) => {
      const { client } = clientFor(() =>
        Promise.resolve(
          new Response("{}", { status, headers: { "content-type": "application/json" } }),
        ),
      );
      const error = await failureOf(send(client));
      expect(error).toBeInstanceOf(OpenCodeV2HttpStatusError);
      expect((error as OpenCodeV2HttpStatusError).status).toBe(status);
      expect((error as Error).message).toBe("opencode-v2-response-invalid");
      expect(classifyOpenCodeV2PromptFailure(error)).toBe("not-submitted");
    },
  );

  it.each([500, 502, 503])(
    "classifies an undeclared HTTP %i as possibly accepted: the producer may have stored it",
    async (status) => {
      const { client } = clientFor(() =>
        Promise.resolve(
          new Response("{}", { status, headers: { "content-type": "application/json" } }),
        ),
      );
      expect(classifyOpenCodeV2PromptFailure(await failureOf(send(client)))).toBe(
        "possibly-accepted",
      );
    },
  );

  const LOST_AFTER_SENDING: readonly (readonly [string, () => Promise<Response>])[] = [
    ["a reset connection", (): Promise<Response> => Promise.reject(new TypeError("fetch failed"))],
    [
      "a timed-out request",
      (): Promise<Response> =>
        Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
    ],
    [
      "an abort",
      (): Promise<Response> => Promise.reject(new DOMException("aborted", "AbortError")),
    ],
    [
      "a 2xx whose body is not JSON",
      (): Promise<Response> => Promise.resolve(new Response("ok", { status: 200 })),
    ],
    [
      "a 2xx whose body has no data",
      (): Promise<Response> =>
        Promise.resolve(
          new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
        ),
    ],
  ];

  it.each(LOST_AFTER_SENDING)(
    "classifies %s after the request was sent as possibly accepted",
    async (_label, respond) => {
      const { client, fetch } = clientFor(respond);
      const error = await failureOf(send(client));
      expect(fetch).toHaveBeenCalledOnce();
      expect(classifyOpenCodeV2PromptFailure(error)).toBe("possibly-accepted");
    },
  );

  it("classifies a failure it does not recognise as possibly accepted, never as not submitted", () => {
    for (const unknown of [new Error("anything"), "text", undefined, null, 7]) {
      expect(classifyOpenCodeV2PromptFailure(unknown)).toBe("possibly-accepted");
    }
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

  it("reads every file changed since a user message, and refuses a malformed one", async () => {
    const { client, fetch } = clientWith(() => json({ data: [] }));

    await client.sessionDiff("ses_diff_1", undefined, "msg_human_1");

    expect(fetch.mock.calls[0]?.[0]).toEqual(
      new URL("http://127.0.0.1:1984/api/session/ses_diff_1/diff?context=0&from=msg_human_1"),
    );
    await expect(client.sessionDiff("ses_diff_1", undefined, "msg_a&to=x")).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
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

// C02 (ADR-0137 D10): the runtime's slash commands. The listing is untrusted display text and the
// session command carries no message id, so the client keeps both shapes closed.
describe("OpenCode V2 slash commands", () => {
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

  it("lists the commands with their closed fields and nothing the entries add", async () => {
    const { client, fetch } = clientWith(() =>
      json({
        location: { directory: "/workspace" },
        data: [
          { name: "init", description: "guided AGENTS.md setup", template: "SECRET-TEMPLATE" },
          { name: "review" },
        ],
      }),
    );

    await expect(client.commands()).resolves.toEqual([
      { name: "init", description: "guided AGENTS.md setup" },
      { name: "review" },
    ]);

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toEqual(new URL("http://127.0.0.1:1984/api/command"));
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(init?.headers).toMatchObject({ Authorization: AUTHORIZATION });
    expect(init?.body).toBeUndefined();
  });

  it("drops an entry whose name is not a bounded command name and a description that is not text", async () => {
    const { client } = clientWith(() =>
      json({
        data: [
          { name: "ok", description: "fine" },
          { name: "two words" },
          { name: "../escape" },
          { name: "" },
          { name: 7 },
          {},
          { name: "tabbed", description: "bad\tdescription" },
          { name: "long", description: "d".repeat(1_025) },
          { name: "empty", description: "" },
        ],
      }),
    );

    await expect(client.commands()).resolves.toEqual([
      { name: "ok", description: "fine" },
      { name: "tabbed" },
      { name: "long" },
      { name: "empty" },
    ]);
  });

  it.each([
    ["a non-array payload", { data: {} }],
    ["no data", { location: { directory: "/workspace" } }],
    ["a non-object entry", { data: ["init"] }],
    ["more entries than the client reads", { data: Array.from({ length: 257 }, () => ({})) }],
  ])("rejects a listing with %s", async (_name, body) => {
    const { client } = clientWith(() => json(body));

    await expect(client.commands()).rejects.toThrow("opencode-v2-envelope-invalid");
  });

  it("surfaces the runtime's refusal of the listing instead of an empty list", async () => {
    const { client } = clientWith(() => json({ _tag: "UnauthorizedError" }, 401));

    await expect(client.commands()).rejects.toBeInstanceOf(OpenCodeV2HttpStatusError);
  });

  it("runs a command with the closed body and files, and reads the empty 204 answer", async () => {
    const { client, fetch } = clientWith(() => new Response(null, { status: 204 }));
    const file = { uri: openCodeV2PromptFileData(Buffer.from("notes\n")), name: "NOTES.md" };

    await expect(
      client.command("ses_cmd_1", "review", "the main branch", undefined, { files: [file] }),
    ).resolves.toBeUndefined();

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toEqual(new URL("http://127.0.0.1:1984/api/session/ses_cmd_1/command"));
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(init?.body).toBe(
      JSON.stringify({ name: "review", text: "the main branch", files: [file] }),
    );
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: AUTHORIZATION,
    });
  });

  it("sends an argument text with a bang and code spans that never touch", async () => {
    const { client, fetch } = clientWith(() => new Response(null, { status: 204 }));
    const text = "Careful! Run `npm test` and `npm run lint` first!";

    await client.command("ses_cmd_1", "review", text);

    const [, init] = fetch.mock.calls[0] ?? [];
    expect(init?.body).toBe(JSON.stringify({ name: "review", text }));
  });

  it("sends an empty argument text and no id, delivery or metadata", async () => {
    const { client, fetch } = clientWith(() => new Response(null, { status: 204 }));

    await client.command("ses_cmd_1", "init", "");

    const [, init] = fetch.mock.calls[0] ?? [];
    expect(init?.body).toBe(JSON.stringify({ name: "init", text: "" }));
  });

  it.each([
    ["an unsafe session id", ["ses_a/../b", "review", ""], "opencode-v2-session-invalid"],
    ["a name with a space", ["ses_cmd_1", "re view", ""], "opencode-v2-command-invalid"],
    ["a name with a slash", ["ses_cmd_1", "/review", ""], "opencode-v2-command-invalid"],
    ["an empty name", ["ses_cmd_1", "", ""], "opencode-v2-command-invalid"],
    [
      "an oversized text",
      ["ses_cmd_1", "review", "x".repeat(65_537)],
      "opencode-v2-prompt-oversized",
    ],
    // #3903: the producer's command expander runs every bang-backtick block in the argument text, in
    // the project directory and outside every permission hook (proven against the original
    // executable), so the text can never carry one, whatever template it is expanded into.
    [
      "an argument text that forms a shell block",
      ["ses_cmd_1", "review", "the branch !`touch pwned` please"],
      "opencode-v2-command-shell-substitution",
    ],
    [
      "an argument text that opens a shell block",
      ["ses_cmd_1", "review", "!`"],
      "opencode-v2-command-shell-substitution",
    ],
  ] as const)("refuses %s before any byte leaves the process", async (_name, args, message) => {
    const { client, fetch } = clientWith(() => new Response(null, { status: 204 }));

    const [sessionId, name, text] = args;

    const failure: unknown = await client
      .command(sessionId, name, text)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OpenCodeV2PromptRefusedError);
    expect((failure as Error).message).toBe(message);
    expect(classifyOpenCodeV2PromptFailure(failure)).toBe("not-submitted");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a malformed attachment and more attachments than a prompt takes", async () => {
    const { client, fetch } = clientWith(() => new Response(null, { status: 204 }));
    const file = (index: number): { uri: string; name: string } => ({
      uri: `file:///workspace/f${String(index)}.md`,
      name: `f${String(index)}.md`,
    });

    await expect(
      client.command("ses_cmd_1", "review", "", undefined, {
        files: [{ uri: "https://example.invalid/x", name: "x" }],
      }),
    ).rejects.toBeInstanceOf(OpenCodeV2PromptRefusedError);
    await expect(
      client.command("ses_cmd_1", "review", "", undefined, {
        files: Array.from({ length: 17 }, (_, index) => file(index)),
      }),
    ).rejects.toBeInstanceOf(OpenCodeV2PromptRefusedError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces an unknown command and a failed execution as the runtime's status", async () => {
    const notFound = clientWith(() =>
      json(
        { _tag: "CommandNotFoundError", command: "nope", message: "Command not found: nope" },
        404,
      ),
    );
    const failed = clientWith(() => json({ _tag: "CommandExecutionError" }, 500));

    const refusal: unknown = await notFound.client
      .command("ses_cmd_1", "nope", "")
      .catch((error: unknown) => error);
    const execution: unknown = await failed.client
      .command("ses_cmd_1", "review", "")
      .catch((error: unknown) => error);

    expect(refusal).toMatchObject({ name: "OpenCodeV2HttpStatusError", status: 404 });
    expect(execution).toMatchObject({ name: "OpenCodeV2HttpStatusError", status: 500 });
  });
});

// #3897 review: the runtime pages its session list (50 rows by default). The session-tree proof
// read only the first page, so a later child could never be proven the run's.
describe("OpenCode V2 agent and skill mentions (#3906)", () => {
  function clientWith(respond: (url: URL) => Response): {
    readonly client: ReturnType<typeof createOpenCodeV2HttpClient>;
    readonly fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
  } {
    const fetch = vi.fn<typeof globalThis.fetch>((input) =>
      Promise.resolve(respond(input instanceof URL ? input : new URL(new Request(input).url))),
    );
    return {
      client: createOpenCodeV2HttpClient({
        endpoint: "http://127.0.0.1:1984/",
        password: "test-only",
        fetch,
      }),
      fetch,
    };
  }

  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("lists only visible subagents by id, for the run's workspace, and never their prompt", async () => {
    const { client, fetch } = clientWith(() =>
      json({
        location: { directory: "/workspace/repo" },
        data: [
          { id: "build", name: "Build", mode: "primary", hidden: false },
          {
            id: "general",
            name: "General",
            mode: "subagent",
            hidden: false,
            description: "General",
            system: "SECRET-SYSTEM",
          },
          { id: "explore", name: "Explore", mode: "all", hidden: false },
          { id: "compaction", name: "Compaction", mode: "primary", hidden: true },
          { id: "title", name: "Title", mode: "subagent", hidden: true },
          { id: "../escape", name: "x", mode: "subagent", hidden: false },
        ],
      }),
    );

    const agents = await client.agents("/workspace/repo");

    expect(agents).toEqual([{ name: "general", description: "General" }, { name: "explore" }]);
    expect(JSON.stringify(agents)).not.toContain("SECRET-SYSTEM");
    const url = fetch.mock.calls[0]?.[0] as URL;
    expect(url.pathname).toBe("/api/agent");
    expect(url.searchParams.get("location[directory]")).toBe("/workspace/repo");
  });

  it("lists skills by id and name and never their path or content", async () => {
    const { client, fetch } = clientWith(() =>
      json({
        data: [
          {
            id: "review-method",
            name: "review-method",
            description: "A method",
            path: "/secret/SKILL.md",
            content: "SECRET-BODY",
          },
          { id: "bad id", name: "bad id" },
        ],
      }),
    );

    const skills = await client.skills("/workspace/repo");

    expect(skills).toEqual([
      { id: "review-method", name: "review-method", description: "A method" },
    ]);
    expect(JSON.stringify(skills)).not.toMatch(/SECRET/u);
    expect((fetch.mock.calls[0]?.[0] as URL).pathname).toBe("/api/skill");
    await expect(client.skills("relative/path")).rejects.toThrow("opencode-v2-directory-invalid");
  });

  it("sends mentions as the runtime's own attachments on a prompt and on a command", async () => {
    const { client, fetch } = clientWith(() => json({ data: { id: "msg_1" } }));
    const mentions = {
      agents: [{ name: "general", mention: { start: 4, end: 12, text: "@general" } }],
      skills: [{ id: "review-method" }],
    };

    await client.prompt("ses_prompt_1", "Ask @general now.", undefined, undefined, { mentions });
    await client.command("ses_prompt_1", "review", "main", undefined, { mentions });

    const bodies = fetch.mock.calls.map((call) => {
      const body = call[1]?.body;
      return JSON.parse(typeof body === "string" ? body : "null") as unknown;
    });
    expect(bodies[0]).toEqual({ text: "Ask @general now.", ...mentions });
    expect(bodies[1]).toEqual({ name: "review", text: "main", ...mentions });
  });

  it("refuses a malformed mention before a byte is sent", async () => {
    const { client, fetch } = clientWith(() => json({ data: { id: "msg_1" } }));

    await expect(
      client.prompt("ses_prompt_1", "x", undefined, undefined, {
        mentions: { agents: [{ name: "../escape" }] },
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("OpenCode V2 session list", () => {
  type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  function pagedFetch(pages: readonly Readonly<Record<string, unknown>>[]): {
    readonly fetch: FetchStub;
    readonly urls: string[];
  } {
    const urls: string[] = [];
    let index = 0;
    const fetch = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      urls.push(input instanceof Request ? input.url : input.toString());
      const page = pages[Math.min(index, pages.length - 1)];
      index += 1;
      return Promise.resolve(
        new Response(JSON.stringify(page), { headers: { "content-type": "application/json" } }),
      );
    });
    return { fetch, urls };
  }
  const rows = (from: number, count: number): readonly Readonly<Record<string, unknown>>[] =>
    Array.from({ length: count }, (_, index) => ({ id: `ses_${String(from + index)}` }));
  const client = (fetch: FetchStub): ReturnType<typeof createOpenCodeV2HttpClient> =>
    createOpenCodeV2HttpClient({
      endpoint: "http://127.0.0.1:1984/",
      password: "test-only",
      fetch,
    });

  it("reads every page of the session list to its end", async () => {
    const { fetch, urls } = pagedFetch([
      { data: rows(0, 100), cursor: { next: "page-2" } },
      { data: rows(100, 30), cursor: { next: null } },
    ]);
    const sessions = await client(fetch).sessions();
    expect(sessions).toHaveLength(130);
    expect(urls.map((url) => new URL(url).search)).toEqual([
      "?limit=100",
      "?limit=100&cursor=page-2",
    ]);
  });

  it("stops at a full last page without a next cursor", async () => {
    const { fetch, urls } = pagedFetch([{ data: rows(0, 100), cursor: {} }]);
    await expect(client(fetch).sessions()).resolves.toHaveLength(100);
    expect(urls).toHaveLength(1);
  });

  it("refuses a repeated cursor and a list beyond its bound", async () => {
    const repeated = pagedFetch([{ data: rows(0, 100), cursor: { next: "same" } }]);
    await expect(client(repeated.fetch).sessions()).rejects.toThrow("opencode-v2-cursor-invalid");
    let page = 0;
    const endless = vi.fn<FetchStub>((): Promise<Response> => {
      page += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({ data: rows(page * 100, 100), cursor: { next: `page-${String(page)}` } }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    });
    await expect(client(endless).sessions()).rejects.toThrow("opencode-v2-sessions-oversized");
  });
});

describe("OpenCode V2 session inbox", () => {
  const AUTHORIZATION = `Basic ${Buffer.from("opencode:test-only", "utf8").toString("base64")}`;
  const SESSION = "ses_inbox_1";
  const FIRST = "msg_16b08469d001DaT0xxHG2PAKe6";
  const SECOND = "msg_16b08469d002DaT0xxHG2PAKe6";

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

  const entry = (id: string, type: string, delivery: string, extra = {}): unknown => ({
    id,
    sessionID: SESSION,
    time: { created: 1 },
    type,
    delivery,
    payload: { text: "PAYLOAD-TEXT-THAT-MUST-NOT-BE-COPIED" },
    ...extra,
  });

  it("lists the closed fields of every entry and never copies the payload", async () => {
    const { client, fetch } = clientWith(() =>
      json({
        data: [
          entry(FIRST, "user", "queue"),
          entry(SECOND, "user", "steer"),
          entry("msg_synthetic", "synthetic", "steer"),
          entry("msg_compaction", "compaction", "queue"),
          entry("msg_move", "move", "queue"),
        ],
      }),
    );

    const listed = await client.inbox(SESSION);

    expect(listed).toEqual([
      { id: FIRST, kind: "user", delivery: "queue" },
      { id: SECOND, kind: "user", delivery: "steer" },
      { id: "msg_synthetic", kind: "other", delivery: "steer" },
      { id: "msg_compaction", kind: "other", delivery: "queue" },
      { id: "msg_move", kind: "other", delivery: "queue" },
    ]);
    expect(JSON.stringify(listed)).not.toContain("PAYLOAD-TEXT");
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toEqual(new URL(`http://127.0.0.1:1984/api/session/${SESSION}/inbox`));
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(init?.headers).toMatchObject({ Authorization: AUTHORIZATION });
    expect(init?.body).toBeUndefined();
  });

  it("drops an entry of another session, with a bad id or with an unknown delivery", async () => {
    const { client } = clientWith(() =>
      json({
        data: [
          entry(FIRST, "user", "queue"),
          entry(SECOND, "user", "queue", { sessionID: "ses_other" }),
          entry("not-a-message-id", "user", "queue"),
          entry("msg_a b", "user", "queue"),
          entry("msg_later", "user", "later"),
          entry("msg_no_type", "user", "steer", { type: undefined }),
          { sessionID: SESSION, delivery: "steer", type: "user" },
        ],
      }),
    );

    await expect(client.inbox(SESSION)).resolves.toEqual([
      { id: FIRST, kind: "user", delivery: "queue" },
      { id: "msg_no_type", kind: "other", delivery: "steer" },
    ]);
  });

  it.each([
    ["a non-array payload", { data: {} }],
    ["no data", {}],
    ["a non-object entry", { data: ["msg_x"] }],
    ["more entries than the client reads", { data: Array.from({ length: 257 }, () => ({})) }],
  ])("rejects a listing with %s", async (_name, body) => {
    const { client } = clientWith(() => json(body));

    await expect(client.inbox(SESSION)).rejects.toThrow("opencode-v2-envelope-invalid");
  });

  it("surfaces the runtime's refusal of the listing instead of an empty list", async () => {
    const { client } = clientWith(() => json({ _tag: "SessionNotFoundError" }, 404));

    await expect(client.inbox(SESSION)).rejects.toMatchObject({
      name: "OpenCodeV2HttpStatusError",
      status: 404,
    });
  });

  it("refuses a session id that is not a session id before any byte is sent", async () => {
    const { client, fetch } = clientWith(() => json({ data: [] }));

    await expect(client.inbox("../session")).rejects.toThrow("opencode-v2-session-invalid");
    await expect(client.cancelInboxEntry("../session", FIRST)).rejects.toThrow(
      "opencode-v2-session-invalid",
    );
    await expect(client.promoteInboxEntry("../session", FIRST)).rejects.toThrow(
      "opencode-v2-session-invalid",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("withdraws one entry with a DELETE that carries no body, and reads the empty 204 answer", async () => {
    const { client, fetch } = clientWith(() => new Response(null, { status: 204 }));

    await expect(client.cancelInboxEntry(SESSION, FIRST)).resolves.toBeUndefined();

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toEqual(new URL(`http://127.0.0.1:1984/api/session/${SESSION}/inbox/${FIRST}`));
    expect(init).toMatchObject({ method: "DELETE", redirect: "manual" });
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toMatchObject({ Authorization: AUTHORIZATION });
  });

  it("promotes one entry with a PATCH that names only the steer delivery", async () => {
    const { client, fetch } = clientWith(() => new Response(null, { status: 204 }));

    await expect(client.promoteInboxEntry(SESSION, FIRST)).resolves.toBeUndefined();

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toEqual(new URL(`http://127.0.0.1:1984/api/session/${SESSION}/inbox/${FIRST}`));
    expect(init).toMatchObject({ method: "PATCH", redirect: "manual" });
    expect(init?.body).toBe(JSON.stringify({ delivery: "steer" }));
    expect(init?.headers).toMatchObject({
      Authorization: AUTHORIZATION,
      "Content-Type": "application/json",
    });
  });

  it("refuses an entry id that is not a message id before any byte is sent", async () => {
    const { client, fetch } = clientWith(() => new Response(null, { status: 204 }));

    for (const id of ["", "ses_abc", "msg_../x", "msg_a b", "msg_", `msg_${"a".repeat(252)}`]) {
      await expect(client.cancelInboxEntry(SESSION, id), id).rejects.toThrow(
        "opencode-v2-message-invalid",
      );
      await expect(client.promoteInboxEntry(SESSION, id), id).rejects.toThrow(
        "opencode-v2-message-invalid",
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces the runtime's conflict and its unknown session as the status, not as success", async () => {
    const conflict = clientWith(() => json({ _tag: "ConflictError" }, 409));
    const missing = clientWith(() => json({ _tag: "SessionNotFoundError" }, 404));

    const refused: unknown = await conflict.client
      .promoteInboxEntry(SESSION, FIRST)
      .catch((error: unknown) => error);
    const absent: unknown = await missing.client
      .cancelInboxEntry(SESSION, FIRST)
      .catch((error: unknown) => error);

    expect(refused).toMatchObject({ name: "OpenCodeV2HttpStatusError", status: 409 });
    expect(absent).toMatchObject({ name: "OpenCodeV2HttpStatusError", status: 404 });
  });

  it("reads the ids of the newest page of messages and nothing else of them", async () => {
    const { client, fetch } = clientWith(() =>
      json({
        data: [
          { id: SECOND, type: "user", text: "MESSAGE-TEXT-THAT-MUST-NOT-BE-COPIED" },
          { id: "not-a-message-id" },
          { id: FIRST },
          { type: "user" },
        ],
      }),
    );

    const ids = await client.recentMessageIds(SESSION);

    expect(ids).toEqual([SECOND, FIRST]);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toEqual(
      new URL(`http://127.0.0.1:1984/api/session/${SESSION}/message?limit=100&order=desc`),
    );
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
  });

  it("surfaces a failed message read instead of an empty page", async () => {
    const { client } = clientWith(() => json({ _tag: "SessionNotFoundError" }, 404));

    await expect(client.recentMessageIds(SESSION)).rejects.toMatchObject({ status: 404 });
  });
});
