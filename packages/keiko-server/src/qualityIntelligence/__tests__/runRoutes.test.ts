import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { UiHandlerDeps } from "../../deps.js";
import { buildRedactor, createInMemoryUiStore, createRunRegistry, STREAMING } from "../../index.js";
import type { RouteContext, RouteResult } from "../../routes.js";
import { handleStartQiRun } from "../runRoutes.js";

function emptyStore(): EvidenceStore {
  return { put: () => "", list: () => [], get: () => undefined, delete: () => undefined };
}

function deps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: emptyStore(),
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
  };
}

function makeReq(body: Record<string, unknown>): IncomingMessage {
  return Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as unknown as IncomingMessage;
}

class MockResponse extends EventEmitter {
  public statusCode: number | undefined;
  public headers: Record<string, string> | undefined;
  public chunks: string[] = [];
  public ended = false;

  writeHead(statusCode: number, headers: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(): this {
    this.ended = true;
    return this;
  }
}

function ctx(req: IncomingMessage, res: MockResponse): RouteContext {
  return {
    req,
    res: res as unknown as ServerResponse,
    params: {},
    url: new URL("http://127.0.0.1/api/quality-intelligence/runs"),
  };
}

function asResult(outcome: RouteResult | typeof STREAMING): RouteResult {
  if (outcome === STREAMING) throw new Error("expected RouteResult, got STREAMING");
  return outcome;
}

describe("handleStartQiRun — single-file absolute-path validation", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns 400 QI_BAD_SOURCE before streaming for a relative file source path", async () => {
    const res = new MockResponse();
    const result = asResult(
      await handleStartQiRun(
        ctx(
          makeReq({
            sources: [{ kind: "file", label: "Relative", path: "docs/spec.md" }],
          }),
          res,
        ),
        deps(),
      ),
    );

    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string; message: string } }).error).toMatchObject({
      code: "QI_BAD_SOURCE",
    });
    expect(
      (result.body as { error: { code: string; message: string } }).error.message,
    ).toMatch(/absolute local paths/i);
    expect(res.statusCode).toBeUndefined();
    expect(res.chunks).toHaveLength(0);
  });

  it("keeps an absolute file source on the SSE path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qi-start-route-"));
    tmpDirs.push(dir);
    const path = join(dir, "spec.md");
    writeFileSync(path, "# Spec\nThe system shall generate cases.\n", "utf8");
    const res = new MockResponse();

    const outcome = await handleStartQiRun(
      ctx(
        makeReq({
          sources: [{ kind: "file", label: "Absolute", path }],
        }),
        res,
      ),
      deps(),
    );

    expect(outcome).toBe(STREAMING);
    expect(res.statusCode).toBe(200);
    expect(res.headers?.["Content-Type"]).toContain("text/event-stream");
    expect(res.ended).toBe(true);
    expect(res.chunks.join("")).toContain('"type":"error"');
  });
});
