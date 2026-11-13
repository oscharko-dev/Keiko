import { describe, expect, it, vi } from "vitest";
import { SERVER_INSTANCE_ID } from "./server-instance.js";

describe("server instance identity (#4370)", () => {
  it("is a random 128-bit value that is stable within one process", async () => {
    expect(SERVER_INSTANCE_ID).toMatch(/^[a-f0-9]{32}$/u);
    const again = await import("./server-instance.js");
    expect(again.SERVER_INSTANCE_ID).toBe(SERVER_INSTANCE_ID);
  });

  it("differs after a restart, which is a fresh module evaluation", async () => {
    vi.resetModules();
    const restarted = await import("./server-instance.js");
    expect(restarted.SERVER_INSTANCE_ID).toMatch(/^[a-f0-9]{32}$/u);
    expect(restarted.SERVER_INSTANCE_ID).not.toBe(SERVER_INSTANCE_ID);
  });

  it("is served by the health route so a page can recognize a restart", async () => {
    const { API_ROUTES } = await import("./routes.js");
    const route = API_ROUTES.find((entry) => entry.pattern === "/api/health");
    if (route === undefined) throw new Error("Missing health route");
    const result = await route.handler(
      {
        req: {} as never,
        res: {} as never,
        correlationId: undefined,
        params: {},
        url: new URL("http://127.0.0.1/api/health"),
      },
      { env: {} } as never,
    );
    const body = (result as { body: { instanceId?: string } }).body;
    expect(body.instanceId).toMatch(/^[a-f0-9]{32}$/u);
  });
});
