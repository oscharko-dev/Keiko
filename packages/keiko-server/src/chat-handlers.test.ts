import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { MAX_DESKTOP_CHAT_CLIENT_TURN_ID_CHARS } from "@oscharko-dev/keiko-contracts/bff-wire";
import { parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import {
  handleSendDesktopChat,
  parseClientTurnId,
  parseExpectedGroundingScopeIdentity,
} from "./chat-handlers.js";
import { buildUiHandlerDeps } from "./deps.js";
import type { RouteContext } from "./routes.js";

const VALID_GROUNDING_SCOPE_IDENTITY = `gsi-v1:${"a".repeat(64)}`;
const INVALID_CLIENT_TURN_ID = {
  status: 400,
  body: {
    error: {
      code: "BAD_REQUEST",
      message: "clientTurnId must be a bounded non-blank string.",
    },
  },
} as const;

describe("parseClientTurnId", (): void => {
  it("preserves bounded opaque identifiers without normalizing their identity", (): void => {
    const paddedOpaqueId = "  opaque-id  ";
    const maximumLengthId = "x".repeat(MAX_DESKTOP_CHAT_CLIENT_TURN_ID_CHARS);

    expect(parseClientTurnId(undefined)).toBeUndefined();
    expect(parseClientTurnId(paddedOpaqueId)).toBe(paddedOpaqueId);
    expect(parseClientTurnId(maximumLengthId)).toBe(maximumLengthId);
  });

  it.each([
    null,
    "",
    " \t\r\n",
    "\u00a0\ufeff\u3000",
    "x".repeat(MAX_DESKTOP_CHAT_CLIENT_TURN_ID_CHARS + 1),
  ])("rejects an invalid identifier %#", (value): void => {
    expect(parseClientTurnId(value)).toEqual(INVALID_CLIENT_TURN_ID);
  });
});

describe("parseExpectedGroundingScopeIdentity", (): void => {
  it("passes through an omitted or valid server-issued identity", (): void => {
    expect(parseExpectedGroundingScopeIdentity(undefined)).toBeUndefined();
    expect(parseExpectedGroundingScopeIdentity(VALID_GROUNDING_SCOPE_IDENTITY)).toBe(
      VALID_GROUNDING_SCOPE_IDENTITY,
    );
  });

  it.each([null, "", "gsi-v1:not-a-digest", `gsi-v1:${"a".repeat(63)}`, { value: "forged" }])(
    "rejects an invalid or forged identity %#",
    (value): void => {
      expect(parseExpectedGroundingScopeIdentity(value)).toEqual({
        status: 400,
        body: {
          error: {
            code: "BAD_REQUEST",
            message: "expectedGroundingScopeIdentity must be a valid server-issued identity.",
          },
        },
      });
    },
  );
});

function requestContext(body: Record<string, unknown>): RouteContext {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
  const res = {
    destroyed: false,
    closed: false,
    writableEnded: false,
    once(): void {
      // The exercised handler does not register response events on this deterministic stub.
    },
    off(): void {
      // The exercised handler does not unregister response events on this deterministic stub.
    },
  };
  return {
    req: req as unknown as IncomingMessage,
    res: res as unknown as ServerResponse,
    params: {},
    url: new URL("http://127.0.0.1/api/desktop/chat"),
  };
}

function gatewayErrorCode(result: Awaited<ReturnType<typeof handleSendDesktopChat>>): unknown {
  const body = result.body as { readonly error?: { readonly code?: unknown } };
  return body.error?.code;
}

describe("desktop chat production gateway reuse", () => {
  it("opens one shared breaker across separate route requests", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-chat-breaker-"));
    const projectPath = join(root, "repo");
    mkdirSync(projectPath);
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: join(root, "evidence"),
      env: {},
    });
    const runtimeConfig = deps.gatewayConfig;
    if (runtimeConfig === undefined) throw new Error("expected runtime gateway config");
    runtimeConfig.set(
      parseGatewayConfig({
        providers: [
          {
            modelId: "breaker-chat",
            baseUrl: "https://provider.example.invalid/v1",
            apiKey: "fake-test-key",
            timeoutMs: 5_000,
            maxRetries: 0,
            retryBaseDelayMs: 1,
          },
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 1 },
      }),
      true,
    );
    deps.store.createProject(projectPath, "repo");
    const chat = deps.store.createChat(projectPath, "Breaker", "breaker-chat");
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: "unavailable" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    try {
      for (let index = 0; index < 5; index += 1) {
        const result = await handleSendDesktopChat(
          requestContext({
            chatId: chat.id,
            projectPath,
            modelId: "breaker-chat",
            content: `failure ${String(index)}`,
          }),
          deps,
        );
        expect(gatewayErrorCode(result)).toBe("GATEWAY_PROVIDER_ERROR");
        expect(fetchSpy).toHaveBeenCalledTimes(index + 1);
      }

      const rejected = await handleSendDesktopChat(
        requestContext({
          chatId: chat.id,
          projectPath,
          modelId: "breaker-chat",
          content: "must fail before transport",
        }),
        deps,
      );
      expect(gatewayErrorCode(rejected)).toBe("GATEWAY_CIRCUIT_OPEN");
      expect(fetchSpy).toHaveBeenCalledTimes(5);
    } finally {
      vi.unstubAllGlobals();
      await deps.dispose?.();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
