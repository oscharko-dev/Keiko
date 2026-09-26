import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInvestigateCli, timelineToBugReportInput } from "./investigate.js";
import { runCli } from "./runner.js";
import type { CliIo } from "./runner.js";
import { analyzeLogText, findTimeline, type LogTimeline } from "./support-analyze.js";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import {
  createInMemoryEvidenceStore,
  EvidenceWriteError,
  type EvidenceStore,
} from "@oscharko-dev/keiko-evidence";
import {
  CancelledError,
  createScriptedGatewayClock,
  createScriptedGatewayFetch,
  Gateway,
  type GatewayCallRequest,
  type GatewayConfig,
  type GatewayRequest,
  type ModelProviderConfig,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { keikoStackFrames } from "@oscharko-dev/keiko-server";
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

// Same shape as `bug-investigation/workflow.test.ts`'s own "rejects an out-of-scope patch after
// retries" fixture: a patch outside the workflow's allowed scope (a CI workflow file), which the
// scope guard rejects on every retry, driving the terminal status to "rejected".
const OUT_OF_SCOPE_FIX = [
  "```diff",
  "--- a/.github/workflows/ci.yml",
  "+++ b/.github/workflows/ci.yml",
  "@@ -1 +1 @@",
  "-on: push",
  "+on: { push: {}, pull_request_target: {} }",
  "```",
  "## Root cause",
  "x",
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
        "--no-evidence",
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
      ["--output-file", "/virtual/out.txt", "--dir-root", dir, "--json", "--no-evidence"],
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
      ["--output-file", "logs/failure.txt", "--dir-root", dir, "--json", "--no-evidence"],
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
      [
        "--description",
        "half is wrong",
        "--dir-root",
        dir,
        "--config",
        configPath,
        "--no-evidence",
      ],
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
      [
        "--description",
        "half is wrong",
        "--dir-root",
        dir,
        "--config",
        configPath,
        "--no-evidence",
      ],
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
        "--no-evidence",
      ],
      cap.io,
      {},
      { model },
    );
    expect(code).toBe(0);
    expect(seenModelId).toBe("example-chat-model-unstructured");
  });
});

// ─── Wave 6 closeout (epic #3233, w6-investigate-from-timeline) ────────────────────────────────

function scriptedProvider(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    modelId: "example-chat-model",
    baseUrl: "https://provider.example/v1",
    apiKey: ["sk-", "investigate-from-timeline-secret-key-1234567890ab"].join(""),
    timeoutMs: 30_000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
    ...overrides,
  };
}

function scriptedGatewayConfig(providers: ModelProviderConfig[]): GatewayConfig {
  return {
    providers,
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1000, halfOpenProbes: 1 },
  };
}

const SCRIPTED_GATEWAY_REQUEST: GatewayRequest = {
  modelId: "example-chat-model",
  messages: [{ role: "user", content: "hello" }],
};

// Structurally matches `ModelGatewayLogEvent` — same recorder-double pattern log-analyze.test.ts
// already uses for the same reason: a write-compatible double, not a re-declared internal type.
interface CapturedGatewayEvent {
  readonly level?: string | undefined;
  readonly category: string;
  readonly op: string;
  readonly correlationId?: string | undefined;
  readonly errorKind?: string | undefined;
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
}

// Flattens a captured event into an envelope-v2 server-log JSON line (mirrors
// `formatServerLogLine`'s documented flattening, log-analyze.test.ts's own precedent): the
// identity (pid/instanceId/seq/ts) is synthetic test data, but `extra.frames` below is always a
// REAL `keikoStackFrames(...)` result over a real thrown error, never hand-typed.
function envelopeLine(
  event: CapturedGatewayEvent,
  ts: string,
  pid: number,
  instanceId: string,
  seq: number,
): string {
  return JSON.stringify({
    ts,
    pid,
    instanceId,
    seq,
    schemaVersion: 2,
    ...(event.level === undefined ? {} : { level: event.level }),
    category: event.category,
    op: event.op,
    ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
    ...(event.errorKind === undefined ? {} : { errorKind: event.errorKind }),
    ...(event.extra ?? {}),
  });
}

function timelineTsAt(index: number): string {
  return new Date(Date.parse("2026-08-21T00:00:00.000Z") + index * 1000).toISOString();
}

describe("runInvestigateCli --from-timeline (Wave 6 closeout)", () => {
  // Required test 1: a scripted scenario drives the REAL Gateway/resilience.ts machinery to a
  // forced failure (ADR-0173 §7.3 discipline — the same one log-analyze.test.ts already uses), the
  // resulting log lines (including a REAL `keikoStackFrames` reduction of the actual thrown error,
  // never a hand-typed frame string) are analyzed into a genuine LogTimeline via the production
  // `analyzeLogText`/`findTimeline`, and `keiko investigate --from-timeline ... --json`'s report
  // is asserted to reference the SAME frame file paths the timeline recorded.
  it("seeds verified.failureFrames from a reconstructed timeline's real frames", async () => {
    const sharedClock = createScriptedGatewayClock();
    const fetchImpl = createScriptedGatewayFetch(
      [{ status: 503, bodyJson: { error: { message: "upstream overloaded" } }, latencyMs: 0 }],
      sharedClock,
    );
    const events: CapturedGatewayEvent[] = [];
    const scriptedGateway = new Gateway(
      scriptedGatewayConfig([scriptedProvider({ maxRetries: 0, retryBaseDelayMs: 1 })]),
      {
        clock: sharedClock,
        fetchImpl,
        log: { write: (event: CapturedGatewayEvent): void => void events.push(event) },
        random: (): number => 0.5,
      },
    );
    const correlationId = "from-timeline-correlation-1";
    const request: GatewayCallRequest = {
      ...SCRIPTED_GATEWAY_REQUEST,
      logContext: { correlationId },
    };

    let thrown: unknown;
    try {
      await scriptedGateway.chat(request);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const frames = keikoStackFrames(thrown);
    expect(frames.length).toBeGreaterThan(0);

    const lines = events.map((event, index) =>
      envelopeLine(event, timelineTsAt(index), 9000, "aaaaaaaa", index + 1),
    );
    lines.push(
      envelopeLine(
        {
          category: "diagnostic",
          op: "gateway.chat.failed",
          correlationId,
          errorKind: "GatewayError",
          extra: { frames },
        },
        timelineTsAt(events.length),
        9000,
        "aaaaaaaa",
        events.length + 1,
      ),
    );
    const text = `${lines.join("\n")}\n`;

    const analyzed = analyzeLogText(text);
    const timeline = findTimeline(analyzed, correlationId);
    expect(timeline).toBeDefined();
    if (timeline === undefined) return;
    expect(timeline.frames).toBeDefined();
    expect(timeline.frames?.length).toBeGreaterThan(0);

    writeFileSync(join(dir, "bundle-timeline.json"), JSON.stringify(timeline), "utf8");

    const cap = makeIo();
    const code = await runInvestigateCli(
      ["--from-timeline", "bundle-timeline.json", "--dir-root", dir, "--json", "--no-evidence"],
      cap.io,
      {},
      { model: modelReturning(FIX) },
    );
    expect(code).toBe(0);
    const report = JSON.parse(cap.out()) as {
      status: string;
      verified: { failureFrames: readonly { file: string; line?: number }[] };
    };
    expect(report.status).toBe("fix-proposed");
    expect(report.verified.failureFrames.length).toBeGreaterThan(0);

    const reportedFiles = new Set(report.verified.failureFrames.map((frame) => frame.file));
    const timelineFramePaths = (timeline.frames ?? []).map((frame) =>
      frame.replace(/:\d+:\d+$/u, ""),
    );
    expect(timelineFramePaths.length).toBeGreaterThan(0);
    for (const path of timelineFramePaths) {
      expect(reportedFiles.has(path)).toBe(true);
    }
  });

  it("fails closed on a malformed --from-timeline file before any model call", async () => {
    writeFileSync(join(dir, "bad-timeline.json"), "{not json", "utf8");
    let modelCalls = 0;
    const model: ModelPort = {
      call: (request, signal) => {
        modelCalls += 1;
        return modelReturning(FIX).call(request, signal);
      },
    };
    const cap = makeIo();
    const code = await runInvestigateCli(
      ["--from-timeline", "bad-timeline.json", "--dir-root", dir, "--no-evidence"],
      cap.io,
      {},
      { model },
    );
    expect(code).toBe(1);
    expect(modelCalls).toBe(0);
    expect(cap.err()).toContain("invalid --from-timeline file");
  });

  it("fails closed on a --from-timeline file that is valid JSON but not a LogTimeline", async () => {
    writeFileSync(join(dir, "not-a-timeline.json"), JSON.stringify({ hello: "world" }), "utf8");
    const cap = makeIo();
    const code = await runInvestigateCli(
      ["--from-timeline", "not-a-timeline.json", "--dir-root", dir, "--no-evidence"],
      cap.io,
      {},
      { model: modelReturning(FIX) },
    );
    expect(code).toBe(1);
    expect(cap.err()).toContain("invalid --from-timeline file");
  });

  // `isLogTimeline`'s own top-level type guard: the file above is valid JSON that IS an object, so
  // the guard's `typeof value !== "object" || value === null` check passes straight through and the
  // rejection instead comes from `hasLogTimelineCoreFields`. A bare JSON primitive at the top level
  // hits the guard's own branch directly.
  it("fails closed on a --from-timeline file whose JSON top level is not an object", async () => {
    writeFileSync(join(dir, "primitive-timeline.json"), "42", "utf8");
    const cap = makeIo();
    const code = await runInvestigateCli(
      ["--from-timeline", "primitive-timeline.json", "--dir-root", dir, "--no-evidence"],
      cap.io,
      {},
      { model: modelReturning(FIX) },
    );
    expect(code).toBe(1);
    expect(cap.err()).toContain("invalid --from-timeline file");
  });

  // `isServerLogLineView`'s own type guard: an otherwise well-shaped timeline whose `lines` array
  // contains an entry that is not an object at all (never reachable from the real analyzer, which
  // always emits object line records, but a hand-edited or hostile --from-timeline file can carry
  // anything).
  it("fails closed on a --from-timeline file whose lines array contains a non-object entry", async () => {
    writeFileSync(
      join(dir, "bad-lines-timeline.json"),
      JSON.stringify({
        correlationId: "req-x",
        lines: ["not-an-object"],
        firstTs: "2026-08-21T00:00:00.000Z",
        lastTs: "2026-08-21T00:00:00.000Z",
        durationMs: 1,
        errorKinds: [],
      }),
      "utf8",
    );
    const cap = makeIo();
    const code = await runInvestigateCli(
      ["--from-timeline", "bad-lines-timeline.json", "--dir-root", dir, "--no-evidence"],
      cap.io,
      {},
      { model: modelReturning(FIX) },
    );
    expect(code).toBe(1);
    expect(cap.err()).toContain("invalid --from-timeline file");
  });

  it("maps frames/ops/errorKinds onto BugReportInput via timelineToBugReportInput", () => {
    const timeline: LogTimeline = {
      correlationId: "unit-timeline-1",
      lines: [
        { ts: "2026-08-21T00:00:00.000Z", category: "gateway", op: "gateway.chat.request" },
        {
          ts: "2026-08-21T00:00:01.000Z",
          category: "gateway",
          op: "gateway.chat.failed",
          errorKind: "GatewayError",
        },
      ],
      firstTs: "2026-08-21T00:00:00.000Z",
      lastTs: "2026-08-21T00:00:01.000Z",
      durationMs: 1000,
      errorKinds: ["GatewayError"],
      frames: ["packages/keiko-model-gateway/src/gateway.ts:42:7"],
    };
    const report = timelineToBugReportInput(timeline);
    expect(report.stackTrace).toBe("at packages/keiko-model-gateway/src/gateway.ts:42:7");
    expect(report.targetFiles).toEqual(["packages/keiko-model-gateway/src/gateway.ts"]);
    expect(report.description).toContain("gateway.chat.request");
    expect(report.description).toContain("gateway.chat.failed");
    expect(report.description).toContain("GatewayError");
  });

  it("returns an empty BugReportInput for a timeline with no frames, ops, or error kinds", () => {
    // Not producible by the real analyzer (every line carries an `op`), but exercises the adapter's
    // own defined behaviour at its boundary rather than only the shapes the analyzer happens to emit.
    const timeline: LogTimeline = {
      correlationId: "unit-timeline-empty",
      lines: [],
      firstTs: "2026-08-21T00:00:00.000Z",
      lastTs: "2026-08-21T00:00:00.000Z",
      durationMs: 0,
      errorKinds: [],
    };
    expect(timelineToBugReportInput(timeline)).toEqual({});
  });

  // `framePath`'s fallback (the `:LINE:COL` suffix stripping only fires when BOTH trailing
  // colon-separated segments are all-digits): a frame that does not carry that shape must be
  // passed through unchanged rather than dropped or mis-truncated.
  it("passes a frame through unchanged when it has no trailing :LINE:COL suffix", () => {
    const timeline: LogTimeline = {
      correlationId: "unit-timeline-opaque-frame",
      lines: [{ ts: "2026-08-21T00:00:00.000Z", category: "gateway", op: "gateway.chat.request" }],
      firstTs: "2026-08-21T00:00:00.000Z",
      lastTs: "2026-08-21T00:00:00.000Z",
      durationMs: 0,
      errorKinds: [],
      frames: [
        "packages/keiko-model-gateway/src/gateway.ts:42:7",
        "some-opaque-frame-without-a-location",
      ],
    };
    const report = timelineToBugReportInput(timeline);
    expect(report.targetFiles).toEqual([
      "packages/keiko-model-gateway/src/gateway.ts",
      "some-opaque-frame-without-a-location",
    ]);
    expect(report.stackTrace).toContain("at some-opaque-frame-without-a-location");
  });

  // `timelineDescription`'s two independent `if`s (ops observed / error kinds observed): the two
  // existing tests above exercise "both present" and "both absent" (which short-circuits before
  // either `if`); these exercise each `if` landing on its OWN false branch, one at a time.
  it("describes error kinds alone when no operations were observed", () => {
    const timeline: LogTimeline = {
      correlationId: "unit-timeline-ops-empty",
      lines: [],
      firstTs: "2026-08-21T00:00:00.000Z",
      lastTs: "2026-08-21T00:00:00.000Z",
      durationMs: 0,
      errorKinds: ["GatewayError"],
    };
    const report = timelineToBugReportInput(timeline);
    expect(report.description).toContain("Error kinds: GatewayError.");
    expect(report.description).not.toContain("Operations observed");
  });

  it("describes operations alone when no error kinds were recorded", () => {
    const timeline: LogTimeline = {
      correlationId: "unit-timeline-errorkinds-empty",
      lines: [{ ts: "2026-08-21T00:00:00.000Z", category: "http", op: "request.sent" }],
      firstTs: "2026-08-21T00:00:00.000Z",
      lastTs: "2026-08-21T00:00:00.000Z",
      durationMs: 0,
      errorKinds: [],
    };
    const report = timelineToBugReportInput(timeline);
    expect(report.description).toContain("Operations observed: request.sent.");
    expect(report.description).not.toContain("Error kinds");
  });
});

// ─── g23: CLI evidence parity with `keiko run` ──────────────────────────────────────────────────

describe("runInvestigateCli evidence-by-default (g23)", () => {
  it("writes a redacted evidence-ledger entry to the injected store for a plain investigate run", async () => {
    const store: EvidenceStore = createInMemoryEvidenceStore();
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
      { model: modelReturning(FIX), store },
    );
    expect(code).toBe(0);
    expect(store.list()).toHaveLength(1);
    const runId = store.list()[0];
    expect(runId).toBeDefined();
    if (runId === undefined) {
      return;
    }
    const raw = store.get(runId);
    expect(raw).toContain('"evidenceSchemaVersion": "1"');
    expect(raw).toContain('"taskType": "investigate-bug"');
  });

  it("suppresses evidence persistence with --no-evidence, mirroring keiko run's opt-out", async () => {
    const store: EvidenceStore = createInMemoryEvidenceStore();
    const cap = makeIo();
    const code = await runInvestigateCli(
      [
        "--description",
        "half is wrong",
        "--stack",
        "at half (src/buggy.ts:1:40)",
        "--dir-root",
        dir,
        "--no-evidence",
      ],
      cap.io,
      {},
      { model: modelReturning(FIX), store },
    );
    expect(code).toBe(0);
    expect(store.list()).toHaveLength(0);
  });

  it("fails closed and does not print the report when the evidence write fails", async () => {
    const failingStore: EvidenceStore = {
      put: (): never => {
        throw new Error("disk full");
      },
      get: (): undefined => undefined,
      list: (): readonly string[] => [],
      delete: (): void => undefined,
    };
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
      { model: modelReturning(FIX), store: failingStore },
    );
    expect(code).toBe(1);
    expect(cap.err()).toContain("failed to write evidence");
    expect(cap.out()).toBe("");
  });

  // `writeInvestigateEvidence`'s catch: the test above throws a plain `Error`, exercising the
  // `gateway.redact(String(error))` branch. A typed `AuditError` (as a real evidence store failure
  // would raise) takes the OTHER branch — its own already-redacted `.message`, unwrapped.
  it("reports the AuditError's own message when persisting evidence fails with a typed audit error", async () => {
    const failingStore: EvidenceStore = {
      put: (): never => {
        throw new EvidenceWriteError("evidence write failed");
      },
      get: (): undefined => undefined,
      list: (): readonly string[] => [],
      delete: (): void => undefined,
    };
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
      { model: modelReturning(FIX), store: failingStore },
    );
    expect(code).toBe(1);
    expect(cap.err()).toContain("failed to write evidence: evidence write failed");
    expect(cap.out()).toBe("");
  });

  // `terminalStatusFor`'s "cancelled" mapping: a model call that is cancelled mid-run resolves to a
  // report with status "cancelled" (the workflow's own top-level catch boundary maps a thrown
  // CancelledError to `cancelledReport`), and the persisted evidence's outcome must say so.
  it("records outcome 'cancelled' in evidence when the model call is cancelled mid-run", async () => {
    const store: EvidenceStore = createInMemoryEvidenceStore();
    const cancellingModel: ModelPort = {
      call: (): Promise<NormalizedResponse> =>
        Promise.reject(new CancelledError("test cancellation")),
    };
    const cap = makeIo();
    const code = await runInvestigateCli(
      ["--description", "half is wrong", "--dir-root", dir],
      cap.io,
      {},
      { model: cancellingModel, store },
    );
    expect(code).toBe(1);
    expect(store.list()).toHaveLength(1);
    const runId = store.list()[0];
    expect(runId).toBeDefined();
    if (runId === undefined) return;
    const raw = store.get(runId);
    expect(raw).toContain('"outcome": "cancelled"');
  });

  // `terminalStatusFor`'s "rejected" -> "failed" mapping: an out-of-scope patch is rejected by the
  // scope guard after retries (status "rejected"), which `terminalStatusFor` maps to the SAME
  // "failed" outcome a genuine IO failure would carry — both are non-completions from the
  // registry's point of view.
  it("records outcome 'failed' in evidence for a rejected (out-of-scope) investigation", async () => {
    const store: EvidenceStore = createInMemoryEvidenceStore();
    const cap = makeIo();
    const code = await runInvestigateCli(
      ["--description", "half is wrong", "--dir-root", dir],
      cap.io,
      {},
      { model: modelReturning(OUT_OF_SCOPE_FIX), store },
    );
    expect(code).toBe(1);
    expect(store.list()).toHaveLength(1);
    const runId = store.list()[0];
    expect(runId).toBeDefined();
    if (runId === undefined) return;
    const raw = store.get(runId);
    expect(raw).toContain('"outcome": "failed"');
  });
});

// ─── g-#3245-2: --evidence-dir (disclosed gap #2) ──────────────────────────────────────────────
//
// Deliberately does NOT inject deps.store (unlike the g23 block above) so the real
// createNodeEvidenceStore/resolveEvidenceDir path in investigate.ts actually runs end-to-end —
// mirrors run-evidence-dir.test.ts's discipline for `keiko run`. Every write targets an
// os-mkdtemp dir cleaned up in afterEach; nothing lands in the repository tree.
describe("runInvestigateCli --evidence-dir (disclosed gap #2)", () => {
  const evidenceDirs: string[] = [];
  function freshEvidenceDir(): string {
    const evDir = mkdtempSync(join(REAL_TMPDIR, "keiko-investigate-evdir-"));
    evidenceDirs.push(evDir);
    return evDir;
  }
  afterEach(() => {
    for (const evDir of evidenceDirs.splice(0)) {
      rmSync(evDir, { recursive: true, force: true });
    }
  });

  it("writes evidence under --evidence-dir when KEIKO_EVIDENCE_DIR is absent", async () => {
    const flagDir = freshEvidenceDir();
    const cap = makeIo();
    const code = await runInvestigateCli(
      [
        "--description",
        "half is wrong",
        "--stack",
        "at half (src/buggy.ts:1:40)",
        "--dir-root",
        dir,
        "--evidence-dir",
        flagDir,
      ],
      cap.io,
      {},
      { model: modelReturning(FIX) },
    );
    expect(code).toBe(0);
    expect(readdirSync(flagDir).some((n) => n.endsWith(".json"))).toBe(true);
  });

  it("lets --evidence-dir override $KEIKO_EVIDENCE_DIR, same precedence as keiko run", async () => {
    const envDir = freshEvidenceDir();
    const flagDir = freshEvidenceDir();
    const cap = makeIo();
    const code = await runInvestigateCli(
      [
        "--description",
        "half is wrong",
        "--stack",
        "at half (src/buggy.ts:1:40)",
        "--dir-root",
        dir,
        "--evidence-dir",
        flagDir,
      ],
      cap.io,
      { KEIKO_EVIDENCE_DIR: envDir },
      { model: modelReturning(FIX) },
    );
    expect(code).toBe(0);
    expect(readdirSync(flagDir).some((n) => n.endsWith(".json"))).toBe(true);
    expect(readdirSync(envDir)).toHaveLength(0);
  });

  it("prints the persisted evidence path in text mode, matching keiko run's UX", async () => {
    const flagDir = freshEvidenceDir();
    const cap = makeIo();
    const code = await runInvestigateCli(
      [
        "--description",
        "half is wrong",
        "--stack",
        "at half (src/buggy.ts:1:40)",
        "--dir-root",
        dir,
        "--evidence-dir",
        flagDir,
      ],
      cap.io,
      {},
      { model: modelReturning(FIX) },
    );
    expect(code).toBe(0);
    expect(cap.out()).toContain(`Evidence: ${flagDir}`);
  });

  it("includes evidencePath as a field in --json mode, without breaking the single-object contract", async () => {
    const flagDir = freshEvidenceDir();
    const cap = makeIo();
    const code = await runInvestigateCli(
      [
        "--description",
        "half is wrong",
        "--stack",
        "at half (src/buggy.ts:1:40)",
        "--dir-root",
        dir,
        "--evidence-dir",
        flagDir,
        "--json",
      ],
      cap.io,
      {},
      { model: modelReturning(FIX) },
    );
    expect(code).toBe(0);
    const report = JSON.parse(cap.out()) as { readonly evidencePath: string };
    expect(report.evidencePath).toContain(flagDir);
  });

  it("prints nothing extra when --no-evidence is combined with --evidence-dir", async () => {
    const flagDir = freshEvidenceDir();
    const cap = makeIo();
    const code = await runInvestigateCli(
      [
        "--description",
        "half is wrong",
        "--stack",
        "at half (src/buggy.ts:1:40)",
        "--dir-root",
        dir,
        "--evidence-dir",
        flagDir,
        "--no-evidence",
      ],
      cap.io,
      {},
      { model: modelReturning(FIX) },
    );
    expect(code).toBe(0);
    expect(cap.out()).not.toContain("Evidence:");
    expect(readdirSync(flagDir)).toHaveLength(0);
  });
});
