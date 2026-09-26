// Registry-linked executable proof (#3532) for `request` (the per-HTTP-request close-time line).
//
// Kept out of `server.test.ts` (several concurrent streams edit that file) as a dedicated
// co-located file. Drives the real, exported `logRequestOnClose` — exported by `server.ts`
// specifically for this kind of direct unit coverage — against the real production file sink, then
// reads the persisted line back with `readPersistedActivityLog` (this task's rule 1).

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
import { closeFileServerLogSinks, createFileServerLogSink } from "./observability/server-log.js";
import { logRequestOnClose, type RequestLogContext } from "./server.js";

interface RequestDouble extends EventEmitter {
  complete: boolean;
  destroyed: boolean;
  url?: string;
  method?: string;
  socket: { bytesWritten: number };
}

interface ResponseDouble extends EventEmitter {
  closed: boolean;
  destroyed: boolean;
  writableEnded: boolean;
  headersSent: boolean;
  statusCode: number;
}

function doubles(): { readonly req: RequestDouble; readonly res: ResponseDouble } {
  const req = Object.assign(new EventEmitter(), {
    complete: false,
    destroyed: false,
    url: "/api/memory/abc123?foo=1&bar=2",
    method: "GET",
    socket: { bytesWritten: 0 },
  });
  const res = Object.assign(new EventEmitter(), {
    closed: false,
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    statusCode: 200,
  });
  return { req, res };
}

describe("request activity log proof (#3532)", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-server-request-proof-"));
  });

  afterEach(() => {
    closeFileServerLogSinks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("persists one request line on close through the real production file sink", () => {
    const { req, res } = doubles();
    const activityLog = createFileServerLogSink(stateDir, { level: "debug" });
    const context: RequestLogContext = {
      routeTemplate: "/api/memory/:id",
      queryParamNames: ["bar", "foo"],
    };

    logRequestOnClose(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      "corr-request-proof-01",
      activityLog,
      context,
    );
    req.socket.bytesWritten += 128;
    res.headersSent = true;
    res.writableEnded = true;
    res.emit("close");

    const [line] = persistedActivityLogLines(readPersistedActivityLog(stateDir), "request");
    const persisted = expectActivityLogProof("request.close-line", line ?? "");
    expect(persisted).toMatchObject({
      category: "http",
      correlationId: "corr-request-proof-01",
      status: 200,
      method: "GET",
      routeTemplate: "/api/memory/{id}",
      queryParamNames: ["bar", "foo"],
      responseBytes: 128,
      aborted: false,
    });
    expect(typeof persisted.durationMs).toBe("number");
  });
});
