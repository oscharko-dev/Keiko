// Windows keeps an exited helper's file open for a moment, so removing its private copy can be
// refused transiently (EPERM, EBUSY). The removal retries within a fixed bound; only a copy that
// stays is a failure.
import { describe, expect, it } from "vitest";

import { removeHelperCopyDirectory } from "./nativeRuntimeProcessBackend.js";

function refusal(code: string): Error {
  return Object.assign(new Error("refused"), { code });
}

describe("removeHelperCopyDirectory", () => {
  it.each(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"])(
    "retries a transient %s refusal and then succeeds",
    async (code) => {
      const waits: number[] = [];
      let attempts = 0;
      await removeHelperCopyDirectory("copy", {
        remove: () => {
          attempts += 1;
          return attempts === 1 ? Promise.reject(refusal(code)) : Promise.resolve();
        },
        sleep: (milliseconds) => {
          waits.push(milliseconds);
          return Promise.resolve();
        },
      });
      expect(attempts).toBe(2);
      expect(waits).toEqual([50]);
    },
  );

  it("gives up with the original error after a bounded number of attempts", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const error = refusal("EPERM");
    await expect(
      removeHelperCopyDirectory("copy", {
        remove: () => {
          attempts += 1;
          return Promise.reject(error);
        },
        sleep: (milliseconds) => {
          waits.push(milliseconds);
          return Promise.resolve();
        },
      }),
    ).rejects.toBe(error);
    expect(attempts).toBe(6);
    expect(waits).toEqual([50, 100, 200, 400, 800]);
  });

  it("does not retry a refusal that is not transient", async () => {
    let attempts = 0;
    const error = refusal("EIO");
    await expect(
      removeHelperCopyDirectory("copy", {
        remove: () => {
          attempts += 1;
          return Promise.reject(error);
        },
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toBe(error);
    expect(attempts).toBe(1);
  });
});
