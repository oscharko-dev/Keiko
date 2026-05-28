import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runModelsCli } from "../../src/cli/models.js";
import type { CliIo } from "../../src/cli/runner.js";

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

const REQUIRED_IDS = [
  "Qwen3-Coder-480B-A35B-Instruct-FP8",
  "Qwen/Qwen3-Coder-Next-FP8",
  "Devstral-2-123B-Instruct-2512",
  "gpt-oss-120b",
  "Mistral-Small-3.1-24B-Instruct-2503",
  "Qwen2.5-Coder-7B-Instruct",
  "gemma-4-31b-it",
  "dotsocr",
  "multilingual-e5-large Embedding",
];

const API_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}/;

function validConfig(): string {
  return JSON.stringify({
    providers: [
      {
        modelId: "gpt-oss-120b",
        baseUrl: "https://host.example/v1",
        apiKey: "sk-secret-config-value-1234567890",
        timeoutMs: 30000,
        maxRetries: 3,
        retryBaseDelayMs: 500,
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenProbes: 2 },
  });
}

describe("runModelsCli list", () => {
  it("lists all nine models on stdout and exits 0", () => {
    const c = makeIo();
    const code = runModelsCli(["list"], c.io, {});
    expect(code).toBe(0);
    for (const id of REQUIRED_IDS) {
      expect(c.out()).toContain(id);
    }
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

  it("never prints a credential value when reporting a validation error", () => {
    const path = join(dir, "leak.json");
    writeFileSync(
      path,
      JSON.stringify({
        providers: [
          {
            modelId: "gpt-oss-120b",
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
