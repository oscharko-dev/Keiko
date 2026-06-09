import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  ConfigInvalidError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import {
  createCodexLocalSessionRuntimeResolver,
  type CodexLocalSessionCommandResult,
  type CodexLocalSessionCommandRunner,
} from "./codex-local-session.js";
import type { OpenAiCodexLocalSessionProviderConfig } from "./types.js";

function provider(
  overrides: Partial<OpenAiCodexLocalSessionProviderConfig> = {},
): OpenAiCodexLocalSessionProviderConfig {
  return {
    modelId: "codex-chat",
    providerId: "codex-local",
    providerType: "openai-codex-local-session",
    validationState: "runtime-only",
    runtimeHandle: { kind: "codex-local-session" },
    timeoutMs: 30_000,
    maxRetries: 2,
    retryBaseDelayMs: 1,
    ...overrides,
  };
}

function result(
  overrides: Partial<CodexLocalSessionCommandResult> = {},
): CodexLocalSessionCommandResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    ...overrides,
  };
}

function runner(
  outputs: readonly CodexLocalSessionCommandResult[],
): CodexLocalSessionCommandRunner & { readonly seen: string[][] } {
  const queue = [...outputs];
  const seen: string[][] = [];
  return {
    seen,
    run: (args): CodexLocalSessionCommandResult => {
      seen.push([...args]);
      const next = queue.shift();
      if (next === undefined) {
        throw new Error("unexpected codex command");
      }
      return next;
    },
  };
}

describe("createCodexLocalSessionRuntimeResolver", () => {
  it("resolves a local-session provider into a runtime credential-bearing config", () => {
    const fakeRunner = runner([
      result({ stdout: "codex 26.602.9276.0\n" }),
      result({
        stdout: JSON.stringify({
          authenticated: true,
          session: { state: "authenticated", expiresAt: "2999-01-01T00:00:00Z" },
          endpoint: { baseUrl: "https://api.openai.com/v1", apiKeyHeaderName: "authorization" },
          credentials: { apiKey: "sk-local-session-secret-1234567890" },
          capabilities: { chatCompletions: true, workflow: true },
        }),
      }),
    ]);
    const resolve = createCodexLocalSessionRuntimeResolver({ commandRunner: fakeRunner });
    const runtime = resolve(provider());
    expect(fakeRunner.seen).toEqual([
      ["--version"],
      ["auth", "status", "--json"],
    ]);
    expect(runtime).toMatchObject({
      providerId: "codex-local",
      providerType: "openai-codex-local-session",
      modelId: "codex-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKeyHeaderName: "authorization",
    });
    expect(runtime.apiKey).toBe("sk-local-session-secret-1234567890");
  });

  it("fails closed when the codex CLI is missing", () => {
    const resolve = createCodexLocalSessionRuntimeResolver({
      commandRunner: runner([result({ exitCode: null, errorCode: "ENOENT" })]),
    });
    try {
      resolve(provider());
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigInvalidError);
      expect((error as Error).message).toMatch(/requires the codex CLI/);
    }
  });

  it("fails closed when the codex CLI version is too old", () => {
    const resolve = createCodexLocalSessionRuntimeResolver({
      commandRunner: runner([result({ stdout: "codex 26.601.9999.0\n" })]),
      minimumVersion: "26.602.0",
    });
    try {
      resolve(provider());
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigInvalidError);
      expect((error as Error).message).toMatch(/26\.602\.0 or newer/);
    }
  });

  it("fails with AuthenticationError when the local session is missing", () => {
    const resolve = createCodexLocalSessionRuntimeResolver({
      commandRunner: runner([
        result({ stdout: "codex 26.602.9276.0\n" }),
        result({
          stdout: JSON.stringify({
            authenticated: false,
            session: { state: "missing" },
            capabilities: { chatCompletions: true, workflow: true },
          }),
        }),
      ]),
    });
    try {
      resolve(provider());
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AuthenticationError);
      expect((error as Error).message).toMatch(/not signed in/);
    }
  });

  it("fails with AuthenticationError when the local session is expired", () => {
    const resolve = createCodexLocalSessionRuntimeResolver({
      commandRunner: runner([
        result({ stdout: "codex 26.602.9276.0\n" }),
        result({
          stdout: JSON.stringify({
            authenticated: true,
            session: { state: "expired", expiresAt: "2026-01-01T00:00:00Z" },
            capabilities: { chatCompletions: true, workflow: true },
          }),
        }),
      ]),
    });
    try {
      resolve(provider());
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AuthenticationError);
      expect((error as Error).message).toMatch(/2026-01-01T00:00:00Z/);
    }
  });

  it("fails closed when the status response is malformed JSON", () => {
    const resolve = createCodexLocalSessionRuntimeResolver({
      commandRunner: runner([
        result({ stdout: "codex 26.602.9276.0\n" }),
        result({ stdout: "{ not json" }),
      ]),
    });
    try {
      resolve(provider());
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigInvalidError);
      expect((error as Error).message).toMatch(/malformed JSON/);
    }
  });

  it("fails closed when the capability shape is unsupported", () => {
    const resolve = createCodexLocalSessionRuntimeResolver({
      commandRunner: runner([
        result({ stdout: "codex 26.602.9276.0\n" }),
        result({
          stdout: JSON.stringify({
            authenticated: true,
            session: { state: "authenticated", expiresAt: "2999-01-01T00:00:00Z" },
            endpoint: { baseUrl: "https://api.openai.com/v1" },
            credentials: { token: "sk-local-session-secret-1234567890" },
            capabilities: { chatCompletions: true, workflow: false },
          }),
        }),
      ]),
    });
    try {
      resolve(provider());
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigInvalidError);
      expect((error as Error).message).toMatch(/workflow capability/);
    }
  });

  it("never echoes the resolved credential in an error message", () => {
    const token = "sk-local-session-secret-1234567890";
    const resolve = createCodexLocalSessionRuntimeResolver({
      commandRunner: runner([
        result({ stdout: "codex 26.602.9276.0\n" }),
        result({
          stdout: JSON.stringify({
            authenticated: true,
            session: { state: "authenticated", expiresAt: "2999-01-01T00:00:00Z" },
            endpoint: { baseUrl: "http://10.0.0.4:8000/v1" },
            credentials: { apiKey: token },
            capabilities: { chatCompletions: true, workflow: true },
          }),
        }),
      ]),
    });
    try {
      resolve(provider());
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigInvalidError);
      expect((error as Error).message).not.toContain(token);
    }
  });
});
