import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSecureWorkspaceTextReadPort,
  type SecureWorkspaceTextReadResult,
} from "./secureWorkspaceTextRead.js";
import type { SecureWorkspaceTextReadArtifact } from "./secureWorkspaceTextReadArtifact.js";
import type { SecureWorkspaceTextReadProcessFactory } from "./secureWorkspaceTextReadProcess.js";
import {
  decodeSecureWorkspaceReadRequest,
  encodeSecureWorkspaceReadResponse,
  type SecureWorkspaceReadClosedStatus,
} from "./secureWorkspaceTextReadProtocol.js";

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

  it("denies UTF-8 path and workspace-root byte overflows before verification or spawn", async () => {
    const run = vi.fn(() => Promise.resolve(response(0, Buffer.from("text"))));
    const pathOverflow = createPort(run);
    const rootOverflow = createPort(run, { os: "darwin", arch: "arm64" }, () =>
      "/".concat("é".repeat(16_384)),
    );

    await expect(pathOverflow.port.readText({ relativePath: "é".repeat(2_049) })).resolves.toEqual({
      ok: false,
      reason: "denied",
    });
    await expect(rootOverflow.port.readText({ relativePath: "src/a.ts" })).resolves.toEqual({
      ok: false,
      reason: "workspace-unavailable",
    });
    expect(pathOverflow.verify).not.toHaveBeenCalled();
    expect(pathOverflow.create).not.toHaveBeenCalled();
    expect(rootOverflow.verify).not.toHaveBeenCalled();
    expect(rootOverflow.create).not.toHaveBeenCalled();
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

  it("fails closed for a mismatched Linux artifact and unknown targets before verification or spawn", async () => {
    const run = vi.fn(() => Promise.resolve(response(0, Buffer.from("text"))));
    const linux = createPort(run, { os: "linux", arch: "x64" });
    const unknown = createPort(run, { os: "plan9", arch: "amd64" });

    await expect(linux.port.readText({ relativePath: "src/a.ts" })).resolves.toEqual({
      ok: false,
      reason: "artifact-unverified",
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

  it("keeps a stalled helper bounded after allowing for process scheduling", async () => {
    const timeout = new AbortController();
    const timeoutSignal = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    try {
      const started = deferred<undefined>();
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
            started.resolve(undefined);
          }),
      );
      const reading = timed.port.readText({ relativePath: "src/a.ts" });

      await started.promise;
      timeout.abort();
      await expect(reading).resolves.toEqual({ ok: false, reason: "timeout" });
    } finally {
      timeoutSignal.mockRestore();
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

// F27 (#3876): the native helper answers `access-denied` for every path it cannot open -- a missing
// file, a link, a file used as a directory, an unreadable directory, an unusable root -- and has no
// `not-found` status (native/secure-workspace-read/secure_workspace_read.c). A file creation asks
// "is there nothing here yet?", so every creation through the replacement form was refused as
// `denied` and no live run ever created a file. The earlier stubs here never answered
// `access-denied` for a missing path, so the production shape of the answer was untested; these
// tests drive the real wrapper over a real workspace with the helper answering what it answers in
// production (checked against a helper compiled from that source).
describe("SecureWorkspaceTextReadPort absence decision (F27)", () => {
  const bases: string[] = [];

  afterEach(() => {
    for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  });

  function fixture(): { readonly base: string; readonly root: string; readonly outside: string } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-secure-read-")));
    bases.push(base);
    const root = join(base, "workspace");
    const outside = join(base, "outside");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    return { base, root, outside };
  }

  function directorySymlinkType(): "dir" | "junction" {
    return process.platform === "win32" ? "junction" : "dir";
  }

  // Encoded by the protocol module that owns the wire format, never restated here as a number.
  function helperRefuses(
    status: SecureWorkspaceReadClosedStatus = "access-denied",
  ): () => Promise<Uint8Array> {
    return () => Promise.resolve(encodeSecureWorkspaceReadResponse({ status }));
  }

  function portOver(
    root: string,
    run: () => Promise<Uint8Array> = helperRefuses(),
  ): ReturnType<typeof createPort> {
    return createPort(run, { os: "darwin", arch: "arm64" }, () => root);
  }

  it.each([
    ["a missing file in an existing directory", "src/cli.test.ts"],
    ["a missing file at the workspace root", "cli.test.ts"],
    ["a file below a missing directory", "src/new/nested/cli.test.ts"],
  ])("answers not-found for %s the helper could not open", async (_label, relativePath) => {
    const { root } = fixture();
    const { port, create } = portOver(root);

    await expect(port.readText({ relativePath })).resolves.toEqual({
      ok: false,
      reason: "not-found",
    });
    // The helper stays the first authority: it was asked, and its refusal was refined.
    expect(create).toHaveBeenCalledOnce();
  });

  it("keeps the helper's denial for a path that exists", async () => {
    const { root } = fixture();
    writeFileSync(join(root, "src", "present.ts"), "export {};\n");
    const { port } = portOver(root);

    await expect(port.readText({ relativePath: "src/present.ts" })).resolves.toEqual({
      ok: false,
      reason: "denied",
    });
  });

  it("keeps the helper's denial for a directory at the final component", async () => {
    const { root } = fixture();
    const { port } = portOver(root);

    await expect(port.readText({ relativePath: "src" })).resolves.toEqual({
      ok: false,
      reason: "denied",
    });
  });

  it("keeps the helper's denial below a file used as a directory", async () => {
    const { root } = fixture();
    writeFileSync(join(root, "src", "present.ts"), "export {};\n");
    const { port } = portOver(root);

    await expect(port.readText({ relativePath: "src/present.ts/nested.ts" })).resolves.toEqual({
      ok: false,
      reason: "denied",
    });
  });

  it("does not follow a symlinked directory out of the workspace", async () => {
    const { root, outside } = fixture();
    symlinkSync(outside, join(root, "link"), directorySymlinkType());
    writeFileSync(join(outside, "present.ts"), "export {};\n");
    const { port } = portOver(root);

    // A file beyond the link and one that is not there are the same answer: the wrapper never
    // looks past the link, so the link cannot be used to probe what exists outside the workspace.
    for (const relativePath of ["link/present.ts", "link/absent.ts", "link/deeper/absent.ts"]) {
      await expect(port.readText({ relativePath })).resolves.toEqual({
        ok: false,
        reason: "denied",
      });
    }
  });

  it.skipIf(process.platform === "win32")(
    "treats a dangling symlink at the final component as present",
    async () => {
      const { root, outside } = fixture();
      symlinkSync(join(outside, "gone.ts"), join(root, "src", "alias.ts"));
      const { port } = portOver(root);

      // `stat` and `exists` follow the link and call it absent; `lstat` sees the link itself.
      await expect(port.readText({ relativePath: "src/alias.ts" })).resolves.toEqual({
        ok: false,
        reason: "denied",
      });
    },
  );

  it("denies, and never answers not-found, when the root is not a real directory", async () => {
    const { base, root } = fixture();
    writeFileSync(join(base, "file-root"), "not a directory\n");
    symlinkSync(root, join(base, "link-root"), directorySymlinkType());

    for (const unusable of [join(base, "gone"), join(base, "file-root"), join(base, "link-root")]) {
      const { port } = portOver(unusable);
      await expect(port.readText({ relativePath: "src/new.ts" })).resolves.toEqual({
        ok: false,
        reason: "denied",
      });
    }
  });

  it.each([
    ["invalid-path", "denied"],
    ["malformed-request", "protocol-invalid"],
    ["unsupported-platform", "unsupported-platform"],
    ["not-regular", "not-text"],
    ["content-too-large", "too-large"],
    ["content-not-text", "not-text"],
    ["changed-during-read", "unstable"],
    ["io-failure", "process-failed"],
  ] as const)(
    "refines only access-denied: a missing path stays %s's own answer",
    async (status, reason) => {
      const { root } = fixture();
      const { port } = portOver(root, helperRefuses(status));

      await expect(port.readText({ relativePath: "src/new.ts" })).resolves.toEqual({
        ok: false,
        reason,
      });
    },
  );

  it("proves absence under the root that is live at each read, never a stale one", async () => {
    const first = fixture();
    const second = fixture();
    writeFileSync(join(first.root, "src", "shared.ts"), "export {};\n");
    let root = first.root;
    const { port } = createPort(helperRefuses(), { os: "darwin", arch: "arm64" }, () => root);

    await expect(port.readText({ relativePath: "src/shared.ts" })).resolves.toEqual({
      ok: false,
      reason: "denied",
    });
    root = second.root;
    await expect(port.readText({ relativePath: "src/shared.ts" })).resolves.toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  it("never manufactures not-found for a request that was aborted while the helper ran", async () => {
    const { root } = fixture();
    const controller = new AbortController();
    const refuse = helperRefuses();
    const { port } = portOver(root, () => {
      controller.abort();
      return refuse();
    });

    await expect(
      port.readText({ relativePath: "src/new.ts", signal: controller.signal }),
    ).resolves.toEqual({ ok: false, reason: "denied" });
  });

  describe("the always-on deny list", () => {
    const DENIED_PATHS = [
      ".env",
      ".env.local",
      "config/.env",
      ".ENV",
      ".git/config",
      "node_modules/pkg/index.js",
      ".ssh/id_rsa",
      "certs/server.pem",
      ".claude/settings.json",
    ] as const;

    it.each(DENIED_PATHS)(
      "answers denied for %s that exists, though the helper has no policy and would read it",
      async (relativePath) => {
        const { root } = fixture();
        mkdirSync(dirname(join(root, relativePath)), { recursive: true });
        writeFileSync(join(root, relativePath), "SECRET=1\n");
        // What the real helper answers for `.env`: it has no deny list and returns the bytes.
        const { port, create, verify } = portOver(root, () =>
          Promise.resolve(
            encodeSecureWorkspaceReadResponse({ status: "ok", bytes: Buffer.from("SECRET=1\n") }),
          ),
        );

        await expect(port.readText({ relativePath })).resolves.toEqual({
          ok: false,
          reason: "denied",
        });
        expect(verify).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
      },
    );

    it.each(DENIED_PATHS)(
      "answers denied for %s that does not exist, never not-found",
      async (relativePath) => {
        const { root } = fixture();
        const { port, create, verify } = portOver(root);

        await expect(port.readText({ relativePath })).resolves.toEqual({
          ok: false,
          reason: "denied",
        });
        expect(verify).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
      },
    );

    it("leaves the documented .env.example exception to the helper", async () => {
      const { root } = fixture();
      const { port, create } = portOver(root, () =>
        Promise.resolve(
          encodeSecureWorkspaceReadResponse({ status: "ok", bytes: Buffer.from("KEY=\n") }),
        ),
      );

      await expect(port.readText({ relativePath: ".env.example" })).resolves.toEqual({
        ok: true,
        text: "KEY=\n",
      });
      expect(create).toHaveBeenCalledOnce();
    });
  });
});
