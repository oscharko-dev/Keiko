import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { MAX_DESKTOP_CHAT_CLIENT_TURN_ID_CHARS } from "@oscharko-dev/keiko-contracts/bff-wire";
import { parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import {
  handleCreateDesktopChat,
  handleSendDesktopChat,
  parseClientTurnId,
  parseExpectedGroundingScopeIdentity,
} from "./chat-handlers.js";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
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

interface GatewayBreakerFixture {
  readonly root: string;
  readonly projectPath: string;
  readonly chatId: string;
  readonly deps: UiHandlerDeps;
}

function configureBreakerGateway(deps: UiHandlerDeps): void {
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
  runtimeConfig.recordVerifiedCapability(
    "breaker-chat",
    { conversationReady: true },
    "2026-08-16T00:00:00.000Z",
    runtimeConfig.generation(),
  );
}

async function createGatewayBreakerFixture(): Promise<GatewayBreakerFixture> {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-chat-breaker-"));
  const projectPath = join(root, "repo");
  let deps: UiHandlerDeps | undefined;
  try {
    mkdirSync(projectPath);
    deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: join(root, "evidence"),
      uiDbPath: join(root, "ui.db"),
      env: {},
    });
    configureBreakerGateway(deps);
    deps.store.createProject(projectPath, "repo");
    const chat = deps.store.createChat(projectPath, "Breaker", "breaker-chat");
    return { root, projectPath, chatId: chat.id, deps };
  } catch (error) {
    try {
      await deps?.dispose?.();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    throw error;
  }
}

async function disposeGatewayBreakerFixture(fixture: GatewayBreakerFixture): Promise<void> {
  try {
    await fixture.deps.dispose?.();
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function sendBreakerChat(
  fixture: GatewayBreakerFixture,
  content: string,
): Promise<Awaited<ReturnType<typeof handleSendDesktopChat>>> {
  return handleSendDesktopChat(
    requestContext({
      chatId: fixture.chatId,
      projectPath: fixture.projectPath,
      modelId: "breaker-chat",
      content,
    }),
    fixture.deps,
  );
}

describe("desktop chat production gateway reuse", () => {
  it("rejects an unready configured model before provider fetch", async () => {
    const fixture = await createGatewayBreakerFixture();
    try {
      fixture.deps.gatewayConfig?.clearVerifiedCapability("breaker-chat");
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const createRejected = await handleCreateDesktopChat(
        requestContext({
          modelId: "breaker-chat",
          projectPath: fixture.projectPath,
          title: "must not be created",
        }),
        fixture.deps,
      );
      const rejected = await sendBreakerChat(fixture, "must not leave the server");

      expect(createRejected).toEqual({
        status: 400,
        body: {
          error: {
            code: "BAD_REQUEST",
            message: "The selected model is not ready for conversations.",
          },
        },
      });
      expect(rejected).toEqual({
        status: 400,
        body: {
          error: {
            code: "BAD_REQUEST",
            message: "The selected model is not ready for conversations.",
          },
        },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(JSON.stringify(rejected.body)).not.toContain("must not leave the server");
    } finally {
      vi.unstubAllGlobals();
      await disposeGatewayBreakerFixture(fixture);
    }
  });

  it("opens one shared breaker across separate route requests", async () => {
    const fixture = await createGatewayBreakerFixture();
    try {
      const fetchSpy = vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: "unavailable" } }), {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchSpy);
      for (let index = 0; index < 5; index += 1) {
        const result = await sendBreakerChat(fixture, `failure ${String(index)}`);
        expect(gatewayErrorCode(result)).toBe("GATEWAY_PROVIDER_ERROR");
        expect(fetchSpy).toHaveBeenCalledTimes(index + 1);
      }

      const rejected = await sendBreakerChat(fixture, "must fail before transport");
      expect(gatewayErrorCode(rejected)).toBe("GATEWAY_CIRCUIT_OPEN");
      // KEIKO-0353: a circuit-open failure must surface as 503 "temporarily unavailable"
      // like a transport failure does — not 502, which the pre-fix code returned because
      // CircuitOpenError has retryable=false (the breaker's internal auto-recovery signal,
      // not the client's "give up" signal).
      expect(rejected.status).toBe(503);
      expect(fetchSpy).toHaveBeenCalledTimes(5);
    } finally {
      vi.unstubAllGlobals();
      await disposeGatewayBreakerFixture(fixture);
    }
  });
});
