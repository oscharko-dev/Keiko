import { afterEach, describe, expect, it, vi } from "vitest";

import type { CliIo } from "./runner.js";

interface Captured {
  readonly io: CliIo;
  readonly err: () => string;
}

function captureIo(): Captured {
  const errChunks: string[] = [];
  return {
    io: {
      out: (): void => undefined,
      err: (text: string): void => {
        errChunks.push(text);
      },
    },
    err: (): string => errChunks.join(""),
  };
}

// The runner is re-imported after each mock, so the error class must come from the same fresh
// module graph the runner resolves; a class from the first graph would not be `instanceof`-equal.
async function freshSafeArtifactError(kind: string): Promise<Error> {
  const { SafeArtifactFileError } = await import("@oscharko-dev/keiko-security");
  return new SafeArtifactFileError("activity-log", kind);
}

describe("CLI safe-artifact failure boundary", () => {
  afterEach(() => {
    vi.doUnmock("./ui.js");
    vi.doUnmock("./init.js");
    vi.resetModules();
  });

  it("reports the closed kind when the UI launch cannot open its Activity Log", async () => {
    vi.resetModules();
    const failure = await freshSafeArtifactError("open-failed");
    vi.doMock("./ui.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./ui.js")>()),
      runUiCli: (): Promise<number> => Promise.reject(failure),
    }));
    const { runCli } = await import("./runner.js");
    const captured = captureIo();

    await expect(runCli(["ui"], captured.io)).resolves.toBe(1);
    expect(captured.err()).toContain(
      "keiko: activity-log safe-artifact failure: open-failed. " +
        "See docs/troubleshooting/README.md.\n",
    );
  });

  it("reports a synchronous safe-artifact failure and rethrows every other error", async () => {
    vi.resetModules();
    const failure: { error: Error } = { error: await freshSafeArtifactError("unsafe-target") };
    vi.doMock("./init.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./init.js")>()),
      runInitCli: (): number => {
        throw failure.error;
      },
    }));
    const { runCli } = await import("./runner.js");
    const captured = captureIo();

    expect(runCli(["init"], captured.io)).toBe(1);
    expect(captured.err()).toBe(
      "keiko: activity-log safe-artifact failure: unsafe-target. " +
        "See docs/troubleshooting/README.md.\n",
    );

    failure.error = new Error("unrelated defect");
    expect(() => runCli(["init"], captured.io)).toThrow("unrelated defect");
  });
});
