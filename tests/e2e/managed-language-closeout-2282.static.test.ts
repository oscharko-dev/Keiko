import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const FIXTURE = join(process.cwd(), "tests/e2e/support/managed-lsp-closeout-server.mjs");

function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${String(body.length)}\r\n\r\n`, "ascii"),
    body,
  ]);
}

type FrameParseResult = { readonly ok: false } | { readonly ok: true; readonly value: unknown };

function responseFrom(buffer: Buffer): FrameParseResult {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) return { ok: false };
  const match = /Content-Length:\s*(\d+)/iu.exec(buffer.subarray(0, headerEnd).toString("ascii"));
  if (match === null) throw new Error("Fixture returned a malformed LSP frame header.");
  const bodyStart = headerEnd + 4;
  const length = Number.parseInt(match[1] ?? "", 10);
  if (buffer.length < bodyStart + length) return { ok: false };
  return {
    ok: true,
    value: JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString("utf8")),
  };
}

function readResponse(child: ChildProcessWithoutNullStreams): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = (): void => {
      child.stdout.off("data", onData);
      child.off("error", onError);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const response = responseFrom(buffer);
      if (!response.ok) return;
      cleanup();
      resolve(response.value);
    };
    child.stdout.on("data", onData);
    child.on("error", onError);
  });
}

async function exchange(child: ChildProcessWithoutNullStreams, message: unknown): Promise<unknown> {
  const response = readResponse(child);
  child.stdin.write(frame(message));
  return response;
}

describe("managed-language browser closeout source contract (#2282)", () => {
  it("uses real routes and retains axe, visual, rollback, and no-fallback assertions", () => {
    const spec = readFileSync("tests/e2e/managed-language-closeout-2282.spec.ts", "utf8");
    expect(spec).not.toContain("page.route(");
    expect(spec).toContain("/api/editor/lsp/settings");
    expect(spec).toContain("/api/editor/language/capabilities");
    expect(spec).toContain("/api/editor/language/semantic-tokens");
    expect(spec).toContain('"rollback"');
    expect(spec).toContain("runAxe");
    expect(spec).toContain("managed-language-closeout-active.png");
    expect(spec).toContain('code: "UNSUPPORTED_LANGUAGE"');
  });

  it("negotiates and executes over the real stdio fixture", async () => {
    const child = spawn(process.execPath, [FIXTURE], { stdio: "pipe" });
    const initialized = await exchange(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    expect(initialized).toMatchObject({
      id: 1,
      result: { capabilities: { diagnosticProvider: true, definitionProvider: true } },
    });
    const diagnostics = await exchange(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "textDocument/diagnostic",
      params: { textDocument: { uri: "file:///workspace/main.py" } },
    });
    expect(diagnostics).toMatchObject({
      id: 2,
      result: { kind: "full", items: [{ code: "M6-2282" }] },
    });
    await exchange(child, { jsonrpc: "2.0", id: 3, method: "shutdown", params: null });
    child.stdin.write(frame({ jsonrpc: "2.0", method: "exit", params: null }));
    await once(child, "exit");
  });
});
