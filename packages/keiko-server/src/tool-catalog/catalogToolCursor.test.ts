import { describe, expect, it } from "vitest";
import { catalogToolFixture } from "./__fixtures__/catalogToolFixture.js";
import {
  captureCursorBinding,
  issueCatalogCursor,
  consumeCatalogCursor,
} from "./catalogToolCursor.js";

function cursorFixture(): {
  fixture: ReturnType<typeof catalogToolFixture>;
  binding: ReturnType<typeof captureCursorBinding>;
} {
  const fixture = catalogToolFixture();
  return {
    fixture,
    binding: captureCursorBinding({
      toolRef: fixture.pure.descriptor.toolRef,
      requestDigest: "b".repeat(64),
      workspaceIdentity: fixture.context.workspaceIdentity,
      workspaceRevision: fixture.context.workspaceRevision,
      profile: fixture.pure.projection.profile,
      projectionDigest: fixture.pure.projection.projectionDigest,
      expiresAt: new Date(20_000).toISOString(),
      budgetReservationId: "reservation-1",
      nonce: "nonce-1",
      pageSequence: 1,
    }),
  };
}
describe("opaque catalog cursors on the existing invocation registry", () => {
  it("keeps only an opaque reference on the wire and consumes an exact private binding once", () => {
    const { fixture, binding } = cursorFixture();
    const token = issueCatalogCursor(
      fixture.options.invocationRegistry,
      fixture.context.runId,
      binding,
      "opaque-1",
      fixture.now(),
    );
    expect(token).toBe("opaque-1");
    expect(
      consumeCatalogCursor(
        fixture.options.invocationRegistry,
        fixture.context.runId,
        token,
        binding,
        fixture.now(),
      ),
    ).toEqual(binding);
    expect(() =>
      consumeCatalogCursor(
        fixture.options.invocationRegistry,
        fixture.context.runId,
        token,
        binding,
        fixture.now(),
      ),
    ).toThrow("Catalog dispatch rejected");
    fixture.options.invocationRegistry.dispose();
  });
  it.each([
    { workspaceIdentity: "other-workspace" },
    { workspaceRevision: "c".repeat(40) },
    { projectionDigest: "d".repeat(64) },
    { requestDigest: "e".repeat(64) },
    { budgetReservationId: "other-budget" },
    { pageSequence: 2 },
  ])("rejects a changed binding %j", (patch) => {
    const { fixture, binding } = cursorFixture();
    const token = issueCatalogCursor(
      fixture.options.invocationRegistry,
      fixture.context.runId,
      binding,
      "opaque-1",
      fixture.now(),
    );
    expect(() =>
      consumeCatalogCursor(
        fixture.options.invocationRegistry,
        fixture.context.runId,
        token,
        { ...binding, ...patch },
        fixture.now(),
      ),
    ).toThrow("Catalog dispatch rejected");
    fixture.options.invocationRegistry.dispose();
  });
  it("rejects tamper, cross-run use, expired cursors and revoked runs", () => {
    const { fixture, binding } = cursorFixture();
    issueCatalogCursor(
      fixture.options.invocationRegistry,
      fixture.context.runId,
      binding,
      "opaque-1",
      fixture.now(),
    );
    for (const [run, token, time] of [
      ["other-run", "opaque-1", 1000],
      [fixture.context.runId, "tampered", 1000],
      [fixture.context.runId, "opaque-1", 20_000],
    ] as const)
      expect(() =>
        consumeCatalogCursor(fixture.options.invocationRegistry, run, token, binding, time),
      ).toThrow("Catalog dispatch rejected");
    fixture.options.invocationRegistry.revokeRun(fixture.context.runId);
    expect(() =>
      consumeCatalogCursor(
        fixture.options.invocationRegistry,
        fixture.context.runId,
        "opaque-1",
        binding,
        1000,
      ),
    ).toThrow("Catalog dispatch rejected");
  });
  it("shares the existing bounded capacity instead of creating unbounded cursor storage", () => {
    const { fixture, binding } = cursorFixture();
    for (let i = 0; i < 8; i++)
      issueCatalogCursor(
        fixture.options.invocationRegistry,
        fixture.context.runId,
        binding,
        `opaque-${String(i)}`,
        fixture.now(),
      );
    expect(() =>
      issueCatalogCursor(
        fixture.options.invocationRegistry,
        fixture.context.runId,
        binding,
        "ninth",
        fixture.now(),
      ),
    ).toThrow("Catalog dispatch rejected");
    fixture.options.invocationRegistry.dispose();
  });
  it("rejects body fields, accessors and impossible expiry or sequence bounds", () => {
    const { binding } = cursorFixture();
    for (const patch of [
      { query: "secret" },
      { nonce: "" },
      { pageSequence: 0 },
      { pageSequence: 10001 },
      { expiresAt: "bad" },
    ])
      expect(() => captureCursorBinding({ ...binding, ...patch })).toThrow();
    let reads = 0;
    const getter = Object.defineProperty({ ...binding }, "workspaceIdentity", {
      enumerable: true,
      get: (): string => {
        reads++;
        return "private";
      },
    });
    expect(() => captureCursorBinding(getter)).toThrow();
    expect(reads).toBe(0);
  });
});
