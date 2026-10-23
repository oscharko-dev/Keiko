import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  prepareCodingPerformanceReadiness,
  readCodingPerformanceFirstEvent,
  startCodingPerformanceProvider,
} from "../coding-runtime-performance-harness.mjs";
import { buildUiHandlerDeps } from "../../packages/keiko-server/src/deps.ts";
import { awaitInitializedConversationReadiness } from "../../packages/keiko-server/src/gateway-readiness.ts";
import { admitCodingRunModel } from "../../packages/keiko-server/src/coding-sidecar-gateway.ts";
import { functionalGatewayConfig } from "../../packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.functional/_support.ts";

async function withReadinessProvider(status, verify) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-perf-readiness-")));
  const provider = await startCodingPerformanceProvider(functionalGatewayConfig(), status);
  let deps;
  try {
    mkdirSync(join(root, "ui-db"));
    writeFileSync(join(root, "ui-db", "keiko.config.json"), JSON.stringify(provider.config));
    deps = buildUiHandlerDeps({
      configPath: undefined,
      env: { KEIKO_STATE_DIR: join(root, "state") },
      uiDbPath: join(root, "ui-db", "keiko-ui.db"),
      evidenceDir: join(root, "evidence"),
    });
    await verify(deps, provider);
  } finally {
    try {
      await deps?.dispose?.();
    } finally {
      await provider.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
}

function reader(parts) {
  return {
    read: async () => {
      const part = parts.shift();
      return part === undefined ? { done: true } : { done: false, value: Buffer.from(part) };
    },
  };
}

function event() {
  return {
    schemaVersion: "1",
    kind: "status",
    runId: "run-perf",
    cursor: "cursor-perf",
    occurredAt: "2026-09-04T00:00:00.000Z",
    sequence: 1,
    state: "running",
    revision: 1,
  };
}

describe("native coding performance stream admission", () => {
  it("prepares startup readiness for the same holder that admits the measured run", async () => {
    await withReadinessProvider(200, async (deps, provider) => {
      expect(() =>
        admitCodingRunModel(
          deps.gatewayConfig.current(),
          "functional-model",
          undefined,
          deps.gatewayConfig,
        ),
      ).toThrow(
        expect.objectContaining({
          name: "CodingRuntimeLaunchRejectedError",
          failureCode: "model-unavailable",
          retryable: false,
          reason: expect.stringMatching(/^(?:model-verification-pending|conversation-not-ready)$/u),
        }),
      );
      await expect(
        prepareCodingPerformanceReadiness(deps, {
          awaitInitializedConversationReadiness,
          admitCodingRunModel,
        }),
      ).resolves.toMatchObject({ profileId: "functional-model" });
      expect(provider.requests()).toBeGreaterThan(0);
      expect(
        deps.gatewayConfig.verifiedCapability("functional-model").fields.conversationReady,
      ).toBe(true);
    });
  });

  it("refuses actual run admission when the fixture readiness provider answers 503", async () => {
    await withReadinessProvider(503, async (deps, provider) => {
      await expect(
        prepareCodingPerformanceReadiness(deps, {
          awaitInitializedConversationReadiness,
          admitCodingRunModel,
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          name: "CodingRuntimeLaunchRejectedError",
          failureCode: "model-unavailable",
          retryable: false,
          reason: "conversation-not-ready",
        }),
      );
      expect(provider.requests()).toBeGreaterThan(0);
      expect(
        deps.gatewayConfig.verifiedCapability("functional-model").fields.conversationReady,
      ).toBe(false);
    });
  });

  it("measures the first received byte while waiting for a complete valid frame", async () => {
    const frame = `event: status\ndata: ${JSON.stringify(event())}\n\n`;
    expect(
      await readCodingPerformanceFirstEvent(
        reader([frame.slice(0, 10), frame.slice(10)]),
        10,
        () => 15,
      ),
    ).toBe(5);
  });

  it.each([
    'event: reset\ndata: {"reason":"unknown-run"}\n\n',
    'event: status\ndata: {"prompt":"private"}\n\n',
    "event: status\ndata: malformed\n\n",
  ])("refuses an invalid or reset SSE stream", async (frame) => {
    await expect(readCodingPerformanceFirstEvent(reader([frame]), 10, () => 15)).rejects.toThrow();
  });

  it("refuses an empty or unbounded initial event", async () => {
    await expect(readCodingPerformanceFirstEvent(reader([]), 10, () => 15)).rejects.toThrow();
    await expect(
      readCodingPerformanceFirstEvent(reader(["x".repeat(65_537)]), 10, () => 15),
    ).rejects.toThrow();
  });
});
