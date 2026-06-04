import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runModelsCli } from "./models.js";
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
      out: (t: string): void => void outChunks.push(t),
      err: (t: string): void => void errChunks.push(t),
    },
    out: (): string => outChunks.join(""),
    err: (): string => errChunks.join(""),
  };
}

const API_KEY_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{16,}|example-test-token-[A-Za-z0-9_-]{8,})/;

function validConfig(): string {
  return JSON.stringify({
    providers: [
      {
        modelId: "example-chat-model",
        baseUrl: "https://host.example/v1",
        apiKey: "example-test-token-1234567890",
        timeoutMs: 30000,
        maxRetries: 3,
        retryBaseDelayMs: 500,
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenProbes: 2 },
  });
}

describe("runModelsCli list", () => {
  it("lists only the header when no built-in models are shipped", () => {
    const c = makeIo();
    const code = runModelsCli(["list"], c.io, {});
    expect(code).toBe(0);
    expect(c.out().trim()).toBe("ID\tKIND\tCOST\tLATENCY\tTOOLS\tSTRUCT\tUSE-CASES");
  });

  it("emits no credential-like value in the list output", () => {
    const c = makeIo();
    runModelsCli(["list"], c.io, {});
    for (const line of c.out().split("\n")) {
      expect(API_KEY_PATTERN.test(line)).toBe(false);
    }
  });

  it("includes a header with capability columns", () => {
    const c = makeIo();
    runModelsCli(["list"], c.io, {});
    expect(c.out()).toContain("ID");
    expect(c.out()).toContain("COST");
    expect(c.out()).toContain("TOOLS");
  });
});

describe("runModelsCli validate", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keiko-cli-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a valid config and exits 0", () => {
    const path = join(dir, "ok.json");
    writeFileSync(path, validConfig(), "utf8");
    const c = makeIo();
    const code = runModelsCli(["validate", "--config", path], c.io, {});
    expect(code).toBe(0);
    expect(c.out()).toContain("valid");
    expect(c.out()).toContain("1");
  });

  it("reports an invalid config on stderr with the error code and exits 1", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify({ providers: [] }), "utf8");
    const c = makeIo();
    const code = runModelsCli(["validate", "--config", path], c.io, {});
    expect(code).toBe(1);
    expect(c.err()).toContain("GATEWAY_CONFIG_INVALID");
  });

  it("accepts a config whose modelId is absent from the built-in capability registry", () => {
    const path = join(dir, "unknown-model.json");
    const parsed = JSON.parse(validConfig()) as {
      providers: { modelId: string }[];
    };
    const provider = parsed.providers[0];
    if (provider === undefined) {
      throw new Error("test fixture must include one provider");
    }
    provider.modelId = "not-in-registry";
    writeFileSync(path, JSON.stringify(parsed), "utf8");
    const c = makeIo();
    const code = runModelsCli(["validate", "--config", path], c.io, {});
    expect(code).toBe(0);
    expect(c.out()).toContain("valid");
  });

  it("accepts a config whose unregistered modelId declares local capability metadata", () => {
    const path = join(dir, "custom-model.json");
    const parsed = JSON.parse(validConfig()) as {
      providers: Record<string, unknown>[];
    };
    const provider = parsed.providers[0];
    if (provider === undefined) {
      throw new Error("test fixture must include one provider");
    }
    provider.modelId = "example-private-chat";
    provider.capability = {
      kind: "chat",
      toolCalling: true,
      structuredOutput: true,
      costClass: "medium",
      latencyClass: "standard",
    };
    writeFileSync(path, JSON.stringify(parsed), "utf8");
    const c = makeIo();
    const code = runModelsCli(["validate", "--config", path], c.io, {});
    expect(code).toBe(0);
    expect(c.out()).toContain("valid");
  });

  it("never prints a credential value when reporting a validation error", () => {
    const path = join(dir, "leak.json");
    writeFileSync(
      path,
      JSON.stringify({
        providers: [
          {
            modelId: "example-chat-model",
            baseUrl: "https://h/v1",
            apiKey: "sk-leaky-1234567890abcdef",
            timeoutMs: -1,
          },
        ],
        circuitBreaker: {},
      }),
      "utf8",
    );
    const c = makeIo();
    const code = runModelsCli(["validate", "--config", path], c.io, {});
    expect(code).toBe(1);
    expect(c.out() + c.err()).not.toContain("sk-leaky-1234567890abcdef");
  });

  it("exits 1 when no config source is available", () => {
    const c = makeIo();
    const code = runModelsCli(["validate"], c.io, {});
    expect(code).toBe(1);
    expect(c.err()).toContain("GATEWAY_CONFIG_INVALID");
  });

  it("reads the config path from KEIKO_CONFIG_FILE when no flag is given", () => {
    const path = join(dir, "env.json");
    writeFileSync(path, validConfig(), "utf8");
    const c = makeIo();
    const code = runModelsCli(["validate"], c.io, { KEIKO_CONFIG_FILE: path });
    expect(code).toBe(0);
    expect(c.out()).toContain("valid");
  });

  it("exits 2 for an unknown sub-command", () => {
    const c = makeIo();
    const code = runModelsCli(["frobnicate"], c.io, {});
    expect(code).toBe(2);
    expect(c.err().length).toBeGreaterThan(0);
  });

  it("exits 2 when no sub-command is given", () => {
    const c = makeIo();
    const code = runModelsCli([], c.io, {});
    expect(code).toBe(2);
    expect(c.err()).toContain("Usage");
  });

  it("exits 2 when --config is supplied without a value", () => {
    const c = makeIo();
    const code = runModelsCli(["validate", "--config"], c.io, {});
    expect(code).toBe(2);
  });
});
