// Wave 6 (epic #3233 closeout, w6-log-analyze-full): end-to-end coverage for the FULL
// `LogTimeline`/`OpCluster`/`ReproductionSeed`/`warnings` surface `support-analyze.ts` gained on
// top of Wave 1's minimal analyzer. The gateway-replay scenario below drives the REAL
// `Gateway`/`resilience.ts`/`openai-adapter.ts` machinery (via `createScriptedGatewayFetch`,
// ADR-0173 §7.3) rather than hand-authoring the expected `gateway.retry.*`/`gateway.chat.*` log
// shape — the exact same fixture-derivation discipline `replay.test.ts` itself uses (AGENTS.md
// §7: "a fixture never restates a formula the code under test owns").
//
// `--clusters`/`--seed`/`--emit-fixture` are not wired to `support.ts`'s argv parser in this item
// (out of this item's file scope, see support-analyze.ts's header) — these tests call the
// exported pure functions directly, the same seam a CLI layer would call through.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createScriptedGatewayClock,
  createScriptedGatewayFetch,
  Gateway,
  type GatewayCallRequest,
  type GatewayConfig,
  type GatewayRequest,
  type ModelProviderConfig,
} from "@oscharko-dev/keiko-model-gateway";

import {
  buildReproductionSeed,
  renderGatewayReplayScriptFixture,
  type GatewayReplayScript,
} from "./support-analyze.js";

// ─── Shared fixture plumbing ────────────────────────────────────────────────────────────────────

function provider(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    modelId: "example-chat-model",
    baseUrl: "https://provider.example/v1",
    apiKey: ["sk-", "log-analyze-secret-key-1234567890ab"].join(""),
    timeoutMs: 30_000,
    maxRetries: 1,
    retryBaseDelayMs: 1,
    ...overrides,
  };
}

function gatewayConfig(providers: ModelProviderConfig[]): GatewayConfig {
  return {
    providers,
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1000, halfOpenProbes: 1 },
  };
}

const REQUEST: GatewayRequest = {
  modelId: "example-chat-model",
  messages: [{ role: "user", content: "hello" }],
};

// Structurally matches `ModelGatewayLogEvent` (keiko-model-gateway/observability.ts, not publicly
// exported) — a recorder double only needs to be write-compatible with `GatewayDeps.log`, not
// import a type this package does not re-export.
interface CapturedEvent {
  readonly level?: string | undefined;
  readonly category: string;
  readonly op: string;
  readonly correlationId?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly status?: number | undefined;
  readonly errorKind?: string | undefined;
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
}

// Flattens a captured gateway event into an envelope-v2 server-log JSON line — mirrors
// `formatServerLogLine`'s documented flattening (support-analyze.ts's own header), NOT a formula
// this analyzer owns: the identity (pid/instanceId/seq/ts) is synthetic test data, not something
// derived from production code. One counter per call keeps every test's fixture hermetic
// (AGENTS.md §7: no shared mutable state across tests).
function makeEnvelopeLineBuilder(
  pid: number,
  instanceId: string,
): (event: CapturedEvent, ts: string) => string {
  let seq = 0;
  return (event, ts) => {
    seq += 1;
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
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      ...(event.status === undefined ? {} : { status: event.status }),
      ...(event.errorKind === undefined ? {} : { errorKind: event.errorKind }),
      ...(event.extra ?? {}),
    });
  };
}

function tsAt(index: number): string {
  return new Date(Date.parse("2026-08-21T00:00:00.000Z") + index * 1000).toISOString();
}

// Narrows an `expect(value).toBeDefined()` check into a non-undefined return, so the rest of a
// test can read fields with plain `.` access instead of a chain of `?.` — kept ESLint's
// `complexity` rule under the repository's ceiling (each `?.` counts as its own branch) without
// weakening any assertion: the `toBeDefined()` still runs and still fails the test first.
function assertDefined<T>(value: T | undefined, label: string): T {
  expect(value, `expected ${label} to be defined`).toBeDefined();
  if (value === undefined) throw new Error(`unreachable: ${label} was undefined`);
  return value;
}

// ─── Required test 1: forced failure-then-retry-then-success, gatewayScript reconstruction ─────

describe("buildReproductionSeed — real Gateway replay (ADR-0173 §7.3)", () => {
  it("reconstructs a 2-attempt gatewayScript: first attempt's httpStatus, second's finishReason/usage", async () => {
    const sharedClock = createScriptedGatewayClock();
    const fetchImpl = createScriptedGatewayFetch(
      [
        { status: 503, bodyJson: { error: { message: "upstream overloaded" } }, latencyMs: 0 },
        {
          status: 200,
          bodyJson: {
            choices: [
              { message: { role: "assistant", content: "recovered" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 7, completion_tokens: 3 },
          },
          latencyMs: 0,
        },
      ],
      sharedClock,
    );
    const events: CapturedEvent[] = [];
    const gateway = new Gateway(gatewayConfig([provider({ maxRetries: 1, retryBaseDelayMs: 1 })]), {
      clock: sharedClock,
      fetchImpl,
      log: { write: (event: CapturedEvent): void => void events.push(event) },
      random: (): number => 0.5,
    });
    const correlationId = "seed-correlation-1";
    const request: GatewayCallRequest = { ...REQUEST, logContext: { correlationId } };

    const result = await gateway.chat(request);
    expect(result.content).toBe("recovered");

    const buildLine = makeEnvelopeLineBuilder(4242, "aaaaaaaa");
    const text = `${events.map((event, index) => buildLine(event, tsAt(index))).join("\n")}\n`;

    const seed = assertDefined(
      buildReproductionSeed(text, correlationId, new Date("2026-08-21T00:10:00.000Z")),
      "seed",
    );
    expect(seed.correlationId).toBe(correlationId);
    const script = assertDefined(seed.gatewayScript, "gatewayScript");
    expect(script.attempts).toHaveLength(2);
    const [firstAttempt, secondAttempt] = script.attempts;
    const first = assertDefined(firstAttempt, "attempts[0]");
    const second = assertDefined(secondAttempt, "attempts[1]");
    expect(first.httpStatus).toBe(503);
    expect(first.outcome).toBe("provider-error");
    expect(second.finishReason).toBe("stop");
    expect(second.usage).toEqual({ promptTokens: 7, completionTokens: 3 });
    expect(second.outcome).toBe("success");
  });

  it("classifies a rate-limited attempt's outcome and carries retryAfterMs", async () => {
    const sharedClock = createScriptedGatewayClock();
    const fetchImpl = createScriptedGatewayFetch(
      [
        {
          status: 429,
          headers: { "retry-after": "2" },
          bodyJson: { error: { message: "slow down" } },
          latencyMs: 0,
        },
        {
          status: 200,
          bodyJson: {
            choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 2, completion_tokens: 1 },
          },
          latencyMs: 0,
        },
      ],
      sharedClock,
    );
    const events: CapturedEvent[] = [];
    const gateway = new Gateway(gatewayConfig([provider({ maxRetries: 1, retryBaseDelayMs: 1 })]), {
      clock: sharedClock,
      fetchImpl,
      log: { write: (event: CapturedEvent): void => void events.push(event) },
      random: (): number => 0.5,
    });
    const correlationId = "seed-correlation-rate-limit";
    await gateway.chat({ ...REQUEST, logContext: { correlationId } });

    const buildLine = makeEnvelopeLineBuilder(1, "bbbbbbbb");
    const text = `${events.map((event, index) => buildLine(event, tsAt(index))).join("\n")}\n`;
    const seed = assertDefined(
      buildReproductionSeed(text, correlationId, new Date("2026-08-21T00:10:00.000Z")),
      "seed",
    );
    const script = assertDefined(seed.gatewayScript, "gatewayScript");
    const first = assertDefined(script.attempts[0], "attempts[0]");
    expect(first.outcome).toBe("rate-limit");
    expect(first.httpStatus).toBe(429);
    expect(first.retryAfterMs).toBe(2000);
  });
});

// ─── Required test 2: missing-frames warning is explicit, never a silently empty array ─────────

describe("buildReproductionSeed — warnings name what could not be reconstructed", () => {
  it("names the missing-frames case for an artifact that predates Wave 2's frame capture", () => {
    const raw = JSON.stringify({
      ts: "2026-08-21T00:00:00.000Z",
      pid: 1,
      instanceId: "cccccccc",
      seq: 1,
      schemaVersion: 2,
      category: "http",
      op: "request",
      correlationId: "pre-wave2-correlation",
    });

    const seed = assertDefined(
      buildReproductionSeed(
        `${raw}\n`,
        "pre-wave2-correlation",
        new Date("2026-08-21T00:10:00.000Z"),
      ),
      "seed",
    );
    expect(seed.stackFrames).toBeUndefined();
    expect(seed.warnings).toContain(
      "no frames recorded for this correlationId — either no error occurred on this call, or " +
        "this artifact predates Wave 2's frame capture",
    );
  });

  it("names the missing-gateway-lines case, and the always-true no-body-logged disclaimer", () => {
    const raw = JSON.stringify({
      ts: "2026-08-21T00:00:00.000Z",
      pid: 1,
      instanceId: "dddddddd",
      seq: 1,
      schemaVersion: 2,
      category: "http",
      op: "request",
      correlationId: "no-gateway-correlation",
    });

    const seed = assertDefined(
      buildReproductionSeed(
        `${raw}\n`,
        "no-gateway-correlation",
        new Date("2026-08-21T00:10:00.000Z"),
      ),
      "seed",
    );
    expect(seed.gatewayScript).toBeUndefined();
    expect(seed.warnings).toContain(
      "no gateway.chat.*/gateway.stream.*/gateway.retry.* lines found for this correlationId — " +
        "either no gateway call occurred, or this artifact predates Wave 3's provider detail",
    );
    expect(seed.warnings).toContain(
      "no prompt/response body was ever logged by design — content-shape only " +
        "(counts, ids, and closed-vocabulary labels, never message/completion text)",
    );
  });

  it("returns undefined for a correlationId with no timeline, mirroring findTimeline", () => {
    const seed = buildReproductionSeed("", "does-not-exist", new Date("2026-08-21T00:10:00.000Z"));
    expect(seed).toBeUndefined();
  });
});

// ─── httpRequest / indexingJob / storeFingerprint reconstruction ───────────────────────────────

describe("buildReproductionSeed — httpRequest, indexingJob, storeFingerprint", () => {
  it("reads the httpRequest seed off the timeline's http/request and sse.stream.closed lines", () => {
    const requestLine = JSON.stringify({
      ts: "2026-08-21T00:00:00.000Z",
      pid: 1,
      instanceId: "eeeeeeee",
      seq: 1,
      schemaVersion: 2,
      category: "http",
      op: "request",
      correlationId: "req-http",
      status: 200,
      durationMs: 42,
      method: "POST",
      routeTemplate: "/api/chat",
      queryParamNames: ["stream"],
      responseBytes: 512,
      aborted: false,
    });
    const sseLine = JSON.stringify({
      ts: "2026-08-21T00:00:01.000Z",
      pid: 1,
      instanceId: "eeeeeeee",
      seq: 2,
      schemaVersion: 2,
      category: "http",
      op: "sse.stream.closed",
      correlationId: "req-http",
      frameCount: 9,
    });

    const seed = assertDefined(
      buildReproductionSeed(
        `${requestLine}\n${sseLine}\n`,
        "req-http",
        new Date("2026-08-21T00:10:00.000Z"),
      ),
      "seed",
    );

    expect(seed.httpRequest).toEqual({
      method: "POST",
      routeTemplate: "/api/chat",
      queryParamNames: ["stream"],
      responseBytes: 512,
      status: 200,
      durationMs: 42,
      aborted: false,
      frameCount: 9,
    });
  });

  it("reads the indexingJob seed off the timeline's indexing.job.started line", () => {
    const indexLine = JSON.stringify({
      ts: "2026-08-21T00:00:00.000Z",
      pid: 1,
      instanceId: "ffffffff",
      seq: 1,
      schemaVersion: 2,
      category: "indexing",
      op: "indexing.job.started",
      correlationId: "job-1",
      sourceCount: 12,
      batchSize: 4,
      concurrency: 2,
      minChunkTokens: 128,
      maxChunkTokens: 512,
      overlapTokens: 32,
      tokenizerKind: "qwen3",
    });

    const seed = assertDefined(
      buildReproductionSeed(`${indexLine}\n`, "job-1", new Date("2026-08-21T00:10:00.000Z")),
      "seed",
    );

    expect(seed.indexingJob).toEqual({
      sourceCount: 12,
      batchSize: 4,
      concurrency: 2,
      minChunkTokens: 128,
      maxChunkTokens: 512,
      overlapTokens: 32,
      tokenizerKind: "qwen3",
    });
  });

  it("reads storeFingerprint off a bundle's manifest line, and warns when a raw log has none", () => {
    const fingerprint = {
      store: "ui" as const,
      schemaVersion: 3,
      migrationsApplied: ["0001-initial"],
      tableRowCounts: { conversations: 10 },
      quickCheckOk: true,
      encryptionMode: "plaintext" as const,
    };
    const manifest = JSON.stringify({
      $section: "manifest",
      schemaVersion: 2,
      storeFingerprints: [fingerprint],
    });
    const logLine = JSON.stringify({
      ts: "2026-08-21T00:00:00.000Z",
      pid: 1,
      instanceId: "11111111",
      seq: 1,
      schemaVersion: 2,
      category: "http",
      op: "request",
      correlationId: "bundle-req",
    });

    const bundleSeed = assertDefined(
      buildReproductionSeed(
        `${manifest}\n${logLine}\n`,
        "bundle-req",
        new Date("2026-08-21T00:10:00.000Z"),
      ),
      "bundleSeed",
    );
    expect(bundleSeed.storeFingerprint).toEqual([fingerprint]);
    expect(bundleSeed.sourceArtifact.kind).toBe("bundle");

    const rawSeed = assertDefined(
      buildReproductionSeed(`${logLine}\n`, "bundle-req", new Date("2026-08-21T00:10:00.000Z")),
      "rawSeed",
    );
    expect(rawSeed.storeFingerprint).toBeUndefined();
    expect(rawSeed.warnings).toContain(
      "a raw server.log carries no store fingerprints — export a support bundle " +
        "(`keiko support export`) to include them",
    );
  });

  it("stamps sourceArtifact with a stable sha256 of the exact bytes analyzed", () => {
    const logLine = JSON.stringify({
      ts: "2026-08-21T00:00:00.000Z",
      pid: 1,
      instanceId: "22222222",
      seq: 1,
      schemaVersion: 2,
      category: "http",
      op: "request",
      correlationId: "hash-req",
    });
    const text = `${logLine}\n`;

    const first = assertDefined(
      buildReproductionSeed(text, "hash-req", new Date("2026-08-21T00:10:00.000Z")),
      "first",
    );
    const second = assertDefined(
      buildReproductionSeed(text, "hash-req", new Date("2026-08-21T00:20:00.000Z")),
      "second",
    );

    expect(first.sourceArtifact.sha256).toBe(second.sourceArtifact.sha256);
    expect(first.sourceArtifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.sourceArtifact.lineCount).toBe(1);
  });
});

// ─── Required test 3: --emit-fixture produces valid, parseable TypeScript ──────────────────────

function isValidReplayScriptEntryShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.networkError === true) return true;
  return (
    typeof record.status === "number" &&
    "bodyJson" in record &&
    typeof record.latencyMs === "number"
  );
}

describe("renderGatewayReplayScriptFixture — --emit-fixture", () => {
  it("writes a file whose exported literal is valid, parseable data matching GatewayReplayScriptEntry[]'s shape", () => {
    const script: GatewayReplayScript = {
      modelId: "example-chat-model",
      attempts: [
        { outcome: "provider-error", httpStatus: 503, durationMs: 5 },
        {
          outcome: "success",
          durationMs: 12,
          finishReason: "stop",
          usage: { promptTokens: 7, completionTokens: 3 },
        },
        { outcome: "transport-error", durationMs: 3 },
      ],
    };

    const rendered = renderGatewayReplayScriptFixture(script);
    expect(rendered).toBeDefined();

    const dir = mkdtempSync(join(tmpdir(), "keiko-log-analyze-fixture-"));
    try {
      const filePath = join(dir, "gateway-replay.fixture.ts");
      writeFileSync(filePath, rendered ?? "", "utf8");
      const written = readFileSync(filePath, "utf8");

      expect(written).toContain(
        'import type { GatewayReplayScriptEntry } from "@oscharko-dev/keiko-model-gateway";',
      );
      expect(written).toContain("export const gatewayReplayScript: GatewayReplayScriptEntry[] =");

      const match =
        /export const gatewayReplayScript: GatewayReplayScriptEntry\[\] = (\[[\s\S]*\]);\n$/.exec(
          written,
        );
      expect(match).not.toBeNull();
      const entries: unknown = JSON.parse(match?.[1] ?? "");
      expect(Array.isArray(entries)).toBe(true);
      const entryArray = entries as unknown[];
      expect(entryArray).toHaveLength(3);
      expect(entryArray.every(isValidReplayScriptEntryShape)).toBe(true);
      expect(entryArray[2]).toEqual({ networkError: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined (never an empty-array fixture) for a script with zero attempts", () => {
    expect(renderGatewayReplayScriptFixture({ modelId: "m", attempts: [] })).toBeUndefined();
  });
});
