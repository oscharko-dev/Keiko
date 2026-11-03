import { expect, it, vi } from "vitest";
import { createManagedProviderCatalog } from "./managedProviderCatalog.js";

const ports = vi.hoisted(() => ({ admit: vi.fn(), close: vi.fn() }));
vi.mock("@oscharko-dev/keiko-mcp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oscharko-dev/keiko-mcp")>()),
  createManagedMcpHost: (): typeof ports => ports,
}));

it("preserves admission failure when managed-host cleanup also rejects", async () => {
  const diagnostics = { record: vi.fn() };
  const admission = new TypeError("admission refused");
  ports.admit.mockRejectedValueOnce(admission);
  ports.close.mockRejectedValueOnce(new Error("cleanup failed"));
  await expect(
    createManagedProviderCatalog({
      providers: [],
      routes: [],
      profile: { id: "cleanup-fixture", version: 1 },
      log: {
        diagnostics,
        primary: {
          write(): void {
            /* no content retained */
          },
        },
      },
      correlationId: "managed-cleanup",
      now: () => 0,
    }),
  ).rejects.toBe(admission);
  expect(ports.close).toHaveBeenCalledOnce();
  expect(diagnostics.record).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(diagnostics.record.mock.calls)).not.toContain("admission refused");
  expect(JSON.stringify(diagnostics.record.mock.calls)).not.toContain("cleanup failed");
});
