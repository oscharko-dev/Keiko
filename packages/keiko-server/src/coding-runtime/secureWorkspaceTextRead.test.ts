import { describe, expect, it, vi } from "vitest";

import {
  createSecureWorkspaceTextReadPort,
  type SecureWorkspaceTextReadResult,
} from "./secureWorkspaceTextRead.js";
import type { SecureWorkspaceTextReadArtifact } from "./secureWorkspaceTextReadArtifact.js";
import type { SecureWorkspaceTextReadProcessFactory } from "./secureWorkspaceTextReadProcess.js";
import { decodeSecureWorkspaceReadRequest } from "./secureWorkspaceTextReadProtocol.js";

const MAX_TEXT_BYTES = 65_536;
const artifact: SecureWorkspaceTextReadArtifact = {
  target: "darwin-arm64",
  installRelativePath: "runtime/native/keiko-secure-workspace-read",
  sha256: "a".repeat(64),
  protocol: "KSR1/KSS1",
  sourceCommit: "b".repeat(40),
  sourceTreeSha256: "c".repeat(64),
  signed: true,
};

function response(status: number, payload = Buffer.alloc(0)): Buffer {
  const frame = Buffer.alloc(12 + payload.byteLength);
  frame.write("KSS1", 0, "ascii");
  frame.writeUInt16LE(1, 4);
  frame.writeUInt16LE(status, 6);
  frame.writeUInt32LE(payload.byteLength, 8);
  payload.copy(frame, 12);
  return frame;
}

function createPort(
  run: (request: {
    readonly stdin: Uint8Array;
    readonly signal: AbortSignal;
  }) => Promise<Uint8Array>,
  platform: { readonly os: string; readonly arch: string } = { os: "darwin", arch: "arm64" },
  resolveWorkspaceRoot: () => string | undefined | Promise<string | undefined> = () =>
    "/server-owned/workspace",
): {
  readonly port: ReturnType<typeof createSecureWorkspaceTextReadPort>;
  readonly verify: ReturnType<typeof vi.fn>;
  readonly create: ReturnType<typeof vi.fn>;
} {
  const verify = vi.fn(() => true);
  const create = vi.fn(() => ({ run }));
  const processFactory: SecureWorkspaceTextReadProcessFactory = { create };
  return {
    port: createSecureWorkspaceTextReadPort({
      resolveWorkspaceRoot,
      artifact,
      artifactVerifier: { verify },
      processFactory,
      platform,
    }),
    verify,
    create,
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve: (value): void => resolve?.(value) };
}

describe("SecureWorkspaceTextReadPort", () => {
  it("fails closed when no live workspace is bound without verification or spawn", async () => {
    const run = vi.fn(() => Promise.resolve(response(0, Buffer.from("text"))));
    const resolveWorkspaceRoot = vi.fn(() => undefined);
    const unavailable = createPort(run, { os: "darwin", arch: "arm64" }, resolveWorkspaceRoot);

    await expect(unavailable.port.readText({ relativePath: "src/a.ts" })).resolves.toEqual({
      ok: false,
      reason: "workspace-unavailable",
    });
    expect(resolveWorkspaceRoot).toHaveBeenCalledOnce();
    expect(unavailable.verify).not.toHaveBeenCalled();
    expect(unavailable.create).not.toHaveBeenCalled();
  });

  it("re-resolves the live workspace root for sequential reads", async () => {
    let root = "/workspace/one";
    const roots: string[] = [];
    const { port } = createPort(
      ({ stdin }) => {
        roots.push(decodeSecureWorkspaceReadRequest(stdin).root);
        return Promise.resolve(response(0, Buffer.from("ok")));
      },
      { os: "darwin", arch: "arm64" },
      () => root,
    );

    await expect(port.readText({ relativePath: "src/a.ts" })).resolves.toEqual({
      ok: true,
      text: "ok",
    });
    root = "/workspace/two";
    await expect(port.readText({ relativePath: "src/a.ts" })).resolves.toEqual({
      ok: true,
      text: "ok",
    });
    expect(roots).toEqual(["/workspace/one", "/workspace/two"]);
  });

  it("fails closed for Linux and unknown targets before artifact verification or helper spawn", async () => {
    const run = vi.fn(() => Promise.resolve(response(0, Buffer.from("text"))));
    const linux = createPort(run, { os: "linux", arch: "x64" });
    const unknown = createPort(run, { os: "plan9", arch: "amd64" });

    await expect(linux.port.readText({ relativePath: "src/a.ts" })).resolves.toEqual({
      ok: false,
      reason: "unsupported-platform",
    });
    await expect(unknown.port.readText({ relativePath: "src/a.ts" })).resolves.toEqual({
      ok: false,
      reason: "unsupported-platform",
    });
    expect(linux.verify).not.toHaveBeenCalled();
    expect(unknown.verify).not.toHaveBeenCalled();
    expect(linux.create).not.toHaveBeenCalled();
    expect(unknown.create).not.toHaveBeenCalled();
  });

  it("returns exactly 65,536 safe bytes and maps helper oversize status to a content-free denial", async () => {
    const exact = Buffer.alloc(MAX_TEXT_BYTES, 0x61);
    const exactPort = createPort(() => Promise.resolve(response(0, exact)));
    const oversizedPort = createPort(() => Promise.resolve(response(6)));

    await expect(exactPort.port.readText({ relativePath: "src/exact.ts" })).resolves.toEqual({
      ok: true,
      text: "a".repeat(MAX_TEXT_BYTES),
    });
    await expect(
      oversizedPort.port.readText({ relativePath: "src/too-large.ts" }),
    ).resolves.toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  it("permits only the relative path and signal to cross the public port boundary", async () => {
    let captured: { readonly stdin: Uint8Array; readonly signal: AbortSignal } | undefined;
    const { port, create } = createPort((request) => {
      captured = { stdin: Buffer.from(request.stdin), signal: request.signal };
      return Promise.resolve(response(0, Buffer.from("safe")));
    });

    await expect(port.readText({ relativePath: "src/safe.ts" })).resolves.toEqual({
      ok: true,
      text: "safe",
    });
    expect(create).toHaveBeenCalledExactlyOnceWith(artifact);
    if (captured === undefined) throw new Error("expected process request");
    expect(captured.stdin).toBeInstanceOf(Uint8Array);
    expect(captured.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(captured)).toEqual(["stdin", "signal"]);
  });

  it("maps cancellation, crashes, and malformed/trailing helper output to closed results", async () => {
    const cancelled = createPort(
      ({ signal }) =>
        new Promise<Uint8Array>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new Error("terminated"));
            },
            { once: true },
          );
          if (signal.aborted) reject(new Error("terminated"));
        }),
    );
    const controller = new AbortController();
    const cancelling = cancelled.port.readText({
      relativePath: "src/a.ts",
      signal: controller.signal,
    });
    controller.abort();
    await expect(cancelling).resolves.toEqual({ ok: false, reason: "cancelled" });

    const crash = createPort(() => Promise.reject(new Error("helper crashed")));
    await expect(crash.port.readText({ relativePath: "src/a.ts" })).resolves.toEqual({
      ok: false,
      reason: "process-failed",
    });

    const raw = Buffer.concat([response(0, Buffer.from("ok")), Buffer.from([0])]);
    const malformed = createPort(() => Promise.resolve(raw));
    await expect(malformed.port.readText({ relativePath: "src/a.ts" })).resolves.toEqual({
      ok: false,
      reason: "protocol-invalid",
    });
    expect(raw.every((byte) => byte === 0)).toBe(true);

    const truncated = Buffer.from("KSS1\x01", "binary");
    const truncatedPort = createPort(() => Promise.resolve(truncated));
    await expect(truncatedPort.port.readText({ relativePath: "src/a.ts" })).resolves.toEqual({
      ok: false,
      reason: "protocol-invalid",
    });
    expect(truncated.every((byte) => byte === 0)).toBe(true);
  });

  it("maps the fixed two-second helper deadline to timeout", async () => {
    vi.useFakeTimers();
    try {
      const timed = createPort(
        ({ signal }) =>
          new Promise<Uint8Array>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                reject(new Error("terminated"));
              },
              { once: true },
            );
            if (signal.aborted) reject(new Error("terminated"));
          }),
      );
      const reading = timed.port.readText({ relativePath: "src/a.ts" });

      await vi.advanceTimersByTimeAsync(2_000);
      await expect(reading).resolves.toEqual({ ok: false, reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid UTF-8 and binary/control payloads without retaining raw response bytes", async () => {
    const invalidUtf8 = Buffer.from([0xc3, 0x28]);
    const control = Buffer.from([0x61, 0x01]);
    const invalid = createPort(() => Promise.resolve(response(0, invalidUtf8)));
    const binary = createPort(() => Promise.resolve(response(0, control)));

    await expect(invalid.port.readText({ relativePath: "src/a.ts" })).resolves.toEqual({
      ok: false,
      reason: "not-text",
    });
    await expect(binary.port.readText({ relativePath: "src/a.ts" })).resolves.toEqual({
      ok: false,
      reason: "not-text",
    });
  });

  it("admits at most eight live helpers and returns busy immediately without a ninth process", async () => {
    const pending = Array.from({ length: 8 }, () => deferred<Uint8Array>());
    let next = 0;
    const { port, create } = createPort(() => {
      const current = pending[next];
      next += 1;
      if (current === undefined) throw new Error("unexpected queued helper");
      return current.promise;
    });
    const active = Array.from({ length: 8 }, (_, index) =>
      port.readText({ relativePath: `src/${String(index)}.ts` }),
    );

    await expect(port.readText({ relativePath: "src/ninth.ts" })).resolves.toEqual({
      ok: false,
      reason: "busy",
    });
    expect(create).toHaveBeenCalledTimes(8);
    for (const item of pending) item.resolve(response(0, Buffer.from("ok")));
    await expect(Promise.all(active)).resolves.toEqual(
      Array.from({ length: 8 }, (): SecureWorkspaceTextReadResult => ({ ok: true, text: "ok" })),
    );
  });
});
