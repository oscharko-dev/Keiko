import { describe, expect, it } from "vitest";
import { ConfigInvalidError, type GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { runPromptEnhancerCli } from "./prompt-enhancer.js";
import type { CliIo } from "./runner.js";

interface Captured {
  readonly io: CliIo;
  readonly out: () => string;
  readonly err: () => string;
}

function makeIo(): Captured {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      out: (text: string): void => {
        outChunks.push(text);
      },
      err: (text: string): void => {
        errChunks.push(text);
      },
    },
    out: (): string => outChunks.join(""),
    err: (): string => errChunks.join(""),
  };
}

function configWithProvider(modelId: string): GatewayConfig {
  return {
    providers: [
      {
        modelId,
        baseUrl: "https://provider.example/v1",
        apiKey: "example-test-token-1234567890",
        timeoutMs: 30_000,
        maxRetries: 0,
        retryBaseDelayMs: 500,
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    capabilities: [
      {
        id: modelId,
        kind: "chat",
        contextWindow: 64_000,
        maxOutputTokens: 4_096,
        toolCalling: true,
        structuredOutput: true,
        streaming: true,
        supportsImageInput: false,
        supportsDocumentInput: false,
        workflowEligible: false,
        costClass: "medium",
        latencyClass: "standard",
        throughputHint: "local endpoint",
        preferredUseCases: ["Local coding workflow"],
        knownLimitations: [],
      },
    ],
  };
}

describe("runPromptEnhancerCli", () => {
  it("prints usage and exits 0 for --help", () => {
    const c = makeIo();
    const code = runPromptEnhancerCli(["--help"], c.io, {});
    expect(code).toBe(0);
    expect(c.out()).toContain("keiko prompt-enhancer");
  });

  it("exits 2 with usage when --input is missing", () => {
    const c = makeIo();
    const code = runPromptEnhancerCli([], c.io, {});
    expect(code).toBe(2);
    expect(c.err()).toContain("--input is required");
  });

  it("exits 2 for an unknown flag", () => {
    const c = makeIo();
    const code = runPromptEnhancerCli(["--input", "x", "--bogus"], c.io, {});
    expect(code).toBe(2);
    expect(c.err()).toContain("unknown flag --bogus");
  });

  it("exits 2 when a value flag is missing its value", () => {
    const c = makeIo();
    const code = runPromptEnhancerCli(["--input"], c.io, {});
    expect(code).toBe(2);
    expect(c.err()).toContain("missing value for --input");
  });

  it("exits 2 for an invalid profile (wire validation)", () => {
    const c = makeIo();
    const code = runPromptEnhancerCli(["--input", "Hello", "--profile", "turbo"], c.io, {});
    expect(code).toBe(2);
    expect(c.err()).toContain("profilePreference");
  });

  it("exits 2 for a whitespace-only input (wire validation)", () => {
    const c = makeIo();
    const code = runPromptEnhancerCli(["--input", "   "], c.io, {});
    expect(code).toBe(2);
    expect(c.err()).toContain("invalid request");
  });

  it("enhances a prompt deterministically and exits 0", () => {
    const c = makeIo();
    const code = runPromptEnhancerCli(
      ["--input", "Summarize the quarterly report into three bullets."],
      c.io,
      {},
    );
    expect(code).toBe(0);
    const out = c.out();
    expect(out).toContain("Enhanced prompt");
    expect(out).toContain("Candidate scorecards");
    expect(out).toContain("Model routing: not-requested");
    expect(out).toContain("## Role");
  });

  it("emits valid JSON with --json", () => {
    const c = makeIo();
    const code = runPromptEnhancerCli(["--input", "Write a haiku.", "--json"], c.io, {});
    expect(code).toBe(0);
    const parsed = JSON.parse(c.out()) as { schemaVersion: string; enhancedPrompt: unknown };
    expect(parsed.schemaVersion).toBe("1");
    expect(parsed.enhancedPrompt).toBeDefined();
  });

  it("fails gracefully with exit 1 when --model is set but no config is available", () => {
    const c = makeIo();
    const code = runPromptEnhancerCli(
      ["--input", "Hello", "--model", "example-chat-model"],
      c.io,
      {},
    );
    expect(code).toBe(1);
    expect(c.err()).toContain("--model requires a gateway config");
  });

  it("resolves model routing as available when a config is provided", () => {
    const c = makeIo();
    const code = runPromptEnhancerCli(
      ["--input", "Hello", "--model", "m", "--config", "/cfg"],
      c.io,
      {},
      { loadConfig: () => configWithProvider("m") },
    );
    expect(code).toBe(0);
    expect(c.out()).toContain("Model routing: available");
  });

  it("maps a gateway config error to exit 1 with redacted guidance", () => {
    const c = makeIo();
    const code = runPromptEnhancerCli(
      ["--input", "Hello", "--model", "m", "--config", "/cfg"],
      c.io,
      {},
      {
        loadConfig: () => {
          throw new ConfigInvalidError("invalid config");
        },
      },
    );
    expect(code).toBe(1);
    expect(c.err()).toContain("model gateway configuration problem");
  });

  it("prints a redacted, integrity-hashed evidence manifest with --evidence", () => {
    const c = makeIo();
    const code = runPromptEnhancerCli(["--input", "Design an API.", "--evidence"], c.io, {});
    expect(code).toBe(0);
    const out = c.out();
    expect(out).toContain("Redacted evidence manifest");
    const manifestStart = out.indexOf("{", out.indexOf("Redacted evidence manifest"));
    const manifest = JSON.parse(out.slice(manifestStart)) as {
      peEvidenceSchemaVersion: number;
      inputFingerprintSha256: string;
      integrityHashes: { enhancedOutput: string };
    };
    expect(manifest.peEvidenceSchemaVersion).toBe(1);
    expect(manifest.inputFingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.integrityHashes.enhancedOutput).toMatch(/^[0-9a-f]{64}$/);
  });

  it("redacts secret-shaped substrings from all output (AC4)", () => {
    const c = makeIo();
    const secret = "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789";
    const code = runPromptEnhancerCli(
      ["--input", `Push using my token ${secret} please.`, "--json", "--evidence"],
      c.io,
      {},
    );
    expect(code).toBe(0);
    expect(c.out()).not.toContain(secret);
    expect(c.out()).toContain("[REDACTED]");
  });

  it("accepts the assume strategy and a bounded candidate count", () => {
    const c = makeIo();
    const code = runPromptEnhancerCli(
      ["--input", "Build a thing.", "--strategy", "assume", "--candidates", "4"],
      c.io,
      {},
    );
    expect(code).toBe(0);
    expect(c.out()).toContain("Enhanced prompt");
  });
});
