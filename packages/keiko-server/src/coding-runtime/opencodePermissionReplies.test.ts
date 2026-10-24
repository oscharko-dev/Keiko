import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { createOpenCodeHttpClient } from "./opencodeHttpClient.js";
import { createOpenCodeV2HttpClient } from "./opencodeV2HttpClient.js";

// S02 (#3904): a retained session is copied into the next run, so a remembered grant would outlive
// the authority that produced it. OpenCode remembers an `always` for the rest of its session; Keiko
// therefore answers a permission request one at a time, `once` or `reject`, and never `always`.
// This is a regression pin: it may be strengthened or moved to the layer that owns it, not relaxed.
describe("Keiko never answers a permission request with always", () => {
  function recordingFetch(response: string): {
    readonly fetch: typeof globalThis.fetch;
    readonly bodies: string[];
  } {
    const bodies: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      return Promise.resolve(
        new Response(response, { headers: { "content-type": "application/json" } }),
      );
    });
    return { fetch, bodies };
  }

  const PASSWORD = "p".repeat(43);

  it("sends only once or reject through the v1 client, and refuses anything else unsent", async () => {
    const { fetch, bodies } = recordingFetch("true");
    const client = createOpenCodeHttpClient({
      endpoint: "http://127.0.0.1:43123",
      password: PASSWORD,
      fetch,
    });

    await client.replyPermission("per_1", "once");
    await client.replyPermission("per_1", "reject");
    await expect(client.replyPermission("per_1", "always" as "once")).rejects.toThrow(
      "opencode-permission-reply-invalid",
    );

    expect(bodies).toEqual(['{"reply":"once"}', '{"reply":"reject"}']);
  });

  it("sends only once or reject through the v2 client, and refuses anything else unsent", async () => {
    const { fetch, bodies } = recordingFetch("{}");
    const client = createOpenCodeV2HttpClient({
      endpoint: "http://127.0.0.1:1984/",
      password: "test-only",
      fetch,
    });

    await client.replyPermission("ses_1", "per_1", "once");
    await client.replyPermission("ses_1", "per_1", "reject", "Use the governed tool.");
    await expect(client.replyPermission("ses_1", "per_1", "always" as "once")).rejects.toThrow(
      "opencode-v2-permission-decision-invalid",
    );

    expect(bodies).toEqual([
      '{"decision":"once"}',
      '{"decision":"reject","message":"Use the governed tool."}',
    ]);
    expect(bodies.join()).not.toContain("always");
  });

  // The shapes an `always` answer takes in source: a reply type that admits it, a reply object that
  // carries it, and a call that passes it. The runtime's own `always` request field and the observed
  // `permission.replied` vocabulary are values Keiko reads, not answers it sends, and match none.
  const ALWAYS_ANSWER_SHAPES: readonly RegExp[] = [
    /["']once["']\s*\|\s*["']always["']|["']always["']\s*\|\s*["']reject["']/u,
    /\b(?:reply|decision)\s*[:=]\s*["']always["']/u,
    /replyPermission\([^)]*["']always["']/u,
  ];

  it("admits always in no product source of the coding runtime as an answer", () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(directory).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );

    const offenders = sources.filter((name) => {
      const text = readFileSync(join(directory, name), "utf8");
      return ALWAYS_ANSWER_SHAPES.some((shape) => shape.test(text));
    });

    expect(sources.length).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });

  it("recognises each shape an always answer takes, so the scan above cannot go blind", () => {
    const answers = [
      'reply: "once" | "always" | "reject"',
      'decision: "always"',
      "const reply = 'always';",
      'client.replyPermission("per_1", "always")',
    ];

    for (const answer of answers) {
      expect(ALWAYS_ANSWER_SHAPES.some((shape) => shape.test(answer))).toBe(true);
    }
    expect(
      ALWAYS_ANSWER_SHAPES.some((shape) => shape.test('["once", "always", "reject"].includes(x)')),
    ).toBe(false);
  });
});
