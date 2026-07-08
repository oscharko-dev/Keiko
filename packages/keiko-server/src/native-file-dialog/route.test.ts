import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeFileDialogRequest } from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "../deps.js";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import { buildRedactor, createInMemoryUiStore } from "../index.js";
import type { RouteContext } from "../routes.js";
import {
  NativeFileDialogAdapterError,
  type NativeFileDialogAdapter,
  type NativeFileDialogAdapterResult,
} from "./adapter.js";
import {
  createNativeFileDialogRouteState,
  handleNativeFileDialogCapability,
  handleNativeFileDialogOpen,
  type NativeFileDialogRouteOptions,
} from "./route.js";

const CORRELATION_ID = "native-dialog-test-corr";

function openContext(body: unknown): RouteContext {
  const req = Readable.from([
    Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8"),
  ]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
  return {
    req,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL("http://localhost/api/native-file-dialog/open"),
    correlationId: CORRELATION_ID,
  };
}

function fakeAdapter(result: NativeFileDialogAdapterResult): NativeFileDialogAdapter {
  return { open: () => Promise.resolve(result) };
}

interface TestDeps {
  readonly deps: UiHandlerDeps;
  readonly diagnostics: ServerDiagnosticRecord[];
}

function buildDeps(options: NativeFileDialogRouteOptions): TestDeps {
  const diagnostics: ServerDiagnosticRecord[] = [];
  const deps = {
    store: createInMemoryUiStore(),
    redactor: buildRedactor({}),
    diagnostics: {
      record: (record: ServerDiagnosticRecord) => {
        diagnostics.push(record);
      },
    },
    nativeFileDialog: options,
  } as unknown as UiHandlerDeps;
  return { deps, diagnostics };
}

function errorOf(body: unknown): { code: string; message: string; correlationId?: string } {
  return (body as { error: { code: string; message: string; correlationId?: string } }).error;
}

describe("native file dialog route", () => {
  const tempDirs: string[] = [];

  async function tempDir(prefix: string): Promise<string> {
    const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("accepts a validated native folder selection", async () => {
    const root = await tempDir("keiko-native-dir-");
    const { deps } = buildDeps({ adapter: fakeAdapter({ cancelled: false, paths: [root] }) });

    const result = await handleNativeFileDialogOpen(openContext({ mode: "open-directory" }), deps);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      cancelled: false,
      selections: [{ path: root, kind: "directory" }],
    });
  });

  it("accepts multiple validated file selections in dialog order", async () => {
    const root = await tempDir("keiko-native-files-");
    const first = join(root, "alpha.txt");
    const second = join(root, "beta.txt");
    await writeFile(first, "a");
    await writeFile(second, "b");
    const { deps } = buildDeps({
      adapter: fakeAdapter({ cancelled: false, paths: [second, first] }),
    });

    const result = await handleNativeFileDialogOpen(openContext({ mode: "open-files" }), deps);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      cancelled: false,
      selections: [
        { path: second, kind: "file" },
        { path: first, kind: "file" },
      ],
    });
  });

  it("returns a typed cancellation and ignores any stray adapter paths", async () => {
    const { deps } = buildDeps({
      adapter: fakeAdapter({ cancelled: true, paths: ["/never/validated"] }),
    });

    const result = await handleNativeFileDialogOpen(openContext({ mode: "open-file" }), deps);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ cancelled: true, selections: [] });
  });

  it("rejects malformed requests with the correlation id in the envelope", async () => {
    const { deps } = buildDeps({ adapter: fakeAdapter({ cancelled: true, paths: [] }) });

    const result = await handleNativeFileDialogOpen(openContext({ mode: "save-file" }), deps);

    expect(result.status).toBe(400);
    expect(errorOf(result.body).code).toBe("BAD_REQUEST");
    expect(errorOf(result.body).correlationId).toBe(CORRELATION_ID);
  });

  it("rejects non-JSON bodies", async () => {
    const { deps } = buildDeps({ adapter: fakeAdapter({ cancelled: true, paths: [] }) });
    const result = await handleNativeFileDialogOpen(openContext("{not json"), deps);
    expect(result.status).toBe(400);
  });

  it("rejects oversized bodies with 413", async () => {
    const { deps } = buildDeps({ adapter: fakeAdapter({ cancelled: true, paths: [] }) });
    const result = await handleNativeFileDialogOpen(
      openContext({ mode: "open-file", title: "x".repeat(20_000) }),
      deps,
    );
    expect(result.status).toBe(413);
    expect(errorOf(result.body).code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("answers 501 on platforms without an adapter", async () => {
    const { deps } = buildDeps({ platform: "linux" });

    const result = await handleNativeFileDialogOpen(openContext({ mode: "open-file" }), deps);

    expect(result.status).toBe(501);
    expect(errorOf(result.body).code).toBe("NATIVE_DIALOG_UNSUPPORTED");
  });

  it("serializes concurrent dialogs behind a 409 and releases the slot afterwards", async () => {
    const state = createNativeFileDialogRouteState();
    let releaseFirst: (() => void) | undefined;
    const blocking: NativeFileDialogAdapter = {
      open: () =>
        new Promise((resolve) => {
          releaseFirst = (): void => {
            resolve({ cancelled: true, paths: [] });
          };
        }),
    };
    const { deps } = buildDeps({ adapter: blocking, state });

    const firstCall = handleNativeFileDialogOpen(openContext({ mode: "open-file" }), deps);
    await vi.waitFor(() => {
      expect(state.active).toBe(true);
    });
    const second = await handleNativeFileDialogOpen(openContext({ mode: "open-file" }), deps);
    expect(second.status).toBe(409);
    expect(errorOf(second.body).code).toBe("NATIVE_DIALOG_ALREADY_OPEN");

    releaseFirst?.();
    const first = await firstCall;
    expect(first.status).toBe(200);
    expect(state.active).toBe(false);
  });

  it("releases the single-flight slot when the adapter fails", async () => {
    const state = createNativeFileDialogRouteState();
    const failing: NativeFileDialogAdapter = {
      open: () => Promise.reject(new NativeFileDialogAdapterError("failed", "helper failed")),
    };
    const { deps } = buildDeps({ adapter: failing, state });

    const first = await handleNativeFileDialogOpen(openContext({ mode: "open-file" }), deps);
    expect(first.status).toBe(502);
    expect(state.active).toBe(false);
  });

  it.each([
    ["relative path", "relative/path.txt"],
    ["NUL-bearing path", "/tmp/a\0b"],
    ["empty path", "   "],
  ])("rejects a %s from the adapter with 422", async (_label, path) => {
    const { deps } = buildDeps({ adapter: fakeAdapter({ cancelled: false, paths: [path] }) });

    const result = await handleNativeFileDialogOpen(openContext({ mode: "open-file" }), deps);

    expect(result.status).toBe(422);
    expect(errorOf(result.body).code).toBe("NATIVE_DIALOG_INVALID_SELECTION");
    expect(errorOf(result.body).message).not.toContain("tmp");
  });

  it("rejects selections that do not exist", async () => {
    const root = await tempDir("keiko-native-missing-");
    const { deps } = buildDeps({
      adapter: fakeAdapter({ cancelled: false, paths: [join(root, "missing.txt")] }),
    });

    const result = await handleNativeFileDialogOpen(openContext({ mode: "open-file" }), deps);

    expect(result.status).toBe(422);
  });

  it("rejects a directory returned for a file mode and vice versa", async () => {
    const root = await tempDir("keiko-native-kind-");
    const file = join(root, "plain.txt");
    await writeFile(file, "x");

    const dirForFileMode = buildDeps({
      adapter: fakeAdapter({ cancelled: false, paths: [root] }),
    });
    const wrongKindFile = await handleNativeFileDialogOpen(
      openContext({ mode: "open-file" }),
      dirForFileMode.deps,
    );
    expect(wrongKindFile.status).toBe(422);

    const fileForDirMode = buildDeps({
      adapter: fakeAdapter({ cancelled: false, paths: [file] }),
    });
    const wrongKindDir = await handleNativeFileDialogOpen(
      openContext({ mode: "open-directory" }),
      fileForDirMode.deps,
    );
    expect(wrongKindDir.status).toBe(422);
  });

  it("rejects selection counts outside the mode bounds", async () => {
    const root = await tempDir("keiko-native-count-");
    const first = join(root, "one.txt");
    const second = join(root, "two.txt");
    await writeFile(first, "1");
    await writeFile(second, "2");

    const twoForSingle = buildDeps({
      adapter: fakeAdapter({ cancelled: false, paths: [first, second] }),
    });
    expect(
      (await handleNativeFileDialogOpen(openContext({ mode: "open-file" }), twoForSingle.deps))
        .status,
    ).toBe(422);

    const noneForMulti = buildDeps({ adapter: fakeAdapter({ cancelled: false, paths: [] }) });
    expect(
      (await handleNativeFileDialogOpen(openContext({ mode: "open-files" }), noneForMulti.deps))
        .status,
    ).toBe(422);
  });

  it("rejects deny-listed selections without echoing the path", async () => {
    const root = await tempDir("keiko-native-denied-");
    const sshDir = join(root, ".ssh");
    await mkdir(sshDir);
    const keyFile = join(sshDir, "id_rsa");
    await writeFile(keyFile, "private");

    const deniedDir = buildDeps({ adapter: fakeAdapter({ cancelled: false, paths: [sshDir] }) });
    const dirResult = await handleNativeFileDialogOpen(
      openContext({ mode: "open-directory" }),
      deniedDir.deps,
    );
    expect(dirResult.status).toBe(422);
    expect(errorOf(dirResult.body).message).not.toContain(".ssh");

    const deniedFile = buildDeps({ adapter: fakeAdapter({ cancelled: false, paths: [keyFile] }) });
    const fileResult = await handleNativeFileDialogOpen(
      openContext({ mode: "open-file" }),
      deniedFile.deps,
    );
    expect(fileResult.status).toBe(422);
    expect(errorOf(fileResult.body).message).not.toContain("id_rsa");
  });

  it("rejects a symlink whose real target is deny-listed", async () => {
    const root = await tempDir("keiko-native-symlink-");
    const hidden = join(root, ".aws");
    await mkdir(hidden);
    const link = join(root, "harmless");
    await symlink(hidden, link);
    const { deps } = buildDeps({ adapter: fakeAdapter({ cancelled: false, paths: [link] }) });

    const result = await handleNativeFileDialogOpen(openContext({ mode: "open-directory" }), deps);

    expect(result.status).toBe(422);
  });

  it("treats a non-string redactor result as safe, matching files.ts's metadataIsSafe convention", async () => {
    const root = await tempDir("keiko-native-file-redact-");
    const file = join(root, "note.txt");
    await writeFile(file, "hello");
    const { deps } = buildDeps({ adapter: fakeAdapter({ cancelled: false, paths: [file] }) });
    const nonStringRedactor = (value: unknown): unknown => (value === file ? 42 : value);
    const overriddenDeps: UiHandlerDeps = { ...deps, redactor: nonStringRedactor };

    const result = await handleNativeFileDialogOpen(
      openContext({ mode: "open-file" }),
      overriddenDeps,
    );

    expect(result.status).toBe(200);
  });

  it("checks metadata-redaction safety before the filesystem chain, mirroring resolveArbitraryRoot's order", async () => {
    const missingPath = "/tmp/keiko-native-missing-unsafe-path.txt";
    const { deps } = buildDeps({
      adapter: fakeAdapter({ cancelled: false, paths: [missingPath] }),
    });
    const unsafeRedactor = (value: unknown): unknown =>
      value === missingPath ? "[REDACTED]" : value;
    const overriddenDeps: UiHandlerDeps = { ...deps, redactor: unsafeRedactor };

    const result = await handleNativeFileDialogOpen(
      openContext({ mode: "open-file" }),
      overriddenDeps,
    );

    expect(result.status).toBe(422);
    expect(errorOf(result.body).message).toBe(
      "The selected path is excluded from Keiko's read surface.",
    );
  });

  it("accepts a symlinked directory with a safe target and returns the picked path", async () => {
    const root = await tempDir("keiko-native-symlink-ok-");
    const target = join(root, "real-project");
    await mkdir(target);
    const link = join(root, "linked-project");
    await symlink(target, link);
    const { deps } = buildDeps({ adapter: fakeAdapter({ cancelled: false, paths: [link] }) });

    const result = await handleNativeFileDialogOpen(openContext({ mode: "open-directory" }), deps);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      cancelled: false,
      selections: [{ path: link, kind: "directory" }],
    });
  });

  it("maps adapter timeouts to 504 and records a redacted operator diagnostic", async () => {
    const timingOut: NativeFileDialogAdapter = {
      open: () =>
        Promise.reject(
          new NativeFileDialogAdapterError(
            "timeout",
            "native dialog timed out (exitCode=null stderrBytes=0 outputExceeded=false)",
          ),
        ),
    };
    const { deps, diagnostics } = buildDeps({ adapter: timingOut });

    const result = await handleNativeFileDialogOpen(openContext({ mode: "open-file" }), deps);

    expect(result.status).toBe(504);
    expect(errorOf(result.body).code).toBe("NATIVE_DIALOG_TIMEOUT");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.source).toBe("native-file-dialog");
    expect(diagnostics[0]?.correlationId).toBe(CORRELATION_ID);
  });

  it("maps adapter failures to 502 without leaking detail to the browser", async () => {
    const failing: NativeFileDialogAdapter = {
      open: () =>
        Promise.reject(new NativeFileDialogAdapterError("failed", "exitCode=1 stderrBytes=42")),
    };
    const { deps, diagnostics } = buildDeps({ adapter: failing });

    const result = await handleNativeFileDialogOpen(openContext({ mode: "open-file" }), deps);

    expect(result.status).toBe(502);
    expect(errorOf(result.body).code).toBe("NATIVE_DIALOG_FAILED");
    expect(errorOf(result.body).message).not.toContain("exitCode");
    expect(diagnostics).toHaveLength(1);
  });

  it("normalizes the defaultPath hint before it reaches the adapter", async () => {
    const root = await tempDir("keiko-native-hint-");
    const file = join(root, "seed.txt");
    await writeFile(file, "x");
    const seen: NativeFileDialogRequest[] = [];
    const capturing: NativeFileDialogAdapter = {
      open: (request) => {
        seen.push(request);
        return Promise.resolve({ cancelled: true, paths: [] });
      },
    };
    const { deps } = buildDeps({ adapter: capturing });

    await handleNativeFileDialogOpen(openContext({ mode: "open-file", defaultPath: file }), deps);
    await handleNativeFileDialogOpen(openContext({ mode: "open-file", defaultPath: root }), deps);
    await handleNativeFileDialogOpen(
      openContext({ mode: "open-file", defaultPath: join(root, "missing", "deep") }),
      deps,
    );

    expect(seen[0]?.defaultPath).toBe(dirname(file));
    expect(seen[1]?.defaultPath).toBe(root);
    expect(seen[2]?.defaultPath).toBeUndefined();
  });
});

describe("native file dialog capability", () => {
  it("reports support from the server platform, not the client", () => {
    const supported = buildDeps({ platform: "darwin" });
    const unsupported = buildDeps({ platform: "linux" });
    const ctx = openContext({});

    expect(handleNativeFileDialogCapability(ctx, supported.deps).body).toEqual({
      supported: true,
    });
    expect(handleNativeFileDialogCapability(ctx, unsupported.deps).body).toEqual({
      supported: false,
    });
  });

  it("treats an injected adapter as supported regardless of platform", () => {
    const { deps } = buildDeps({
      platform: "linux",
      adapter: fakeAdapter({ cancelled: true, paths: [] }),
    });
    expect(handleNativeFileDialogCapability(openContext({}), deps).body).toEqual({
      supported: true,
    });
  });
});
