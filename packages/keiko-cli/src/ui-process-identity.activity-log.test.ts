import { describe, expect, it, vi } from "vitest";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";

const readWindowsProcessCommandLine = vi.hoisted(() =>
  vi.fn<
    (pid: number, options: { readonly securityLogSink: SecurityLogSink }) => string | undefined
  >(() => undefined),
);

vi.mock("@oscharko-dev/keiko-security", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oscharko-dev/keiko-security")>()),
  readWindowsProcessCommandLine,
}));

const { liveProcessHasLaunchId } = await import("./ui-process-identity.js");

// #4351: the Windows process-identity query reports a slow or unavailable run to the sink of the
// command that asked. The CLI used to ask without one, so the line was lost as an unwired port.
// The query itself is replaced, so the proof is the same on every host: the sink the command holds
// is the sink the query receives.
describe("the Windows launch-identity check of the CLI", () => {
  it("hands the sink it was given to the process-identity query", () => {
    const securityLogSink: SecurityLogSink = { write: () => undefined };
    readWindowsProcessCommandLine.mockClear();
    const alive = liveProcessHasLaunchId(4711, "launch-id", {
      platform: "win32",
      readEnviron: () => undefined,
      securityLogSink,
    });
    expect(alive).toBe(false);
    expect(readWindowsProcessCommandLine).toHaveBeenCalledWith(4711, { securityLogSink });
  });
});
