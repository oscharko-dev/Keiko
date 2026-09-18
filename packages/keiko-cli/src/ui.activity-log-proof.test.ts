// Activity Log proofs for `process.heartbeat`, `process.started` and
// `update.runtime.legacy-import-deferred` (#3532 proof backlog, partition p4-cli).
// `startProcessHeartbeat` is exported and driven directly with fake timers, exactly as
// `ui.test.ts` (read, not edited here) already does for its own non-proof assertions. `process.started`
// and the legacy-import-deferred warning are driven through the real `runUiCli` entry point with its
// documented `activityLog` sink seam and a fake `createServer`, so neither the real file sink nor
// the real HTTP/server module graph is ever loaded.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerLogEvent, ServerLogSink } from "@oscharko-dev/keiko-server";
import { DEFAULT_UI_PORT, UI_HOST } from "@oscharko-dev/keiko-contracts/runtime/bff-wire";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { runUiCli, startProcessHeartbeat, type UiCliDeps } from "./ui.js";
import type { CliIo } from "./runner.js";

const REAL_TMPDIR = realpathSync(tmpdir());
const tempRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function captureIo(): { readonly io: CliIo } {
  return { io: { out: (): void => undefined, err: (): void => undefined } };
}

interface RecordingSink extends ServerLogSink {
  readonly events: ServerLogEvent[];
}

function createRecordingSink(): RecordingSink {
  const events: ServerLogEvent[] = [];
  return { events, write: (event): void => void events.push(event) };
}

// A fake server that records its listen call without binding a real socket — the same minimal
// shape `ui.test.ts`'s own `fakeServer` uses.
function fakeServer(): Server {
  return {
    listen(_port: number, _host: string, cb: () => void): Server {
      cb();
      return this as unknown as Server;
    },
    once(): Server {
      return this as unknown as Server;
    },
  } as unknown as Server;
}

// The default (non-injected) update-startup-recovery reconciliation additionally calls
// `address()`/`removeListener()` once a `KEIKO_UI_LAUNCH_ID` is present, so a launch-id-bearing run
// needs the richer fake server `ui.test.ts` uses for the same scenario.
function fakeServerWithAddress(port: number): Server {
  return {
    once(): Server {
      return this as unknown as Server;
    },
    removeListener(): Server {
      return this as unknown as Server;
    },
    listen(_port: number, _host: string, callback: () => void): Server {
      callback();
      return this as unknown as Server;
    },
    address: () => ({ address: UI_HOST, family: "IPv4", port }),
  } as unknown as Server;
}

async function makeStaticRoot(): Promise<string> {
  const root = await mkdtemp(join(REAL_TMPDIR, "keiko-ui-proof-static-"));
  tempRoots.push(root);
  await writeFile(join(root, "index.html"), "<html></html>", "utf8");
  return root;
}

describe("ui.ts activity log proofs", () => {
  describe("process.heartbeat", () => {
    it("persists process.heartbeat with resource and event-loop evidence", () => {
      vi.useFakeTimers();
      const sink = createRecordingSink();
      const stop = startProcessHeartbeat(sink, 1_000);
      try {
        vi.advanceTimersByTime(1_000);
      } finally {
        stop();
      }
      const heartbeat = sink.events.find((event) => event.op === "process.heartbeat");
      const line = formatActivityLogProofLine(heartbeat ?? {});

      const resources = expectActivityLogProof("process.heartbeat.resources", line);
      expect(typeof resources.rssBytes).toBe("number");
      expect(typeof resources.heapUsedBytes).toBe("number");
      expect(typeof resources.heapTotalBytes).toBe("number");
      expect(typeof resources.externalBytes).toBe("number");

      const eventLoop = expectActivityLogProof("process.heartbeat.event-loop", line);
      expect(typeof eventLoop.eventLoopDelayP99Ms).toBe("number");
    });
  });

  describe("process.started", () => {
    it("persists process.started with the runtime and configuration evidence", async () => {
      const { io } = captureIo();
      const staticRoot = await makeStaticRoot();
      const sink = createRecordingSink();
      const deps: UiCliDeps = {
        staticRoot,
        hashesFile: join(staticRoot, "csp-hashes.json"),
        cwd: staticRoot,
        activityLog: sink,
        createServer: () => fakeServer(),
      };

      const code = await runUiCli([], io, { KEIKO_LOG_LEVEL: "debug" }, deps);

      expect(code).toBe(0);
      const started = sink.events.find((event) => event.op === "process.started");
      const line = formatActivityLogProofLine(started ?? {});

      const runtimeRecord = expectActivityLogProof("process.started.runtime", line);
      expect(runtimeRecord).toMatchObject({
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
      });
      expect(typeof runtimeRecord.productVersion).toBe("string");

      const configurationRecord = expectActivityLogProof("process.started.configuration", line);
      expect(configurationRecord).toMatchObject({
        host: UI_HOST,
        port: DEFAULT_UI_PORT,
        stateDirSource: "default",
        logLevel: "debug",
      });
    });
  });

  describe("update.runtime.legacy-import-deferred", () => {
    it("persists the deferred reason without disclosing source data or stopping startup", async () => {
      const { io } = captureIo();
      const staticRoot = await makeStaticRoot();
      const sink = createRecordingSink();
      const deps: UiCliDeps = {
        staticRoot,
        hashesFile: join(staticRoot, "csp-hashes.json"),
        cwd: staticRoot,
        activityLog: sink,
        importLegacyUpdateAuditSnapshot: () =>
          Promise.resolve({ status: "deferred" as const, reason: "append-failed" as const }),
        createServer: () => fakeServerWithAddress(4399),
      };

      const code = await runUiCli(
        ["--port", "4399"],
        io,
        { KEIKO_UI_LAUNCH_ID: "a".repeat(32) },
        deps,
      );

      expect(code).toBe(0);
      const deferred = sink.events.find(
        (event) => event.op === "update.runtime.legacy-import-deferred",
      );
      const line = formatActivityLogProofLine(deferred ?? {});
      const record = expectActivityLogProof("update.runtime.legacy-import-deferred.reason", line);
      expect(record).toMatchObject({
        reason: "append-failed",
        errorKind: "unavailable",
        level: "warn",
      });
      expect(sink.events.some((event) => event.op === "process.started")).toBe(true);
    });
  });
});
