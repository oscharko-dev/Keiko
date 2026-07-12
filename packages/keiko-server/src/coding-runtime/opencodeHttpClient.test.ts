import { describe, expect, it, vi } from "vitest";
import { createOpenCodeHttpClient, parseOpenCodeChildEndpoint } from "./opencodeHttpClient.js";

interface OpenCodeEventClient {
  readonly history: (
    checkpoints: Readonly<Record<string, number>>,
  ) => Promise<readonly Record<string, unknown>[]>;
  readonly events: () => AsyncIterable<{
    readonly id?: string;
    readonly event?: string;
    readonly data: Readonly<Record<string, unknown>>;
  }>;
}

type OpenCodeSessionStatus =
  | { readonly type: "idle" }
  | { readonly type: "busy" }
  | {
      readonly type: "retry";
      readonly attempt: number;
      readonly message: string;
      readonly next: number;
    };

interface OpenCodeRunControlHttpClient {
  readonly promptAsync: (sessionId: string, text: string) => Promise<void>;
  readonly abortSession: (sessionId: string) => Promise<boolean>;
  readonly sessionStatuses: () => Promise<Readonly<Record<string, OpenCodeSessionStatus>>>;
}

interface OpenCodeQuestionRequest {
  readonly id: string;
  readonly sessionID: string;
  readonly questions: readonly {
    readonly question: string;
    readonly header: string;
    readonly options: readonly { readonly label: string; readonly description: string }[];
    readonly multiple?: boolean | undefined;
    readonly custom?: boolean | undefined;
  }[];
}

interface OpenCodeQuestionHttpClient {
  readonly listQuestions: () => Promise<readonly OpenCodeQuestionRequest[]>;
  readonly answerQuestion: (
    requestId: string,
    answers: readonly (readonly string[])[],
  ) => Promise<boolean>;
  readonly rejectQuestion: (requestId: string) => Promise<boolean>;
}

function abortableFetch(_url: URL | RequestInfo, init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = init?.signal;
    if (signal?.aborted === true) {
      reject(new Error("aborted"));
      return;
    }
    signal?.addEventListener(
      "abort",
      () => {
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

function requestUrl(value: URL | RequestInfo): string {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.href;
  return value.url;
}

describe("OpenCode HTTP client", () => {
  it("creates the fixed session with only a server-owned non-default title", async () => {
    let request: {
      readonly method?: string | undefined;
      readonly headers?: HeadersInit | undefined;
      readonly body?: BodyInit | null | undefined;
    } = {};
    const client = createOpenCodeHttpClient({
      endpoint: "http://127.0.0.1:43123",
      password: "p".repeat(43),
      fetch: (_url, init) => {
        request = {
          method: init?.method,
          headers: init?.headers,
          body: init?.body,
        };
        return Promise.resolve(
          new Response('{"id":"ses_1"}', {
            headers: { "content-type": "application/json" },
          }),
        );
      },
    });

    await expect(client.createSession()).resolves.toEqual({ id: "ses_1" });
    expect(request.method).toBe("POST");
    expect(new Headers(request.headers).get("content-type")).toBe("application/json");
    expect(request.body).toBe(JSON.stringify({ title: "Keiko governed runtime" }));
    if (typeof request.body !== "string") throw new Error("expected JSON session body");
    expect(Object.keys(JSON.parse(request.body) as Record<string, unknown>)).toEqual(["title"]);
  });

  it("uses the exact bounded prompt, abort, and session-status transports", async () => {
    const requests: { readonly method: string; readonly path: string; readonly body?: string }[] =
      [];
    const client = createOpenCodeHttpClient({
      endpoint: "http://127.0.0.1:43123",
      password: "p".repeat(43),
      fetch: (url, init) => {
        const path = new URL(requestUrl(url)).pathname;
        requests.push({
          method: init?.method ?? "GET",
          path,
          ...(typeof init?.body === "string" ? { body: init.body } : {}),
        });
        if (path.endsWith("/prompt_async"))
          return Promise.resolve(new Response(null, { status: 204 }));
        if (path.endsWith("/abort"))
          return Promise.resolve(
            new Response("true", { headers: { "content-type": "application/json" } }),
          );
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ses_idle: { type: "idle" },
              ses_busy: { type: "busy" },
              ses_retry: {
                type: "retry",
                attempt: 2,
                message: "SENTINEL_RETRY_MESSAGE",
                next: 1234,
                action: {
                  reason: "SENTINEL_REASON",
                  provider: "provider",
                  title: "title",
                  message: "action message",
                  label: "label",
                  link: "https://example.invalid",
                },
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
        );
      },
    }) as unknown as OpenCodeRunControlHttpClient;

    await expect(client.promptAsync("ses_1", "bounded task")).resolves.toBeUndefined();
    await expect(client.abortSession("ses_1")).resolves.toBe(true);
    const statuses = await client.sessionStatuses();
    expect(statuses).toEqual({
      ses_idle: { type: "idle" },
      ses_busy: { type: "busy" },
      ses_retry: { type: "retry", attempt: 2, next: 1234 },
    });
    expect(JSON.stringify(statuses)).not.toMatch(/SENTINEL|message|action/u);
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/session/ses_1/prompt_async",
        body: JSON.stringify({ parts: [{ type: "text", text: "bounded task" }] }),
      },
      { method: "POST", path: "/session/ses_1/abort" },
      { method: "GET", path: "/session/status" },
    ]);
  });

  it("lists exact bounded questions and uses answer/reject transports without local content retention", async () => {
    const requests: { readonly method: string; readonly path: string; readonly body?: string }[] =
      [];
    const pending = [
      {
        id: "que_1",
        sessionID: "ses_1",
        questions: [
          {
            question: "Choose a bounded option",
            header: "Choice",
            options: [{ label: "Approve", description: "Continue safely" }],
          },
        ],
      },
    ];
    const client = createOpenCodeHttpClient({
      endpoint: "http://127.0.0.1:43123",
      password: "p".repeat(43),
      fetch: (url, init) => {
        const path = new URL(requestUrl(url)).pathname;
        requests.push({
          method: init?.method ?? "GET",
          path,
          ...(typeof init?.body === "string" ? { body: init.body } : {}),
        });
        return Promise.resolve(
          new Response(path === "/question" ? JSON.stringify(pending) : "true", {
            headers: { "content-type": "application/json" },
          }),
        );
      },
    }) as unknown as OpenCodeQuestionHttpClient;

    await expect(client.listQuestions()).resolves.toEqual(pending);
    await expect(client.answerQuestion("que_1", [["Approve"]])).resolves.toBe(true);
    await expect(client.rejectQuestion("que_1")).resolves.toBe(true);
    expect(requests).toEqual([
      { method: "GET", path: "/question" },
      { method: "POST", path: "/question/que_1/reply", body: '{"answers":[["Approve"]]}' },
      { method: "POST", path: "/question/que_1/reject" },
    ]);
  });

  it("rejects malformed, oversized, and unbounded question requests and answers before transport", async () => {
    const malformed = [
      [{ id: "que_1", sessionID: "ses_other", questions: [] }],
      [{ id: "wrong", sessionID: "ses_1", questions: [] }],
      [
        {
          id: "que_1",
          sessionID: "ses_1",
          questions: [{ question: "q", header: "h", options: [], extra: true }],
        },
      ],
    ];
    for (const value of malformed) {
      const client = createOpenCodeHttpClient({
        endpoint: "http://127.0.0.1:43123",
        password: "p".repeat(43),
        fetch: () =>
          Promise.resolve(
            new Response(JSON.stringify(value), {
              headers: { "content-type": "application/json" },
            }),
          ),
      }) as unknown as OpenCodeQuestionHttpClient;
      await expect(client.listQuestions()).rejects.toThrow("question-invalid");
    }
    const fetch = vi.fn(() =>
      Promise.resolve(new Response("true", { headers: { "content-type": "application/json" } })),
    );
    const client = createOpenCodeHttpClient({
      endpoint: "http://127.0.0.1:43123",
      password: "p".repeat(43),
      fetch,
    }) as unknown as OpenCodeQuestionHttpClient;
    await expect(client.answerQuestion("bad", [["x"]])).rejects.toThrow("question-invalid");
    await expect(client.answerQuestion("que_1", [["x".repeat(4_097)]])).rejects.toThrow(
      "question-invalid",
    );
    await expect(client.rejectQuestion("bad")).rejects.toThrow("question-invalid");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects invalid prompt bytes and malformed or oversized status maps", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    const promptClient = createOpenCodeHttpClient({
      endpoint: "http://127.0.0.1:43123",
      password: "p".repeat(43),
      fetch,
    });
    await expect(promptClient.promptAsync("ses_1", "")).rejects.toThrow("prompt-invalid");
    await expect(promptClient.promptAsync("ses_1", "contains\u0000nul")).rejects.toThrow(
      "prompt-invalid",
    );
    await expect(promptClient.promptAsync("ses_1", "é".repeat(32_769))).rejects.toThrow(
      "prompt-invalid",
    );
    expect(fetch).not.toHaveBeenCalled();

    for (const value of [
      { ses_1: { type: "idle", extra: true } },
      { ses_1: { type: "retry", attempt: -1, message: "retry", next: 1 } },
      { invalid: { type: "busy" } },
    ]) {
      const client = createOpenCodeHttpClient({
        endpoint: "http://127.0.0.1:43123",
        password: "p".repeat(43),
        fetch: () =>
          Promise.resolve(
            new Response(JSON.stringify(value), {
              headers: { "content-type": "application/json" },
            }),
          ),
      });
      await expect(client.sessionStatuses()).rejects.toThrow("status-invalid");
    }
    const oversized = createOpenCodeHttpClient({
      endpoint: "http://127.0.0.1:43123",
      password: "p".repeat(43),
      fetch: () =>
        Promise.resolve(
          new Response("{}", {
            headers: {
              "content-length": String(1024 * 1024 + 1),
              "content-type": "application/json",
            },
          }),
        ),
    });
    await expect(oversized.sessionStatuses()).rejects.toThrow();
  });

  it("admits the exact settled dynamic control routes and no route template literals", async () => {
    const paths = [
      "/session/ses_1/prompt_async",
      "/session/ses_1/abort",
      "/permission/per_1/reply",
      "/question/que_1/reply",
      "/question/que_1/reject",
    ];
    const requested: string[] = [];
    const client = createOpenCodeHttpClient({
      endpoint: "http://127.0.0.1:43123",
      password: "p".repeat(43),
      fetch: (url) => {
        requested.push(requestUrl(url));
        return Promise.resolve(
          new Response(JSON.stringify({ accepted: true }), {
            headers: { "content-type": "application/json" },
          }),
        );
      },
    });

    for (const path of paths) {
      await expect(client.request("POST", path, { value: "bounded" })).resolves.toEqual({
        ok: true,
        value: { accepted: true },
      });
    }
    expect(requested.map((value) => new URL(value).pathname)).toEqual(paths);
    await expect(client.request("POST", "/session/{sessionID}/prompt_async")).resolves.toEqual({
      ok: false,
      reason: "request-denied",
    });
  });

  it("accepts exactly one literal loopback startup endpoint", () => {
    expect(
      parseOpenCodeChildEndpoint("opencode server listening on http://127.0.0.1:43123\n"),
    ).toEqual({
      ok: true,
      endpoint: "http://127.0.0.1:43123",
    });
    expect(parseOpenCodeChildEndpoint("ready http://127.0.0.1:43123")).toEqual({
      ok: false,
      reason: "endpoint-invalid",
    });
    expect(parseOpenCodeChildEndpoint("http://127.0.0.1:1 http://127.0.0.1:2")).toEqual({
      ok: false,
      reason: "endpoint-invalid",
    });
  });
  it("uses Basic auth, rejects Origin and never follows redirects", async () => {
    let init: RequestInit | undefined;
    const client = createOpenCodeHttpClient({
      endpoint: "http://127.0.0.1:43123",
      password: "p".repeat(43),
      fetch: (_url, request) => {
        init = request;
        return Promise.resolve(new Response("{}", { status: 302, headers: { Location: "/x" } }));
      },
    });
    await expect(client.health()).resolves.toEqual({ ok: false, reason: "http-failed" });
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("authorization")).toMatch(/^Basic /u);
    expect(new Headers(init?.headers).get("origin")).toBeNull();
  });

  it("reads a bounded JSON array from the sole history reconciliation endpoint", async () => {
    const client = createOpenCodeHttpClient({
      endpoint: "http://127.0.0.1:43123",
      password: "p".repeat(43),
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify([{ id: "evt_1" }]), {
            headers: { "content-type": "application/json" },
          }),
        ),
    }) as unknown as OpenCodeEventClient;

    await expect(client.history({})).resolves.toEqual([{ id: "evt_1" }]);
  });

  it("rejects duplicate JSON keys in documents, objects, arrays, and history before parsing", async () => {
    const cases: readonly {
      readonly body: string;
      readonly request: (client: ReturnType<typeof createOpenCodeHttpClient>) => Promise<unknown>;
    }[] = [
      { body: '{"openapi":"3.1.0","openapi":"3.1.0"}', request: (client) => client.document() },
      { body: '{"id":"ses_1","id":"ses_1"}', request: (client) => client.createSession() },
      { body: '[{"id":"ses_1","id":"ses_1"}]', request: (client) => client.sessions() },
      {
        body: '[{"id":"evt_1","aggregate_id":"ses_1","seq":0,"seq":0,"type":"session.idle","data":{"sessionID":"ses_1"}}]',
        request: (client) => client.history({}),
      },
      {
        body: '[{"id":"evt_1","aggregate_id":"ses_1","seq":0,"type":"session.idle","data":{"sessionID":"ses_1","sessionID":"ses_1"}}]',
        request: (client) => client.history({}),
      },
    ];
    for (const testCase of cases) {
      const client = createOpenCodeHttpClient({
        endpoint: "http://127.0.0.1:43123",
        password: "p".repeat(43),
        fetch: () =>
          Promise.resolve(
            new Response(testCase.body, { headers: { "content-type": "application/json" } }),
          ),
      });
      await expect(testCase.request(client)).rejects.toThrow("json-invalid");
    }

    const escaped = createOpenCodeHttpClient({
      endpoint: "http://127.0.0.1:43123",
      password: "p".repeat(43),
      fetch: () =>
        Promise.resolve(
          new Response('{"\\u0069d":"ses_1"}', { headers: { "content-type": "application/json" } }),
        ),
    });
    await expect(escaped.createSession()).resolves.toEqual({ id: "ses_1" });
  });

  it("posts aggregate sequence checkpoints to history before accepting its reconciliation page", async () => {
    let body: string | undefined;
    const client = createOpenCodeHttpClient({
      endpoint: "http://127.0.0.1:43123",
      password: "p".repeat(43),
      fetch: (_url, init) => {
        body = typeof init?.body === "string" ? init.body : undefined;
        return Promise.resolve(
          new Response(JSON.stringify([{ id: "evt_2" }]), {
            headers: { "content-type": "application/json" },
          }),
        );
      },
    }) as unknown as OpenCodeEventClient;

    await expect(client.history({ ses_1: 41, ses_2: 7 })).resolves.toEqual([{ id: "evt_2" }]);
    expect(JSON.parse(body ?? "null")).toEqual({ ses_1: 41, ses_2: 7 });
  });

  it("keeps JSON response deadlines active through /doc, /session, and /sync/history body reads", async () => {
    const requests: readonly ((
      client: ReturnType<typeof createOpenCodeHttpClient>,
    ) => Promise<unknown>)[] = [
      (client): Promise<unknown> => client.document(),
      (client): Promise<unknown> => client.createSession(),
      (client): Promise<unknown> => client.history({}),
    ];

    for (const request of requests) {
      let signal: AbortSignal | undefined;
      let release: (() => void) | undefined;
      const client = createOpenCodeHttpClient({
        endpoint: "http://127.0.0.1:43123",
        password: "p".repeat(43),
        requestTimeoutMs: 5,
        fetch: (_url, init) => {
          signal = init?.signal ?? undefined;
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller): void {
                  release = (): void => {
                    controller.error(new Error("test-body-released"));
                  };
                  signal?.addEventListener(
                    "abort",
                    () => {
                      controller.error(new Error("test-body-aborted"));
                    },
                    { once: true },
                  );
                },
              }),
              { headers: { "content-type": "application/json" } },
            ),
          );
        },
      });
      const outcome = await settlesWithin(request(client));
      release?.();

      expect(outcome).toBe("rejected");
      expect(signal?.aborted).toBe(true);
    }
  });

  it("streams authenticated global events without consuming the response through Response.text", async () => {
    let authorization: string | null = null;
    const client = createOpenCodeHttpClient({
      endpoint: "http://127.0.0.1:43123",
      password: "p".repeat(43),
      fetch: (_url, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return Promise.resolve(
          new Response(
            'event: message\ndata: {"payload":{"id":"evt_1","type":"session.updated","properties":{"sessionID":"ses_1"}}}\n\n',
            {
              headers: { "content-type": "text/event-stream" },
            },
          ),
        );
      },
    }) as unknown as OpenCodeEventClient;

    const events = client.events();
    const first = await events[Symbol.asyncIterator]().next();
    expect(first.value).toEqual({
      event: "message",
      data: { id: "evt_1", type: "session.updated", properties: { sessionID: "ses_1" } },
    });
    expect(authorization).toMatch(/^Basic /u);
  });

  it("uses one fatal UTF-8 decoder across chunks and cancels malformed event bytes", async () => {
    const frame = encoder.encode(
      'event: message\ndata: {"payload":{"id":"evt_1","type":"session.updated","properties":{"label":"é"}}}\n\n',
    );
    const split = frame.indexOf(0xc3);
    const client = createOpenCodeHttpClient({
      endpoint: "http://127.0.0.1:43123",
      password: "p".repeat(43),
      fetch: () =>
        Promise.resolve(
          new Response(byteStream([frame.slice(0, split + 1), frame.slice(split + 1)]), {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
    }) as unknown as OpenCodeEventClient;

    await expect(client.events()[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { data: { properties: { label: "é" } } },
    });

    let cancelled = false;
    const malformed = createOpenCodeHttpClient({
      endpoint: "http://127.0.0.1:43123",
      password: "p".repeat(43),
      eventIdleTimeoutMs: 5,
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller): void {
                controller.enqueue(Uint8Array.of(0xc3));
              },
              cancel(): void {
                cancelled = true;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
    }) as unknown as OpenCodeEventClient;

    await expect(malformed.events()[Symbol.asyncIterator]().next()).rejects.toThrow();
    expect(cancelled).toBe(true);
  });

  it("cancels an unread ordinary JSON body declared above the 1 MiB cap", async () => {
    const body = unreadByteStream();
    const client = createOpenCodeHttpClient({
      endpoint: "http://127.0.0.1:43123",
      password: "p".repeat(43),
      fetch: () =>
        Promise.resolve(
          new Response(body.stream, {
            headers: {
              "content-length": String(1024 * 1024 + 1),
              "content-type": "application/json",
            },
          }),
        ),
    });

    await expect(client.request("GET", "/global/health")).resolves.toEqual({
      ok: false,
      reason: "response-invalid",
    });
    expect(body.cancellations).toBe(1);
    expect(body.pulls).toBe(0);
  });

  it("cancels an unread /doc body declared above the 2 MiB cap", async () => {
    const body = unreadByteStream();
    const client = createOpenCodeHttpClient({
      endpoint: "http://127.0.0.1:43123",
      password: "p".repeat(43),
      fetch: () =>
        Promise.resolve(
          new Response(body.stream, {
            headers: {
              "content-length": String(2 * 1024 * 1024 + 1),
              "content-type": "application/json",
            },
          }),
        ),
    });

    await expect(client.document()).rejects.toThrow("opencode-document-oversized");
    expect(body.cancellations).toBe(1);
    expect(body.pulls).toBe(0);
  });

  it("does not apply the ordinary request deadline after SSE headers, while retaining idle cancellation", async () => {
    const frame = encoder.encode(
      'event: message\ndata: {"payload":{"id":"evt_1","type":"session.updated","properties":{"sessionID":"ses_1"}}}\n\n',
    );
    const healthy = createOpenCodeHttpClient({
      endpoint: "http://127.0.0.1:43123",
      password: "p".repeat(43),
      requestTimeoutMs: 2,
      eventIdleTimeoutMs: 100,
      fetch: () =>
        Promise.resolve(
          new Response(delayedByteStream(frame, 20), {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
    }) as unknown as OpenCodeEventClient;

    await expect(healthy.events()[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { data: { id: "evt_1" } },
    });

    let cancelled = false;
    const idle = createOpenCodeHttpClient({
      endpoint: "http://127.0.0.1:43123",
      password: "p".repeat(43),
      requestTimeoutMs: 100,
      eventIdleTimeoutMs: 2,
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              cancel(): void {
                cancelled = true;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
    }) as unknown as OpenCodeEventClient;

    await expect(idle.events()[Symbol.asyncIterator]().next()).rejects.toThrow(
      "opencode-event-idle",
    );
    expect(cancelled).toBe(true);
  });

  it("honours caller abort, request deadline, and the response byte cap before retaining a body", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createOpenCodeHttpClient({
      endpoint: "http://127.0.0.1:43123",
      password: "p".repeat(43),
      fetch: abortableFetch,
    });

    await expect(
      client.request("GET", "/global/health", undefined, { signal: controller.signal }),
    ).resolves.toEqual({
      ok: false,
      reason: "http-failed",
    });
    await expect(
      client.request("GET", "/global/health", undefined, { timeoutMs: 1 }),
    ).resolves.toEqual({
      ok: false,
      reason: "http-failed",
    });
  });
});

const encoder = new TextEncoder();

function byteStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function delayedByteStream(chunk: Uint8Array, delayMs: number): ReadableStream<Uint8Array> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      timer = setTimeout(() => {
        controller.enqueue(chunk);
        controller.close();
      }, delayMs);
    },
    cancel(): void {
      if (timer !== undefined) clearTimeout(timer);
    },
  });
}

function unreadByteStream(): {
  readonly stream: ReadableStream<Uint8Array>;
  readonly pulls: number;
  readonly cancellations: number;
} {
  let pulls = 0;
  let cancellations = 0;
  return {
    stream: new ReadableStream<Uint8Array>(
      {
        pull(): void {
          pulls += 1;
        },
        cancel(): void {
          cancellations += 1;
        },
      },
      { highWaterMark: 0 },
    ),
    get pulls(): number {
      return pulls;
    },
    get cancellations(): number {
      return cancellations;
    },
  };
}

async function settlesWithin(
  promise: Promise<unknown>,
): Promise<"fulfilled" | "rejected" | "pending"> {
  return Promise.race([
    promise.then(
      () => "fulfilled" as const,
      () => "rejected" as const,
    ),
    new Promise<"pending">((resolve) =>
      setTimeout(() => {
        resolve("pending");
      }, 40),
    ),
  ]);
}
