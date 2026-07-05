import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryUiStore, type UiHandlerDeps } from "./index.js";
import {
  createWindowsNativeFileDialogAdapter,
  handleNativeFileDialogOpen,
  type NativeDialogProcessRunner,
} from "./native-file-dialog.js";
import type { RouteContext } from "./routes.js";

function jsonRequest(body: unknown): PassThrough {
  const stream = new PassThrough();
  stream.end(JSON.stringify(body));
  return stream;
}

function depsWithAdapter(pathValue: string): UiHandlerDeps {
  return {
    store: createInMemoryUiStore(),
    redactor: (value: unknown) => value,
    nativeFileDialog: {
      open() {
        return Promise.resolve({ cancelled: false, paths: [pathValue] });
      },
    },
  } as unknown as UiHandlerDeps;
}

describe("native file dialog route", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("validates native folder selections through the Files root policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "keiko-native-folder-"));
    tempDirs.push(root);
    const result = await handleNativeFileDialogOpen(
      {
        req: jsonRequest({ mode: "open-directory", title: "Select folder" }),
      } as unknown as RouteContext,
      depsWithAdapter(root),
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      cancelled: false,
      selections: [{ path: root, kind: "directory" }],
    });
  });

  it("rejects unsupported native file modes before invoking the adapter", async () => {
    const result = await handleNativeFileDialogOpen(
      { req: jsonRequest({ mode: "open-file" }) } as unknown as RouteContext,
      depsWithAdapter("C:\\repo"),
    );

    expect(result.status).toBe(501);
    expect(result.body).toEqual({
      error: {
        code: "NATIVE_DIALOG_UNSUPPORTED",
        message: "Native file selection is not supported yet.",
      },
    });
  });
});

describe("Windows native folder picker adapter", () => {
  it("runs a fixed PowerShell dialog command with JSON stdin", async () => {
    let capturedCommand = "";
    let capturedArgs: readonly string[] = [];
    let capturedStdin = "";
    const runner: NativeDialogProcessRunner = (command, args, stdin) => {
      capturedCommand = command;
      capturedArgs = args;
      capturedStdin = stdin;
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({ cancelled: false, paths: ["C:\\repo"] }),
        stderr: "",
        timedOut: false,
        outputExceeded: false,
      });
    };

    const result = await createWindowsNativeFileDialogAdapter(runner).open({
      mode: "open-directory",
      title: "Select folder",
      defaultPath: "C:\\repo",
    });

    expect(result).toEqual({ cancelled: false, paths: ["C:\\repo"] });
    expect(capturedCommand).toBe("powershell.exe");
    expect(capturedArgs.slice(0, 5)).toEqual([
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-STA",
      "-EncodedCommand",
    ]);
    expect(JSON.parse(capturedStdin)).toEqual({
      title: "Select folder",
      defaultPath: "C:\\repo",
    });
  });
});
