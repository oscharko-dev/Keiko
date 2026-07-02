import { describe, expect, it } from "vitest";
import { runLocalTesseractCommand } from "./local-knowledge-ocr-runtime.js";

const NODE_TIMEOUT_SCRIPT = "setTimeout(() => {}, 10_000);";

describe("runLocalTesseractCommand", () => {
  it("returns stdout for successful commands and unsupported-input for non-zero exits", async () => {
    const success = await runLocalTesseractCommand({
      command: process.execPath,
      args: ["-e", "process.stdin.pipe(process.stdout);"],
      stdin: new TextEncoder().encode("ocr text"),
      timeoutMs: 1_000,
    });

    expect(success.ok).toBe(true);
    if (success.ok) {
      expect(Buffer.from(success.stdout).toString("utf8")).toBe("ocr text");
    }

    await expect(
      runLocalTesseractCommand({
        command: process.execPath,
        args: ["-e", "process.stderr.write('bad image'); process.exit(2);"],
        stdin: new Uint8Array(),
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ ok: false, reason: "unsupported-input" });
  });

  it("maps aborted, timed out, and spawn-error runs to stable failure reasons", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      runLocalTesseractCommand({
        command: process.execPath,
        args: ["-e", NODE_TIMEOUT_SCRIPT],
        stdin: new Uint8Array(),
        timeoutMs: 1_000,
        signal: preAborted.signal,
      }),
    ).resolves.toEqual({ ok: false, reason: "timeout" });

    const timeout = await runLocalTesseractCommand({
      command: process.execPath,
      args: ["-e", NODE_TIMEOUT_SCRIPT],
      stdin: new Uint8Array(),
      timeoutMs: 10,
    });
    expect(timeout).toEqual({ ok: false, reason: "timeout" });

    const controller = new AbortController();
    const aborted = runLocalTesseractCommand({
      command: process.execPath,
      args: ["-e", NODE_TIMEOUT_SCRIPT],
      stdin: new Uint8Array(),
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(aborted).resolves.toEqual({ ok: false, reason: "timeout" });

    await expect(
      runLocalTesseractCommand({
        command: "__keiko_missing_tesseract_command__",
        args: [],
        stdin: new Uint8Array(),
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ ok: false, reason: "engine-error" });
  });
});
