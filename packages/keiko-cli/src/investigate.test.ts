import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInvestigateCli } from "./investigate.js";
import { runCli } from "./runner.js";
import type { CliIo } from "./runner.js";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import {
  FIXTURE_API_KEY,
  PROVIDER_CREDENTIALS_KEY,
  REAL_TMPDIR,
  serializeGatewayConfig,
  writeReferenceOnlyGatewayConfig as writeReferenceOnlyGatewayConfigFixture,
} from "./test-support/gateway-config-fixture.js";

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

function modelReturning(content: string): ModelPort {
  const response: NormalizedResponse = {
    modelId: "m",
    content,
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "r",
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "high",
    },
  };
  return { call: (): Promise<NormalizedResponse> => Promise.resolve(response) };
}

function gatewayConfig(modelIds: readonly string[]): string {
  return serializeGatewayConfig({ modelIds });
}

const FIX = [
  "```diff",
  "--- a/src/buggy.ts",
  "+++ b/src/buggy.ts",
  "@@ -1 +1 @@",
  "-export const half = (n: number): number => n / 3;",
  "+export const half = (n: number): number => n / 2;",
  "```",
  "## Root cause",
  "Divisor was 3.",
  "## Confidence",
  "high",
].join("\n");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(REAL_TMPDIR, "keiko-investigate-cli-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "demo", devDependencies: { vitest: "^4" } }, null, 2),
    "utf8",
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "buggy.ts"),
    "export const half = (n: number): number => n / 3;\n",
    "utf8",
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runInvestigateCli (AC #1 CLI)", () => {
  it("is documented in the top-level help text", () => {
    const cap = makeIo();
    const code = runCli(["--help"], cap.io);
    expect(code).toBe(0);
    expect(cap.out()).toContain("keiko investigate");
  });

  it("exits 0 with usage on stdout for --help (issue #640)", async () => {
    const cap = makeIo();
    const code = await runInvestigateCli(["--help"], cap.io);
    expect(code).toBe(0);
    expect(cap.out()).toContain("Usage:");
    expect(cap.err()).toBe("");
  });

  it("exits 0 with usage on stdout for -h (issue #640)", async () => {
    const cap = makeIo();
    const code = await runInvestigateCli(["-h"], cap.io);
    expect(code).toBe(0);
    expect(cap.out()).toContain("Usage:");
    expect(cap.err()).toBe("");
  });

  it("exits 2 with usage when no evidence source is given", async () => {
    const cap = makeIo();
    const code = await runInvestigateCli(
      ["--dir-root", dir],
      cap.io,
      {},
      { model: modelReturning(FIX) },
    );
    expect(code).toBe(2);
    expect(cap.err()).toContain("Usage:");
  });

  it("exits 2 when a value flag is missing its value", async () => {
    const cap = makeIo();
    const code = await runInvestigateCli(
      ["--description"],
      cap.io,
      {},
      { model: modelReturning(FIX) },
    );
    expect(code).toBe(2);
  });

  it("dry-run prints the proposed fix and the verified/hypothesis sections (exit 0)", async () => {
    const cap = makeIo();
    const code = await runInvestigateCli(
      [
        "--description",
        "half is wrong",
        "--stack",
        "at half (src/buggy.ts:1:40)",
        "--dir-root",
        dir,
      ],
      cap.io,
      {},
      { model: modelReturning(FIX) },
    );
    expect(code).toBe(0);
    expect(cap.out()).toContain("proposed fix");
    expect(cap.out()).toContain("n / 2");
    expect(cap.out()).toContain("UNVERIFIED");
  });

  it("reads failing output from --output-file via the injected reader", async () => {
    const cap = makeIo();
    const code = await runInvestigateCli(
      ["--output-file", "/virtual/out.txt", "--dir-root", dir, "--json"],
      cap.io,
      {},
      { model: modelReturning(FIX), readFile: () => "AssertionError at src/buggy.ts:1:40" },
    );
    expect(code).toBe(0);
    const report = JSON.parse(cap.out()) as {
      status: string;
      verified: { failureFrames: unknown[] };
    };
    expect(report.status).toBe("fix-proposed");
    expect(report.verified.failureFrames.length).toBeGreaterThan(0);
  });

  it("reads failing output from an in-workspace --output-file through the workspace boundary", async () => {
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(join(dir, "logs", "failure.txt"), "AssertionError at src/buggy.ts:1:40", "utf8");
    const cap = makeIo();
    const code = await runInvestigateCli(
      ["--output-file", "logs/failure.txt", "--dir-root", dir, "--json"],
      cap.io,
      {},
      { model: modelReturning(FIX) },
    );
    expect(code).toBe(0);
    const report = JSON.parse(cap.out()) as {
      status: string;
      verified: { failureFrames: unknown[] };
    };
    expect(report.status).toBe("fix-proposed");
    expect(report.verified.failureFrames.length).toBeGreaterThan(0);
  });

  it("rejects an --output-file outside the workspace boundary before model use", async () => {
    const outside = mkdtempSync(join(tmpdir(), "keiko-investigate-outside-"));
    try {
      writeFileSync(
        join(outside, "failure.txt"),
        "AssertionError at src/buggy.ts:1:40 outside-payload-not-leaked",
        "utf8",
      );
      let modelCalls = 0;
      const model: ModelPort = {
        call: (request, signal) => {
          modelCalls += 1;
          return modelReturning(FIX).call(request, signal);
        },
      };
      const cap = makeIo();
      const code = await runInvestigateCli(
        ["--output-file", join(outside, "failure.txt"), "--dir-root", dir],
        cap.io,
        {},
        { model },
      );
      expect(code).toBe(1);
      expect(modelCalls).toBe(0);
      expect(cap.err()).toContain("WORKSPACE_PATH_ESCAPE");
      expect(cap.err()).not.toContain("outside-payload-not-leaked");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("exits 1 when an evidence file cannot be read", async () => {
    const cap = makeIo();
    const reader = (): string => {
      const err = new Error("ENOENT: no such file") as Error & { code: string };
      err.code = "ENOENT";
      throw err;
    };
    const code = await runInvestigateCli(
      ["--output-file", "/missing.txt", "--dir-root", dir],
      cap.io,
      {},
      { model: modelReturning(FIX), readFile: reader },
    );
    expect(code).toBe(1);
    expect(cap.err()).toContain("could not read");
  });

  // Regression pin (KEIKO-0464): isFileReadError must not match any error that merely carries a
  // non-empty string `code`. A GatewayError-shaped error (typed non-fs error taxonomy) reaching
  // handleCliError must NOT be reported as "could not read an evidence file"; the message would
  // point the operator at the wrong subsystem and discard the real code.
  it("does not misclassify a typed non-fs error as a file-read error", async () => {
    const cap = makeIo();
    const reader = (): string => {
      throw Object.assign(new Error("gateway boom"), { code: "GATEWAY_TRANSPORT" });
    };
    let caught: unknown;
    try {
      await runInvestigateCli(
        ["--output-file", "/anywhere.txt", "--dir-root", dir],
        cap.io,
        {},
        { model: modelReturning(FIX), readFile: reader },
      );
    } catch (error) {
      caught = error;
    }
    // Post-fix: handleCliError rethrows because isFileReadError rejects a non-fs code.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("gateway boom");
    expect(cap.err()).not.toContain("could not read an evidence file");
  });

  it("selects the cheapest configured capable model when --model is omitted", async () => {
    const configPath = join(dir, "gateway.json");
    writeFileSync(
      configPath,
      gatewayConfig(["example-chat-model", "example-chat-model-fast"]),
      "utf8",
    );
    let seenModelId: string | undefined;
    const model: ModelPort = {
      call: (request): Promise<NormalizedResponse> => {
        seenModelId = request.modelId;
        return Promise.resolve(modelReturning(FIX).call(request, new AbortController().signal));
      },
    };
    const cap = makeIo();
    const code = await runInvestigateCli(
      ["--description", "half is wrong", "--dir-root", dir, "--config", configPath],
      cap.io,
      {},
      { model },
    );
    expect(code).toBe(0);
    expect(seenModelId).toBe("example-chat-model-fast");
  });

  it("loads a reference-only config when selecting the injected model", async () => {
    const configPath = writeReferenceOnlyGatewayConfigFixture(dir, {
      modelIds: ["example-chat-model-fast"],
      filename: "gateway-reference-only.json",
    });
    let seenModelId: string | undefined;
    const model: ModelPort = {
      call: (request): Promise<NormalizedResponse> => {
        seenModelId = request.modelId;
        return Promise.resolve(modelReturning(FIX).call(request, new AbortController().signal));
      },
    };
    const cap = makeIo();
    const code = await runInvestigateCli(
      ["--description", "half is wrong", "--dir-root", dir, "--config", configPath],
      cap.io,
      { KEIKO_PROVIDER_CREDENTIALS_KEY: PROVIDER_CREDENTIALS_KEY },
      { model },
    );
    expect(code).toBe(0);
    expect(seenModelId).toBe("example-chat-model-fast");
    expect(cap.out() + cap.err()).not.toContain(FIXTURE_API_KEY);
  });

  it("does not default to a configured chat model without structured output", async () => {
    const configPath = join(dir, "gateway.json");
    writeFileSync(configPath, gatewayConfig(["example-chat-model-unstructured"]), "utf8");
    let seenModelId: string | undefined;
    const model: ModelPort = {
      call: (request): Promise<NormalizedResponse> => {
        seenModelId = request.modelId;
        return Promise.resolve(modelReturning(FIX).call(request, new AbortController().signal));
      },
    };
    const cap = makeIo();
    const code = await runInvestigateCli(
      ["--description", "half is wrong", "--dir-root", dir, "--config", configPath],
      cap.io,
      {},
      { model },
    );
    expect(code).toBe(1);
    expect(seenModelId).toBeUndefined();
    expect(cap.err()).toContain("workflow-capable chat model");
  });

  it("allows an explicit configured chat model even when it does not advertise structured output", async () => {
    const configPath = join(dir, "gateway.json");
    writeFileSync(configPath, gatewayConfig(["example-chat-model-unstructured"]), "utf8");
    let seenModelId: string | undefined;
    const model: ModelPort = {
      call: (request): Promise<NormalizedResponse> => {
        seenModelId = request.modelId;
        return Promise.resolve(modelReturning(FIX).call(request, new AbortController().signal));
      },
    };
    const cap = makeIo();
    const code = await runInvestigateCli(
      [
        "--description",
        "half is wrong",
        "--dir-root",
        dir,
        "--config",
        configPath,
        "--model",
        "example-chat-model-unstructured",
      ],
      cap.io,
      {},
      { model },
    );
    expect(code).toBe(0);
    expect(seenModelId).toBe("example-chat-model-unstructured");
  });
});
