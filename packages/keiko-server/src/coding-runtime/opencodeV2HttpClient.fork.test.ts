import { describe, expect, it, vi } from "vitest";

import { createOpenCodeV2HttpClient } from "./opencodeV2HttpClient.js";

// S02/S03 (#3904): the fork of a retained session and the removal of the sessions Keiko itself
// created in a run's private state. The client keeps both shapes closed and the ids safe.
describe("OpenCode V2 session fork and removal", () => {
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

  function forkEnvelope(overrides: Record<string, unknown> = {}): { readonly data: object } {
    return {
      data: {
        id: "ses_fork_1",
        fork: {
          sessionID: "ses_source_1",
          boundary: { type: "before", messageID: "msg_boundary_1" },
        },
        projectID: "project",
        title: "Keiko governed runtime (fork #1)",
        location: { directory: "/workspace" },
        ...overrides,
      },
    };
  }

  it("forks before a message with the closed body and reads only the fields Keiko checks", async () => {
    const { client, fetch } = clientWith(() => json(forkEnvelope()));

    await expect(client.forkSession("ses_source_1", "msg_boundary_1")).resolves.toEqual({
      id: "ses_fork_1",
      directory: "/workspace",
      sourceSessionId: "ses_source_1",
      boundary: { type: "before", messageId: "msg_boundary_1" },
    });

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toEqual(new URL("http://127.0.0.1:1984/api/session/ses_source_1/fork"));
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(init?.body).toBe(JSON.stringify({ before: "msg_boundary_1" }));
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: AUTHORIZATION,
    });
  });

  it("forks through the last message with an empty body and reports the through boundary", async () => {
    const { client, fetch } = clientWith(() =>
      json(
        forkEnvelope({
          fork: {
            sessionID: "ses_source_1",
            boundary: { type: "through", messageID: "msg_last_1" },
          },
        }),
      ),
    );

    await expect(client.forkSession("ses_source_1")).resolves.toMatchObject({
      boundary: { type: "through", messageId: "msg_last_1" },
    });
    expect(fetch.mock.calls[0]?.[1]?.body).toBe("{}");
  });

  it.each([
    ["no session id", forkEnvelope({ id: undefined })],
    ["a foreign session id", forkEnvelope({ id: "msg_fork_1" })],
    ["no location", forkEnvelope({ location: undefined })],
    ["a non-text directory", forkEnvelope({ location: { directory: 7 } })],
    ["no fork record", forkEnvelope({ fork: undefined })],
    [
      "an unknown boundary type",
      forkEnvelope({
        fork: { sessionID: "ses_source_1", boundary: { type: "after", messageID: "msg_b" } },
      }),
    ],
    [
      "a foreign boundary message",
      forkEnvelope({
        fork: { sessionID: "ses_source_1", boundary: { type: "before", messageID: "ses_b" } },
      }),
    ],
    [
      "a foreign source session",
      forkEnvelope({
        fork: { sessionID: "msg_source_1", boundary: { type: "before", messageID: "msg_b" } },
      }),
    ],
    ["a non-object payload", { data: [] }],
    ["a missing data envelope", {}],
  ])("rejects a fork receipt with %s", async (_name, body) => {
    const { client } = clientWith(() => json(body));

    await expect(client.forkSession("ses_source_1", "msg_boundary_1")).rejects.toThrow(
      "opencode-v2-envelope-invalid",
    );
  });

  it.each(["", "msg_boundary_1", "ses_", "ses_a/../b", "ses_a b", "ses_a\n"])(
    "refuses an unsafe session id before any request leaves the process (%j)",
    async (sessionId) => {
      const { client, fetch } = clientWith(() => json(forkEnvelope()));

      await expect(client.forkSession(sessionId, "msg_boundary_1")).rejects.toThrow(
        "opencode-v2-session-invalid",
      );
      await expect(client.removeSession(sessionId)).rejects.toThrow("opencode-v2-session-invalid");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["", "ses_boundary_1", "msg_", "msg_a/../b", "msg_a b"])(
    "refuses an unsafe boundary message id before any request leaves the process (%j)",
    async (messageId) => {
      const { client, fetch } = clientWith(() => json(forkEnvelope()));

      await expect(client.forkSession("ses_source_1", messageId)).rejects.toThrow(
        "opencode-v2-message-invalid",
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("removes a session with a bodyless DELETE", async () => {
    const { client, fetch } = clientWith(() => new Response(null, { status: 204 }));

    await expect(client.removeSession("ses_scratch_1")).resolves.toBeUndefined();

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toEqual(new URL("http://127.0.0.1:1984/api/session/ses_scratch_1"));
    expect(init).toMatchObject({ method: "DELETE", redirect: "manual" });
    expect(init?.body).toBeUndefined();
    expect(init?.headers).not.toHaveProperty("Content-Type");
  });

  it("surfaces the runtime's refusal of an unknown session as its status", async () => {
    const missing = clientWith(() =>
      json({ _tag: "SessionNotFoundError", sessionID: "ses_gone_1", message: "gone" }, 404),
    );

    const fork: unknown = await missing.client
      .forkSession("ses_gone_1")
      .catch((error: unknown) => error);
    const removal: unknown = await missing.client
      .removeSession("ses_gone_1")
      .catch((error: unknown) => error);

    expect(fork).toMatchObject({ name: "OpenCodeV2HttpStatusError", status: 404 });
    expect(removal).toMatchObject({ name: "OpenCodeV2HttpStatusError", status: 404 });
  });
});
