import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  truncateSync,
  readFileSync,
  linkSync,
  utimesSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createCodingToolReadEditPorts } from "./codingToolReadEditPorts.js";

import {
  createSecureWorkspaceTextReadPort,
  exactWorkspaceRead,
  type SecureWorkspaceTextReadResult,
  type SecureWorkspaceNativeFileIO,
} from "./secureWorkspaceTextRead.js";
import { createNodeSecureWorkspaceReadProcessFactory } from "./secureWorkspaceTextReadNodeProcess.js";
import type { WorkspacePathLstat } from "./secureWorkspaceTextReadAbsence.js";
import type { SecureWorkspaceTextReadArtifact } from "./secureWorkspaceTextReadArtifact.js";
import {
  SECURE_WORKSPACE_TEXT_READ_MAX_LIVE,
  type SecureWorkspaceTextReadProcessFactory,
} from "./secureWorkspaceTextReadProcess.js";
import {
  SECURE_WORKSPACE_TEXT_READ_MAX_BYTES,
  SECURE_WORKSPACE_NATIVE_MAX_BYTES,
  encodeSecureWorkspaceNativeRequest,
  encodeSecureWorkspaceSnapshotResponse,
  decodeSecureWorkspaceReadRequest,
  encodeSecureWorkspaceReadResponse,
  type SecureWorkspaceReadClosedStatus,
} from "./secureWorkspaceTextReadProtocol.js";

const MAX_TEXT_BYTES = SECURE_WORKSPACE_TEXT_READ_MAX_BYTES;
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
  lstat?: WorkspacePathLstat,
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
      ...(lstat === undefined ? {} : { lstat }),
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
  it("uses the verified legacy helper's request ceiling during a runtime upgrade", async () => {
    const caps: number[] = [];
    const run = (request: { readonly stdin: Uint8Array }): Promise<Uint8Array> => {
      caps.push(Buffer.from(request.stdin).readUInt32LE(16));
      return Promise.resolve(response(0, Buffer.from("safe\n")));
    };
    const port = createSecureWorkspaceTextReadPort({
      resolveWorkspaceRoot: () => "/server-owned/workspace",
      artifact: { ...artifact, byteCap: 65_536 },
      artifactVerifier: { verify: (): boolean => true },
      processFactory: { create: () => ({ run }) },
      platform: { os: "darwin", arch: "arm64" },
    });
    await expect(port.readText({ relativePath: "src/a.ts" })).resolves.toEqual({
      ok: true,
      text: "safe\n",
    });
    expect(caps).toEqual([65_536]);
  });

  it("reads a repository instruction file above the former 64 KiB ceiling", async () => {
    const text = "Repository convention.\n".repeat(4_000);
    const { port } = createPort(() => Promise.resolve(response(0, Buffer.from(text))));
    await expect(port.readText({ relativePath: "AGENTS.md" })).resolves.toEqual({
      ok: true,
      text,
    });
  });

  it("rejects a legacy helper response above that artifact's verified ceiling", async () => {
    const port = createSecureWorkspaceTextReadPort({
      resolveWorkspaceRoot: () => "/server-owned/workspace",
      artifact: { ...artifact, byteCap: 65_536 },
      artifactVerifier: { verify: (): boolean => true },
      processFactory: {
        create: () => ({
          run: (): Promise<Uint8Array> => Promise.resolve(response(0, Buffer.alloc(65_537, 0x61))),
        }),
      },
      platform: { os: "darwin", arch: "arm64" },
    });
    await expect(port.readText({ relativePath: "src/a.ts" })).resolves.toEqual({
      ok: false,
      reason: "protocol-invalid",
    });
  });

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

  it("returns exactly the pinned maximum safe bytes and maps helper oversize status to a content-free denial", async () => {
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
    const pending = Array.from({ length: SECURE_WORKSPACE_TEXT_READ_MAX_LIVE }, () =>
      deferred<Uint8Array>(),
    );
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
    lstat?: WorkspacePathLstat,
  ): ReturnType<typeof createPort> {
    return createPort(run, { os: "darwin", arch: "arm64" }, () => root, lstat);
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
      absence: "absent",
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
      absence: "exists",
    });
  });

  it("keeps the helper's denial for a directory at the final component", async () => {
    const { root } = fixture();
    const { port } = portOver(root);

    await expect(port.readText({ relativePath: "src" })).resolves.toEqual({
      ok: false,
      reason: "denied",
      absence: "exists",
    });
  });

  it("keeps the helper's denial below a file used as a directory", async () => {
    const { root } = fixture();
    writeFileSync(join(root, "src", "present.ts"), "export {};\n");
    const { port } = portOver(root);

    await expect(port.readText({ relativePath: "src/present.ts/nested.ts" })).resolves.toEqual({
      ok: false,
      reason: "denied",
      absence: "not-directory",
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
        absence: "link",
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
        absence: "link",
      });
    },
  );

  // #3873 review (PR #3876): a denied creation could not be told apart in the log. A repository that
  // keeps a bind-mounted `build/` directory under the workspace, or whose parent directory lost its
  // search bit, was refused as `denied` exactly as a symlink was; the verdict names which it was. The
  // probe is scripted here because a mount and a lost search bit cannot be made on a test machine.
  describe("a denial the walk could not turn into not-found names why", () => {
    const directory = (dev: bigint): Awaited<ReturnType<WorkspacePathLstat>> => ({
      dev,
      isDirectory: (): boolean => true,
      isSymbolicLink: (): boolean => false,
    });
    const errno = (code: string): Error => Object.assign(new Error(code), { code });

    it("names the other device a bind-mounted directory in the chain lives on", async () => {
      const { root } = fixture();
      const { port } = portOver(root, helperRefuses(), (path) =>
        path === join(root, "build")
          ? Promise.resolve(directory(2n))
          : Promise.resolve(directory(1n)),
      );

      await expect(port.readText({ relativePath: "build/out/report.md" })).resolves.toEqual({
        ok: false,
        reason: "denied",
        absence: "foreign-device",
      });
    });

    it.each(["EACCES", "EIO"])(
      "names a directory in the chain whose probe failed with %s, never the error",
      async (code) => {
        const { root } = fixture();
        const { port } = portOver(root, helperRefuses(), (path) =>
          path === join(root, "build")
            ? Promise.reject(errno(code))
            : Promise.resolve(directory(1n)),
        );

        const result = await port.readText({ relativePath: "build/out/report.md" });

        expect(result).toEqual({ ok: false, reason: "denied", absence: "probe-failed" });
        expect(JSON.stringify(result)).not.toContain(code);
        expect(JSON.stringify(result)).not.toContain("build");
      },
    );
  });

  it("denies, and never answers not-found, when the root is not a real directory", async () => {
    const { base, root } = fixture();
    writeFileSync(join(base, "file-root"), "not a directory\n");
    symlinkSync(root, join(base, "link-root"), directorySymlinkType());

    for (const unusable of [join(base, "gone"), join(base, "file-root"), join(base, "link-root")]) {
      const { port } = portOver(unusable);
      await expect(port.readText({ relativePath: "src/new.ts" })).resolves.toEqual({
        ok: false,
        reason: "denied",
        absence: "root-unusable",
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
      absence: "exists",
    });
    root = second.root;
    await expect(port.readText({ relativePath: "src/shared.ts" })).resolves.toEqual({
      ok: false,
      reason: "not-found",
      absence: "absent",
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
    ).resolves.toEqual({ ok: false, reason: "denied", absence: "aborted" });
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

it("offers a rich snapshot facet without treating a verified legacy helper as rich-capable", async () => {
  const run = vi.fn(() => Promise.resolve(response(0, Buffer.from("private text"))));
  const { port, create } = createPort(run);
  expect("readTextSnapshot" in port).toBe(true);
  await expect(port.readTextSnapshot?.({ relativePath: "src/a.ts" })).resolves.toEqual({
    ok: false,
    reason: "snapshot-unavailable",
  });
  expect(create).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

describe("pinned rich secure text read", () => {
  function richPort(
    run: (request: {
      readonly stdin: Uint8Array;
      readonly signal: AbortSignal;
    }) => Promise<Uint8Array>,
  ): ReturnType<typeof createSecureWorkspaceTextReadPort> {
    return createSecureWorkspaceTextReadPort({
      resolveWorkspaceRoot: () => "/current/workspace",
      artifact: { ...artifact, snapshotProtocol: "KSR2/KSS2" },
      artifactVerifier: { verify: (): boolean => true },
      processFactory: { create: () => ({ run }) },
      platform: { os: "darwin", arch: "arm64" },
    });
  }
  function snapshot(): Buffer {
    return encodeSecureWorkspaceSnapshotResponse({
      status: "ok",
      bytes: Buffer.from("safe\n"),
      info: { type: "file", size: 5, mtimeMs: 1_600_000_000_000 },
    });
  }

  it("returns only verified same-descriptor facts and wipes transient response bytes", async () => {
    const frame = snapshot();
    const port = richPort(({ stdin }) => {
      expect(Buffer.from(stdin.subarray(0, 4)).toString("ascii")).toBe("KSR2");
      return Promise.resolve(frame);
    });
    const result = await port.readTextSnapshot?.({ relativePath: "src/a.ts" });
    expect(result).toEqual({
      ok: true,
      text: "safe\n",
      info: { type: "file", size: 5, mtimeMs: 1_600_000_000_000 },
    });
    expect(frame).toEqual(Buffer.alloc(frame.byteLength));
    if (!result?.ok) throw new Error("expected snapshot");
    expect(Object.isFrozen(result.info)).toBe(true);
  });

  it("discards the snapshot when the caller cancels before helper settlement", async () => {
    const controller = new AbortController();
    const frame = snapshot();
    const port = richPort(() => {
      controller.abort();
      return Promise.resolve(frame);
    });
    await expect(
      port.readTextSnapshot?.({ relativePath: "src/a.ts", signal: controller.signal }),
    ).resolves.toEqual({ ok: false, reason: "cancelled" });
    expect(frame).toEqual(Buffer.alloc(frame.byteLength));
  });

  it("preserves the current-workspace wrapper around the richer facet", async () => {
    let current = true;
    const port = exactWorkspaceRead(
      richPort(() => {
        current = false;
        return Promise.resolve(snapshot());
      }),
      () => current,
      "workspace-unavailable",
    );
    await expect(port.readTextSnapshot?.({ relativePath: "AGENTS.md" })).resolves.toEqual({
      ok: false,
      reason: "workspace-unavailable",
    });
  });

  it.each([".env", ".keiko/private/state.db", "../outside.txt"])(
    "does not invoke the helper for protected %s",
    async (relativePath) => {
      const run = vi.fn(() => Promise.resolve(snapshot()));
      const port = richPort(run);
      await expect(port.readTextSnapshot?.({ relativePath })).resolves.toEqual({
        ok: false,
        reason: "denied",
      });
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("refuses a foreign ordinary success frame without disclosing content", async () => {
    const frame = response(0, Buffer.from("private text"));
    const port = richPort(() => Promise.resolve(frame));
    await expect(port.readTextSnapshot?.({ relativePath: "src/a.ts" })).resolves.toEqual({
      ok: false,
      reason: "protocol-invalid",
    });
    expect(frame).toEqual(Buffer.alloc(frame.byteLength));
  });

  it("persists an actual malformed snapshot refusal through the governed read owner", async () => {
    const frame = encodeSecureWorkspaceReadResponse({
      status: "ok",
      bytes: Buffer.from("PRIVATE_HELPER_RESPONSE_SENTINEL"),
    });
    const binding = {
      runId: "run-rich-decoder-refusal",
      envelopeDigest: "a".repeat(64),
      workspaceId: "workspace-rich-decoder-refusal",
      workspaceRootDigest: "b".repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const events: ServerLogEvent[] = [];
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: richPort(() => Promise.resolve(frame)),
      editorAgentClient: { action: vi.fn() },
      resolveEditorActionContext: vi.fn(),
      resolveRepositoryReadContext: () => binding,
      enforceProducerBinding: true,
      activityLog: { write: (event): void => void events.push(event) },
    });
    await expect(
      ports.nativeTextRead.readTextSnapshot(
        { relativePath: "src/a.ts", purpose: "native-tool-io" },
        undefined,
        { binding, check: () => true },
      ),
    ).resolves.toEqual({ ok: false, reason: "protocol-invalid" });
    expect(events).toHaveLength(1);
    const persisted = expectActivityLogProof(
      "coding-runtime.workspace-read.emitted-line",
      formatActivityLogProofLine(events[0] ?? {}),
    );
    expect(persisted).toMatchObject({
      state: "failed",
      purpose: "native-tool-io",
      reason: "protocol-invalid",
    });
    expect(frame).toEqual(Buffer.alloc(frame.byteLength));
    expect(JSON.stringify(events)).not.toContain("PRIVATE_HELPER_RESPONSE_SENTINEL");
    expect(JSON.stringify(events)).not.toContain("src/a.ts");
  });
});

// The injected verifier proves fixture bytes only, not release signatures or production activation.
function nativeFixturePort(
  root: string,
  executable: string,
  overrides: Partial<SecureWorkspaceTextReadArtifact> = {},
  legacy = false,
): ReturnType<typeof createSecureWorkspaceTextReadPort> {
  const target = process.platform === "darwin" ? `darwin-${process.arch}` : "linux-x64";
  const candidate = {
    ...artifact,
    target,
    nativeProtocol: "KSR3/KSS3" as const,
    sha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
    ...overrides,
  };
  if (legacy) Reflect.deleteProperty(candidate, "nativeProtocol");
  return createSecureWorkspaceTextReadPort({
    resolveWorkspaceRoot: () => root,
    artifact: candidate,
    artifactVerifier: { verify: (): boolean => true },
    processFactory: createNodeSecureWorkspaceReadProcessFactory({
      binding: {
        executable,
        artifact: candidate,
        helperSizeBytes: readFileSync(executable).length,
        resourceRoot: dirname(executable),
      },
      safeCwd: dirname(executable),
    }),
  });
}

function requireNativeFacet(
  port: ReturnType<typeof createSecureWorkspaceTextReadPort>,
): SecureWorkspaceNativeFileIO {
  expect(port.nativeFileIO).toBeDefined();
  if (port.nativeFileIO === undefined) throw new Error("native-io-facet-missing");
  return port.nativeFileIO;
}

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "private native file IO using the actual descriptor helper",
  () => {
    let base: string;
    let root: string;
    let executable: string;
    beforeAll(() => {
      base = realpathSync(mkdtempSync(join(tmpdir(), "native-io-port-")));
      root = join(base, "workspace");
      mkdirSync(root);
      executable = join(base, "secure-read");
      execFileSync("cc", [
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        process.platform === "linux" ? "-D_GNU_SOURCE" : "-D_DARWIN_C_SOURCE",
        "-O2",
        fileURLToPath(
          new URL(
            "../../../../native/secure-workspace-read/secure_workspace_read.c",
            import.meta.url,
          ),
        ),
        "-o",
        executable,
      ]);
      writeFileSync(join(root, "bytes.bin"), Buffer.from([0, 255, 128, 2, 0]));
      utimesSync(join(root, "bytes.bin"), new Date(-2000), new Date(-2000));
      mkdirSync(join(root, "nested"));
      writeFileSync(join(root, "nested", "visible.ts"), "safe");
      writeFileSync(join(root, ".env"), "synthetic fixture secret");
    });
    afterAll(() => {
      rmSync(base, { recursive: true, force: true });
    });

    it("preserves raw binary and finite pre-epoch metadata without text decoding", async () => {
      const io = requireNativeFacet(nativeFixturePort(root, executable));
      await expect(io.readBytes({ relativePath: "bytes.bin" })).resolves.toEqual({
        ok: true,
        bytes: Buffer.from([0, 255, 128, 2, 0]),
        info: { type: "file", size: 5, mtimeMs: -2000 },
      });
      await expect(io.stat({ relativePath: "bytes.bin" })).resolves.toEqual({
        ok: true,
        info: { type: "file", size: 5, mtimeMs: -2000 },
      });
    });

    it("keeps original large-file byte ranges and EOF semantics outside the text ceiling", async () => {
      const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 0x61);
      bytes.set([0, 255, 128], 1_300_000);
      writeFileSync(join(root, "large.bin"), bytes);
      const io = requireNativeFacet(nativeFixturePort(root, executable));
      const result = await io.readBytes({
        relativePath: "large.bin",
        range: { offset: 1_300_000, length: 3 },
      });
      expect(result).toMatchObject({
        ok: true,
        bytes: Buffer.from([0, 255, 128]),
        info: { type: "file", size: bytes.length },
      });
      expect(
        await io.readBytes({
          relativePath: "large.bin",
          range: { offset: bytes.length + 1, length: 3 },
        }),
      ).toMatchObject({ ok: true, bytes: Buffer.alloc(0) });
    });

    it("returns immediate directory entries while filtering sensitive names before disclosure", async () => {
      const io = requireNativeFacet(nativeFixturePort(root, executable));
      const rootResult = await io.list({ relativePath: "" });
      expect(rootResult).toMatchObject({ ok: true, info: { type: "directory" } });
      if (!rootResult.ok) throw new Error("directory-list-failed");
      expect(rootResult.entries.map((entry) => entry.name)).not.toContain(".env");
      await expect(io.list({ relativePath: "nested" })).resolves.toMatchObject({
        ok: true,
        entries: [{ name: "visible.ts", type: "file" }],
      });
      await expect(io.readBytes({ relativePath: "nested" })).resolves.toMatchObject({
        ok: false,
        reason: "wrong-kind",
        info: { type: "directory" },
      });
    });

    it("refuses sensitive, escaped and malformed paths without testing their presence", async () => {
      const io = requireNativeFacet(nativeFixturePort(root, executable));
      for (const relativePath of [
        ".env",
        ".env.local",
        "../outside",
        "/absolute",
        "nested/",
        "\ud800",
      ])
        await expect(io.stat({ relativePath })).resolves.toMatchObject({
          ok: false,
          reason: "denied",
        });
    });

    it("does not grant content or directory access through links or hardlinks", async () => {
      symlinkSync("bytes.bin", join(root, "symlink.bin"));
      symlinkSync("nested", join(root, "symlink-dir"));
      linkSync(join(root, "bytes.bin"), join(root, "hardlink.bin"));
      const io = requireNativeFacet(nativeFixturePort(root, executable));
      await expect(io.stat({ relativePath: "symlink.bin" })).resolves.toMatchObject({
        ok: true,
        info: { type: "symlink" },
      });
      for (const relativePath of ["symlink.bin", "hardlink.bin"])
        await expect(io.readBytes({ relativePath })).resolves.toMatchObject({ ok: false });
      await expect(io.list({ relativePath: "symlink-dir" })).resolves.toMatchObject({ ok: false });
    });

    it("keeps whole-file bytes distinct from text caps and bounds native payloads honestly", async () => {
      const content = Buffer.alloc(SECURE_WORKSPACE_TEXT_READ_MAX_BYTES + 1, 0);
      const path = join(root, "whole.bin");
      writeFileSync(path, content);
      const io = requireNativeFacet(nativeFixturePort(root, executable));
      expect(await io.readBytes({ relativePath: "whole.bin" })).toMatchObject({
        ok: true,
        bytes: content,
        info: { size: content.length },
      });
      writeFileSync(join(root, "empty.bin"), Buffer.alloc(0));
      expect(await io.readBytes({ relativePath: "empty.bin" })).toMatchObject({
        ok: true,
        bytes: Buffer.alloc(0),
      });
      truncateSync(path, SECURE_WORKSPACE_NATIVE_MAX_BYTES + 1);
      await expect(io.readBytes({ relativePath: "whole.bin" })).resolves.toMatchObject({
        ok: false,
        reason: "too-large",
      });
      await expect(
        io.readBytes({
          relativePath: "whole.bin",
          range: {
            offset: SECURE_WORKSPACE_NATIVE_MAX_BYTES,
            length: 1,
          },
        }),
      ).resolves.toMatchObject({ ok: true, bytes: Buffer.alloc(1) });
    });

    it.skipIf(process.platform !== "linux")(
      "refuses an unrepresentable directory rather than dropping an entry",
      async () => {
        const folder = join(root, "invalid-entry");
        mkdirSync(folder);
        writeFileSync(join(folder, "valid.ts"), "safe");
        writeFileSync(Buffer.concat([Buffer.from(`${folder}/`), Buffer.from([0xff])]), "synthetic");
        const io = requireNativeFacet(nativeFixturePort(root, executable));
        await expect(io.list({ relativePath: "invalid-entry" })).resolves.toMatchObject({
          ok: false,
          reason: "denied",
        });
      },
    );

    it("keeps original legal long paths above the public IPC path bound", async () => {
      const folders = Array.from({ length: 8 }, (_, index) =>
        `${String(index)}-`.concat("p".repeat(80)),
      );
      mkdirSync(join(root, ...folders), { recursive: true });
      const path = folders.join("/").concat("/file:with-colon.ts");
      writeFileSync(join(root, path), "long path text");
      const io = requireNativeFacet(nativeFixturePort(root, executable));
      expect(Buffer.byteLength(path)).toBeGreaterThan(512);
      await expect(io.readBytes({ relativePath: path })).resolves.toMatchObject({
        ok: true,
        bytes: Buffer.from("long path text"),
      });
    });

    it("joins cancellation and workspace postflight before releasing actual helper bytes", async () => {
      const frame = execFileSync(executable, {
        input: encodeSecureWorkspaceNativeRequest({
          root,
          relativePath: "nested/visible.ts",
          operation: "read",
        }),
      });
      const work = deferred<Uint8Array>();
      let current = root;
      const run = vi.fn((): Promise<Uint8Array> => work.promise);
      const port = createSecureWorkspaceTextReadPort({
        resolveWorkspaceRoot: () => current,
        artifact: { ...artifact, nativeProtocol: "KSR3/KSS3" },
        artifactVerifier: { verify: (): boolean => true },
        platform: { os: "darwin", arch: "arm64" },
        processFactory: { create: () => ({ run }) },
      });
      const reading = requireNativeFacet(port).readBytes({ relativePath: "nested/visible.ts" });
      await vi.waitFor(() => {
        expect(run).toHaveBeenCalledOnce();
      });
      current = `${root}-other`;
      work.resolve(frame);
      await expect(reading).resolves.toMatchObject({ ok: false, reason: "workspace-unavailable" });
      expect(frame.every((byte) => byte === 0)).toBe(true);
    });

    it("rejects invalid ranges, cancellation and missing capability without a process", async () => {
      const run = vi.fn(() => Promise.resolve(Buffer.alloc(0)));
      const port = createSecureWorkspaceTextReadPort({
        resolveWorkspaceRoot: () => root,
        artifact: { ...artifact, nativeProtocol: "KSR3/KSS3" },
        artifactVerifier: { verify: (): boolean => true },
        platform: { os: "darwin", arch: "arm64" },
        processFactory: { create: () => ({ run }) },
      });
      const io = requireNativeFacet(port);
      for (const range of [
        { offset: -1, length: 1 },
        { offset: 0, length: SECURE_WORKSPACE_NATIVE_MAX_BYTES + 1 },
        { offset: Number.MAX_SAFE_INTEGER, length: 1 },
      ])
        await expect(io.readBytes({ relativePath: "bytes.bin", range })).resolves.toMatchObject({
          ok: false,
          reason: "denied",
        });
      await expect(
        io.stat({ relativePath: "bytes.bin", signal: AbortSignal.abort() }),
      ).resolves.toMatchObject({ ok: false, reason: "cancelled" });
      expect(run).not.toHaveBeenCalled();
    });

    it("shares existing physical capacity and retains cancellation slots until actual settlement", async () => {
      const frame = execFileSync(executable, {
        input: encodeSecureWorkspaceNativeRequest({
          root,
          relativePath: "nested/visible.ts",
          operation: "stat",
        }),
      });
      const pending = Array.from({ length: SECURE_WORKSPACE_TEXT_READ_MAX_LIVE }, () =>
        deferred<Uint8Array>(),
      );
      let count = 0;
      const run = vi.fn((): Promise<Uint8Array> => {
        const work = pending[count++];
        return work === undefined ? Promise.resolve(Buffer.from(frame)) : work.promise;
      });
      const port = createSecureWorkspaceTextReadPort({
        resolveWorkspaceRoot: () => root,
        artifact: { ...artifact, nativeProtocol: "KSR3/KSS3" },
        artifactVerifier: { verify: (): boolean => true },
        platform: { os: "darwin", arch: "arm64" },
        processFactory: { create: () => ({ run }) },
      });
      const io = requireNativeFacet(port);
      const controller = new AbortController();
      const calls = pending.map(() =>
        io.stat({ relativePath: "nested/visible.ts", signal: controller.signal }),
      );
      await vi.waitFor(() => {
        expect(run).toHaveBeenCalledTimes(SECURE_WORKSPACE_TEXT_READ_MAX_LIVE);
      });
      controller.abort();
      await expect(port.readText({ relativePath: "nested/visible.ts" })).resolves.toMatchObject({
        ok: false,
        reason: "busy",
      });
      await expect(io.stat({ relativePath: "nested/visible.ts" })).resolves.toMatchObject({
        ok: false,
        reason: "busy",
      });
      pending.forEach((work) => {
        work.resolve(Buffer.from(frame));
      });
      const results = await Promise.all(calls);
      expect(results.every((result) => !result.ok && result.reason === "cancelled")).toBe(true);
      await expect(io.stat({ relativePath: "nested/visible.ts" })).resolves.toMatchObject({
        ok: true,
      });
    });

    it("preserves the exact workspace wrapper and purges bytes after its guard changes", async () => {
      const bytes = Buffer.from([0, 255, 1]);
      let current = true;
      const read = vi.fn(() => {
        current = false;
        return Promise.resolve({
          ok: true as const,
          bytes,
          info: { type: "file" as const, size: 3, mtimeMs: 0 },
        });
      });
      const wrapped = exactWorkspaceRead(
        {
          readText: (): Promise<SecureWorkspaceTextReadResult> =>
            Promise.resolve({ ok: false, reason: "denied" }),
          nativeFileIO: { readBytes: read, stat: vi.fn(), list: vi.fn() },
        },
        () => current,
        "workspace-unavailable",
      );
      const io = requireNativeFacet(wrapped);
      await expect(io.readBytes({ relativePath: "a.bin" })).resolves.toMatchObject({
        ok: false,
        reason: "workspace-unavailable",
      });
      expect(bytes).toEqual(Buffer.alloc(3));
      await expect(io.readBytes({ relativePath: "a.bin" })).resolves.toMatchObject({
        ok: false,
        reason: "workspace-unavailable",
      });
      expect(read).toHaveBeenCalledOnce();
    });

    it("keeps native capability unavailable on currently pinned text helpers", async () => {
      const io = requireNativeFacet(nativeFixturePort(root, executable, {}, true));
      await expect(io.stat({ relativePath: "nested" })).resolves.toMatchObject({
        ok: false,
        reason: "native-io-unavailable",
      });
    });
  },
);
