import { describe, expect, it, vi } from "vitest";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";

const liveProcessHasLaunchId = vi.hoisted(() =>
  vi.fn<
    (
      pid: number,
      launchId: string,
      options: { readonly securityLogSink?: SecurityLogSink },
    ) => boolean
  >(() => true),
);

vi.mock("./ui-process-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ui-process-identity.js")>()),
  liveProcessHasLaunchId,
}));

const { launchIdentityVerifier } = await import("./lifecycle.js");

// #4351: the launch-identity check of a tracked UI process used to read the process without the
// command's sink, so its slow or unavailable Windows query was lost as an unwired port.
describe("the launch-identity check of a tracked UI process", () => {
  it("reads the process through the command's own sink", () => {
    const securityLogSink: SecurityLogSink = { write: () => undefined };
    liveProcessHasLaunchId.mockClear();
    expect(launchIdentityVerifier({ securityLogSink })(4711, "launch-id")).toBe(true);
    expect(liveProcessHasLaunchId).toHaveBeenCalledWith(4711, "launch-id", { securityLogSink });
  });

  it("lets a test seam replace the whole check", () => {
    const verifyLaunchIdentity = vi.fn(() => false);
    expect(
      launchIdentityVerifier({ verifyLaunchIdentity, securityLogSink: undefined })(1, "x"),
    ).toBe(false);
    expect(verifyLaunchIdentity).toHaveBeenCalledWith(1, "x");
  });
});
