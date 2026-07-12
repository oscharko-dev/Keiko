import { describe, expect, it, vi } from "vitest";
import {
  createMacosNativeFileDialogAdapter,
  createNativeFileDialogAdapter,
  createWindowsNativeFileDialogAdapter,
  NativeFileDialogAdapterError,
  runNativeDialogProcess,
  type NativeDialogProcessResult,
  type NativeDialogProcessRunner,
} from "./adapter.js";
import { MACOS_NATIVE_FILE_DIALOG_SCRIPT, WINDOWS_NATIVE_FILE_DIALOG_SCRIPT } from "./scripts.js";

interface CapturedInvocation {
  command: string;
  args: readonly string[];
  stdin: string;
  timeoutMs: number;
}

function captureRunner(
  result: Partial<NativeDialogProcessResult>,
  captured: CapturedInvocation[],
): NativeDialogProcessRunner {
  return (command, args, stdin, timeoutMs) => {
    captured.push({ command, args, stdin, timeoutMs });
    return Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify({ cancelled: false, paths: ["/tmp/x"] }),
      stderr: "",
      timedOut: false,
      outputExceeded: false,
      ...result,
    });
  };
}

async function adapterFailure(
  runner: NativeDialogProcessRunner,
): Promise<NativeFileDialogAdapterError> {
  try {
    await createMacosNativeFileDialogAdapter(runner).open({ mode: "open-file" });
  } catch (error) {
    if (error instanceof NativeFileDialogAdapterError) return error;
    throw error;
  }
  throw new Error("expected the adapter to fail");
}

describe("macOS native dialog adapter", () => {
  it("invokes the fixed osascript binary with the static JXA program and stdin JSON", async () => {
    const captured: CapturedInvocation[] = [];
    const runner = captureRunner(
      { stdout: JSON.stringify({ cancelled: false, paths: ["/Users/x/Projekte"] }) },
      captured,
    );

    const result = await createMacosNativeFileDialogAdapter(runner).open({
      mode: "open-directory",
      title: "Ordner wählen",
      defaultPath: "/Users/x",
      filters: [{ name: "Docs", extensions: ["md", "txt"] }],
    });

    expect(result).toEqual({ cancelled: false, paths: ["/Users/x/Projekte"] });
    const invocation = captured[0];
    expect(invocation?.command).toBe("/usr/bin/osascript");
    expect(invocation?.args).toEqual(["-l", "JavaScript", "-e", MACOS_NATIVE_FILE_DIALOG_SCRIPT]);
    expect(JSON.parse(invocation?.stdin ?? "{}")).toEqual({
      mode: "open-directory",
      title: "Ordner wählen",
      defaultPath: "/Users/x",
      extensions: ["md", "txt"],
      filters: [{ name: "Docs", extensions: ["md", "txt"] }],
    });
  });

  it("passes user cancellation through as a typed success", async () => {
    const runner = captureRunner({ stdout: JSON.stringify({ cancelled: true, paths: [] }) }, []);
    await expect(
      createMacosNativeFileDialogAdapter(runner).open({ mode: "open-file" }),
    ).resolves.toEqual({
      cancelled: true,
      paths: [],
    });
  });
});

describe("Windows native dialog adapter", () => {
  it("invokes powershell.exe by absolute path with -NoProfile -STA -EncodedCommand", async () => {
    const captured: CapturedInvocation[] = [];
    const runner = captureRunner(
      { stdout: JSON.stringify({ cancelled: false, paths: ["C:\\repo"] }) },
      captured,
    );

    const result = await createWindowsNativeFileDialogAdapter(runner).open({
      mode: "open-directory",
      title: "Select folder",
      defaultPath: "C:\\repo",
    });

    expect(result).toEqual({ cancelled: false, paths: ["C:\\repo"] });
    const invocation = captured[0];
    expect(invocation?.command.endsWith("powershell.exe")).toBe(true);
    expect(invocation?.command).toContain("WindowsPowerShell");
    expect(invocation?.args.slice(0, 2)).toEqual(["-NoProfile", "-STA"]);
    expect(invocation?.args[2]).toBe("-EncodedCommand");
    const encoded = invocation?.args[3] ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(
      WINDOWS_NATIVE_FILE_DIALOG_SCRIPT,
    );
  });

  it("wraps the stdin config as base64 so the bytes stay codepage-independent", async () => {
    const captured: CapturedInvocation[] = [];
    const runner = captureRunner({}, captured);

    await createWindowsNativeFileDialogAdapter(runner).open({
      mode: "open-files",
      title: "Dateien wählen — Süß",
      filters: [{ name: "Images", extensions: ["png", "jpg"] }],
    });

    const decoded = Buffer.from(captured[0]?.stdin ?? "", "base64").toString("utf8");
    expect(JSON.parse(decoded)).toEqual({
      mode: "open-files",
      title: "Dateien wählen — Süß",
      defaultPath: "",
      extensions: ["png", "jpg"],
      filters: [{ name: "Images", extensions: ["png", "jpg"] }],
    });
  });
});

describe("Windows native folder picker foreground owner (issue #2151)", () => {
  // The BFF's PowerShell helper is a background process, so a modal dialog it opens WITHOUT an
  // owner window lands behind the browser that triggered it (Windows foreground lock) and the
  // user never sees it — they fall back to typing the path, i.e. "the previous version of the
  // folder search". The Windows FILE dialog already anchors to an invisible top-most owner form
  // (New-DialogOwner + ShowDialog($owner)); the FOLDER Common Item Dialog must do the same or it
  // opens behind the browser. Real Explorer behavior is not CI-verifiable (ADR-0118), so this
  // pins the script invariant the fix relies on — mirroring the picker-deletion characterization
  // test's approach for platform code CI cannot exercise.
  it("anchors the folder Common Item Dialog to a foreground owner, not IntPtr.Zero", () => {
    expect(WINDOWS_NATIVE_FILE_DIALOG_SCRIPT).not.toContain("dialog.Show(IntPtr.Zero)");
    expect(WINDOWS_NATIVE_FILE_DIALOG_SCRIPT).toContain("dialog.Show(owner)");
  });

  it("passes the invisible top-most owner window handle into the folder helper", () => {
    expect(WINDOWS_NATIVE_FILE_DIALOG_SCRIPT).toContain("$owner.Handle");
  });
});

describe("adapter failure mapping", () => {
  it("maps a timed-out helper to a typed timeout", async () => {
    const error = await adapterFailure(captureRunner({ timedOut: true }, []));
    expect(error.reason).toBe("timeout");
  });

  it("maps an exceeded output cap to a typed failure", async () => {
    const error = await adapterFailure(captureRunner({ outputExceeded: true }, []));
    expect(error.reason).toBe("failed");
  });

  it("maps a non-zero exit to a typed failure without leaking stderr", async () => {
    const error = await adapterFailure(
      captureRunner({ exitCode: 1, stderr: "SECRET /Users/private/path" }, []),
    );
    expect(error.reason).toBe("failed");
    expect(error.message).not.toContain("SECRET");
    expect(error.message).not.toContain("/Users/private");
  });

  it.each([
    ["not json at all"],
    ["[]"],
    ['{"cancelled":"yes","paths":[]}'],
    ['{"cancelled":false}'],
    ['{"cancelled":false,"paths":[42]}'],
    ['{"cancelled":false,"paths":[],"unexpected":"value"}'],
    ['{"cancelled":false,"paths":["/tmp/x"],"__proto__":{}}'],
  ])("maps malformed helper stdout %# to a typed failure", async (stdout) => {
    const error = await adapterFailure(captureRunner({ stdout }, []));
    expect(error.reason).toBe("failed");
  });

  it("rejects a helper that returns more paths than the selection cap", async () => {
    const paths = Array.from({ length: 201 }, (_, index) => `/tmp/file-${String(index)}`);
    const error = await adapterFailure(
      captureRunner({ stdout: JSON.stringify({ cancelled: false, paths }) }, []),
    );
    expect(error.reason).toBe("failed");
  });

  it("fails typed-unsupported on platforms without an adapter", async () => {
    await expect(
      createNativeFileDialogAdapter("linux").open({ mode: "open-file" }),
    ).rejects.toMatchObject({ name: "NativeFileDialogAdapterError", reason: "unsupported" });
  });

  it("dispatches darwin and win32 to their platform adapters", async () => {
    const captured: CapturedInvocation[] = [];
    const runner = captureRunner({}, captured);
    await createNativeFileDialogAdapter("darwin", runner).open({ mode: "open-file" });
    await createNativeFileDialogAdapter("win32", runner).open({ mode: "open-file" });
    expect(captured[0]?.command).toBe("/usr/bin/osascript");
    expect(captured[1]?.command.endsWith("powershell.exe")).toBe(true);
  });
});

// The real bounded runner, exercised with the Node binary itself so the tests stay hermetic and
// platform-neutral (no /bin/*, no shell, no network).
describe("runNativeDialogProcess", () => {
  it("delivers stdin to the child and captures stdout", async () => {
    const result = await runNativeDialogProcess(
      process.execPath,
      ["-e", "process.stdin.pipe(process.stdout)"],
      '{"echo":"süß"}',
      10_000,
    );
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe('{"echo":"süß"}');
  });

  it("terminates a hung child at the timeout", async () => {
    const result = await runNativeDialogProcess(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)"],
      "",
      150,
    );
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("caps runaway stdout and reports the overflow", async () => {
    const result = await runNativeDialogProcess(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(400 * 1024))"],
      "",
      10_000,
    );
    expect(result.outputExceeded).toBe(true);
  });

  it("truncates overflowing stdout to the byte cap, not the character cap, for non-ASCII content", async () => {
    // 100,000 copies of a 3-byte-UTF-8 BMP character: 100,000 UTF-16 code units but 300,000
    // bytes, comfortably past the 256 KiB cap while staying well under it in code-unit count.
    const result = await runNativeDialogProcess(
      process.execPath,
      ["-e", "process.stdout.write('日'.repeat(100000))"],
      "",
      10_000,
    );
    expect(result.outputExceeded).toBe(true);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(256 * 1024);
  });

  it("escalates to SIGKILL when the output cap is exceeded, without waiting for the interaction timeout", async () => {
    const startedAt = Date.now();
    const result = await runNativeDialogProcess(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); " +
          "process.stdout.write('x'.repeat(400 * 1024)); " +
          "setInterval(() => {}, 1000);",
      ],
      "",
      30_000,
    );
    expect(result.outputExceeded).toBe(true);
    // The interaction timeout (30s) never fired — the output-cap kill escalated on its own.
    expect(result.timedOut).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(8_000);
  }, 10_000);

  it("spawns the helper with a minimal, allowlisted environment instead of full inheritance", async () => {
    const sentinelName = "KEIKO_TEST_NATIVE_DIALOG_SECRET";
    vi.stubEnv(sentinelName, "super-secret-value");
    try {
      const result = await runNativeDialogProcess(
        process.execPath,
        ["-e", "process.stdout.write(JSON.stringify(process.env))"],
        "",
        10_000,
      );
      const childEnv = JSON.parse(result.stdout) as Record<string, string | undefined>;
      expect(childEnv[sentinelName]).toBeUndefined();
      expect(childEnv.PATH).toBeDefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reports a missing binary as exit 127 instead of throwing", async () => {
    const result = await runNativeDialogProcess(
      "/nonexistent/keiko-native-dialog-binary",
      [],
      "config that nobody reads",
      1_000,
    );
    expect(result.exitCode).toBe(127);
  });

  it("keeps stderr separate from stdout", async () => {
    const result = await runNativeDialogProcess(
      process.execPath,
      ["-e", "process.stderr.write('diagnostic'); process.stdout.write('payload')"],
      "",
      10_000,
    );
    expect(result.stdout).toBe("payload");
    expect(result.stderr).toBe("diagnostic");
  });
});
