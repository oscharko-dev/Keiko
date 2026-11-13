import { describe, expect, it, vi } from "vitest";
import { isServerInstanceId } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { SERVER_INSTANCE_ID } from "./server-instance.js";

describe("server instance identity (#4370)", () => {
  it("is a random 128-bit value that is stable within one process", async () => {
    expect(isServerInstanceId(SERVER_INSTANCE_ID)).toBe(true);
    const again = await import("./server-instance.js");
    expect(again.SERVER_INSTANCE_ID).toBe(SERVER_INSTANCE_ID);
  });

  it("differs after a restart, which is a fresh module evaluation", async () => {
    vi.resetModules();
    const restarted = await import("./server-instance.js");
    expect(isServerInstanceId(restarted.SERVER_INSTANCE_ID)).toBe(true);
    expect(restarted.SERVER_INSTANCE_ID).not.toBe(SERVER_INSTANCE_ID);
  });
});
