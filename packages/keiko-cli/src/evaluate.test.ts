// CLI evaluate tests (ADR-0012 D10, AC#4). Exercises runEvaluateCli through its injected IO seam
// without spawning a child process: --help, offline run, --json, usage errors, --fixture selection,
// --live fail-closed, and --output file write. No network or live model.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runEvaluateCli } from "./evaluate.js";
import type { EvaluateDeps } from "./evaluate.js";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { ConfigInvalidError } from "@oscharko-dev/keiko-model-gateway";
import {
  createScriptedModelPort,
  type EvaluationFixture,
  type EvaluationMode,
} from "../../../src/evaluations/index.js";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";

// ─── IO capture helpers ───────────────────────────────────────────────────────

interface CapturedIo {
  readonly out: string;
  readonly err: string;
}

function makeIo(): { io: Parameters<typeof runEvaluateCli>[1]; captured: () => CapturedIo } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      out: (text: string): void => void outChunks.push(text),
      err: (text: string): void => void errChunks.push(text),
    },
    captured: () => ({ out: outChunks.join(""), err: errChunks.join("") }),
  };
}

// Fixed clock + in-memory store so tests never touch disk or the real clock.
const FIXED_NOW = 1_700_000_000_000;
const fixedNow = (): number => FIXED_NOW;
const fixedId = (): string => "cli-test-id";

function offlineDeps(): EvaluateDeps {
  return {
    runner: {
      store: createInMemoryEvidenceStore(),
      now: fixedNow,
      idSource: fixedId,
    },
  };
}

function modelResponse(content: string): NormalizedResponse {
  return {
    modelId: "eval-model",
    content,
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "cli-live-redaction",
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

// ─── --help ───────────────────────────────────────────────────────────────────

describe("--help", () => {
  it("exits 0 and prints usage", async () => {
    const { io, captured } = makeIo();
    const code = await runEvaluateCli(["--help"], io);
    expect(code).toBe(0);
    expect(captured().out).toContain("keiko evaluate");
  });
});

// ─── offline run ──────────────────────────────────────────────────────────────

describe("offline run (default)", () => {
  it("exits 0 for --suite all", async () => {
    const { io } = makeIo();
    const code = await runEvaluateCli(["--suite", "all"], io, {}, offlineDeps());
    expect(code).toBe(0);
  });

  it("prints the concise text summary by default", async () => {
    const { io, captured } = makeIo();
    const code = await runEvaluateCli(["--suite", "all"], io, {}, offlineDeps());
    expect(code).toBe(0);
    expect(captured().out).toContain("Keiko evaluation summary");
    expect(captured().out).toContain("unit-tests");
    expect(captured().out).toContain("Verdict:");
  });

  it("exits 0 for --suite unit-tests", async () => {
    const { io } = makeIo();
    const code = await runEvaluateCli(["--suite", "unit-tests"], io, {}, offlineDeps());
    expect(code).toBe(0);
  });
});

// ─── --json ───────────────────────────────────────────────────────────────────

describe("--json flag", () => {
  it("exits 0 and outputs valid JSON with schemaVersion '1'", async () => {
    const { io, captured } = makeIo();
    const code = await runEvaluateCli(["--suite", "all", "--json"], io, {}, offlineDeps());
    expect(code).toBe(0);
    const parsed = JSON.parse(captured().out) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe("1");
  });

  it("JSON output includes evaluatedAt and mode fields", async () => {
    const { io, captured } = makeIo();
    await runEvaluateCli(["--suite", "all", "--json"], io, {}, offlineDeps());
    const parsed = JSON.parse(captured().out) as Record<string, unknown>;
    expect(typeof parsed.evaluatedAt).toBe("string");
    expect(parsed.mode).toBe("offline");
  });
});

// ─── Usage errors (exit 2) ────────────────────────────────────────────────────

describe("usage errors → exit 2", () => {
  it("unknown --suite value exits 2", async () => {
    const { io, captured } = makeIo();
    const code = await runEvaluateCli(["--suite", "no-such-suite"], io);
    expect(code).toBe(2);
    expect(captured().err).toContain("unknown suite");
  });

  it("--suite and --fixture together exit 2", async () => {
    const { io, captured } = makeIo();
    const code = await runEvaluateCli(["--suite", "all", "--fixture", "happy-path"], io);
    expect(code).toBe(2);
    expect(captured().err).toContain("mutually exclusive");
  });

  it("unknown --fixture name exits 2", async () => {
    const { io, captured } = makeIo();
    const code = await runEvaluateCli(["--fixture", "no-such-fixture"], io);
    expect(code).toBe(2);
    expect(captured().err).toContain("unknown fixture");
  });

  it("unknown flags exit 2 instead of running the suite", async () => {
    const { io, captured } = makeIo();
    const code = await runEvaluateCli(["--definitely-unknown"], io, {}, offlineDeps());
    expect(code).toBe(2);
    expect(captured().err).toContain("unknown flag --definitely-unknown");
    expect(captured().out).toBe("");
  });
});

// ─── Single --fixture selection ───────────────────────────────────────────────

describe("--fixture selection", () => {
  it("runs only the specified fixture (fixtureResults has exactly one entry)", async () => {
    const { io, captured } = makeIo();
    const code = await runEvaluateCli(
      ["--fixture", "unit-tests/happy-path", "--json"],
      io,
      {},
      offlineDeps(),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(captured().out) as { fixtureResults: unknown[] };
    expect(parsed.fixtureResults).toHaveLength(1);
  });

  it("fixtureResults[0].fixtureName matches the requested fixture", async () => {
    const { io, captured } = makeIo();
    await runEvaluateCli(
      ["--fixture", "unit-tests/unsafe-action", "--json"],
      io,
      {},
      offlineDeps(),
    );
    const parsed = JSON.parse(captured().out) as {
      fixtureResults: { fixtureName: string }[];
    };
    expect(parsed.fixtureResults[0]?.fixtureName).toBe("unsafe-action");
  });
});

// ─── --live fail-closed ───────────────────────────────────────────────────────

describe("--live fail-closed", () => {
  it("exits 1 on the default missing-config path", async () => {
    const { io, captured } = makeIo();
    const code = await runEvaluateCli(["--suite", "all", "--live"], io, {}, offlineDeps());
    expect(code).toBe(1);
    expect(captured().err).toContain("KEIKO_CONFIG_FILE");
    expect(captured().out).toBe("");
  });

  it("exits 1 when the injected modelProviderFactory throws ConfigInvalidError", async () => {
    const { io, captured } = makeIo();
    const failingFactory = (
      _fixture: EvaluationFixture,
      _mode: EvaluationMode,
      _modelId: string,
    ): ModelPort => {
      throw new ConfigInvalidError("no API key configured");
    };
    const code = await runEvaluateCli(
      ["--suite", "all", "--live"],
      io,
      {},
      {
        runner: {
          modelProviderFactory: failingFactory,
          store: createInMemoryEvidenceStore(),
          now: fixedNow,
          idSource: fixedId,
        },
      },
    );
    expect(code).toBe(1);
    const { out, err } = captured();
    // Config error must appear on stderr
    expect(err).toContain("configuration problem");
    // stdout must NOT contain an API-key-shaped string (fail-closed, no silent offline fallback)
    expect(out).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    // No scorecard is emitted on stdout when live config fails
    expect(out).not.toContain("schemaVersion");
  });

  it("error message is on stderr, not stdout", async () => {
    const { io, captured } = makeIo();
    const failingFactory = (): ModelPort => {
      throw new ConfigInvalidError("missing credentials");
    };
    await runEvaluateCli(
      ["--suite", "all", "--live"],
      io,
      {},
      {
        runner: {
          modelProviderFactory: failingFactory,
          store: createInMemoryEvidenceStore(),
          now: fixedNow,
          idSource: fixedId,
        },
      },
    );
    const { out, err } = captured();
    expect(err.length).toBeGreaterThan(0);
    expect(out).toBe("");
  });

  it("redacts exact Keiko API-key env literals from successful live JSON output", async () => {
    const secret = "non-pattern-secret-12345";
    const { io, captured } = makeIo();
    const code = await runEvaluateCli(
      ["--fixture", "bug-investigation/investigation-only", "--live", "--json"],
      io,
      { KEIKO_DEFAULT_API_KEY: secret },
      {
        runner: {
          modelProviderFactory: (): ModelPort =>
            createScriptedModelPort([
              modelResponse(
                [
                  "## Root cause",
                  `The configured key marker is ${secret}.`,
                  "## Confidence",
                  "low",
                ].join("\n"),
              ),
            ]),
          store: createInMemoryEvidenceStore(),
          now: fixedNow,
          idSource: fixedId,
        },
      },
    );
    expect(code).toBe(0);
    expect(captured().out).not.toContain(secret);
    expect(captured().out).toContain("[REDACTED]");
  });
});

// ─── --output file write ──────────────────────────────────────────────────────

describe("--output flag", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keiko-eval-cli-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the scorecard to the specified file", async () => {
    const outputPath = join(dir, "scorecard.json");
    const { io } = makeIo();
    const code = await runEvaluateCli(
      ["--suite", "all", "--output", outputPath],
      io,
      {},
      offlineDeps(),
    );
    expect(code).toBe(0);
    expect(existsSync(outputPath)).toBe(true);
    const content = readFileSync(outputPath, "utf8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe("1");
  });

  it("written scorecard file contains mode and evaluatedAt fields", async () => {
    const outputPath = join(dir, "scorecard2.json");
    const { io } = makeIo();
    await runEvaluateCli(["--suite", "all", "--output", outputPath], io, {}, offlineDeps());
    const parsed = JSON.parse(readFileSync(outputPath, "utf8")) as Record<string, unknown>;
    expect(typeof parsed.evaluatedAt).toBe("string");
    expect(parsed.mode).toBe("offline");
  });

  it("refuses to overwrite an existing output file", async () => {
    const outputPath = join(dir, "existing.json");
    writeFileSync(outputPath, "keep me", "utf8");
    const { io, captured } = makeIo();
    const code = await runEvaluateCli(
      ["--suite", "all", "--output", outputPath],
      io,
      {},
      offlineDeps(),
    );
    expect(code).toBe(1);
    expect(captured().err).toContain("output file already exists");
    expect(readFileSync(outputPath, "utf8")).toBe("keep me");
  });
});
