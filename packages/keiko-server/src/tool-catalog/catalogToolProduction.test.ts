/**
 * SCOPE (#3413 F8 review, findings b1-1/AC10): this file proves `createCatalogToolBinder` composes
 * correctly with a REAL domain handler and a REAL authority port in isolation -- mode coverage,
 * approval consumption, hard denials, and revocation. It does NOT prove that composition is
 * reachable from an actual server request: production traffic never constructs a
 * `CatalogToolBinder` (see catalogToolFacadeBridge.ts's header and ADR-0175 D6 "Production
 * mounting" for the decision record). The equivalent real-request-reachable coverage for the
 * bridge's own construction/dispatch behaviour lives in catalogToolFacadeBridge.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingToolActionRequest } from "../coding-runtime/codingToolIpc.js";
import { codingToolApprovalBindingDigest } from "../coding-runtime/codingToolApprovalBridge.js";
import { createCodingRepositorySearchHandler } from "../coding-runtime/codingRepositorySearchHandler.js";
import { createCatalogToolBinder } from "./catalogToolDispatch.js";
import { catalogRuntimeFixture, RUNTIME_NOW } from "./__fixtures__/catalogRuntimeFixture.js";
import type {
  CatalogActionIdentity,
  CatalogToolHandlerBinding,
  CatalogHandlerResult,
} from "./catalogToolPorts.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const ID = { actionId: "action-1", idempotencyKey: "key-1" };
function registration(
  fixture: ReturnType<typeof catalogRuntimeFixture>,
  id: string,
): CatalogToolHandlerBinding {
  const descriptor = fixture.options.catalog.descriptors.find(
    (value) => value.toolRef.canonicalId === id,
  );
  if (descriptor === undefined) throw new TypeError("Expected real catalog descriptor");
  const action = (identity: CatalogActionIdentity): CodingToolActionRequest =>
    id === "keiko.command.run"
      ? { action: "command", commandId: "test", ...identity }
      : { action: "read", relativePath: "fixture.ts", ...identity };
  return {
    ...fixture.handler,
    toolRef: descriptor.toolRef,
    descriptorDigest: descriptor.descriptorDigest,
    handlerId: descriptor.handlerRequirement.id,
    handlerVersion: descriptor.handlerRequirement.contractVersion,
    catalogAction: descriptor.actionMapping[0]?.action ?? "",
    previewAction: action,
    actionFor: (_args, identity): CodingToolActionRequest => action(identity),
    execute: (_args, context): Promise<CatalogHandlerResult> => {
      if (!context.beforeEffect()) throw new TypeError("Effect denied");
      return Promise.resolve({
        data: "bounded-result",
        page: { truncated: false, reason: "none", cursor: null },
        resultCount: 1,
      });
    },
  };
}
function invocation(
  fixture: ReturnType<typeof catalogRuntimeFixture>,
  binder: ReturnType<typeof createCatalogToolBinder>,
  id: string,
): object {
  const offer = binder.offer();
  const ref = fixture.options.catalog.descriptors.find(
    (descriptor) => descriptor.toolRef.canonicalId === id,
  )?.toolRef;
  return {
    kind: "bound",
    toolRef: ref,
    projectionDigest: offer.binding.projectionDigest,
    offerId: offer.offerId,
    arguments: id === "keiko.command.run" ? { command: "test" } : { path: "fixture.ts" },
  };
}
describe("catalog production authority and domain-owner composition", () => {
  it.each(["governed-assist", "supervised-coding", "autonomous-delivery"] as const)(
    "reads through the real H1 owner with genuinely minted %s authority",
    async (mode) => {
      const fixture = catalogRuntimeFixture(mode);
      cleanups.push(fixture.dispose);
      const delegate = createCodingRepositorySearchHandler({
        workspace: {
          root: fixture.root,
          selectedRoot: fixture.root,
          name: "fixture",
          version: "1",
          testFramework: "vitest",
          sourceDirs: [],
          testDirs: [],
          languages: ["typescript"],
          ignoreLines: [],
        },
        isCurrent: () => true,
        nowMs: fixture.now,
        log: fixture.primary,
      });
      const binding: CatalogToolHandlerBinding = {
        ...registration(fixture, "keiko.file.read"),
        execute: async (_args, context): Promise<CatalogHandlerResult> => {
          if (!context.beforeEffect()) throw new TypeError("Effect denied");
          const result = await delegate.invoke(
            { kind: "read", path: "fixture.ts", startLine: 1, endLine: 1, maxBytes: 1024 },
            context,
          );
          if (!result.ok || result.kind !== "read")
            throw new TypeError("Expected H1 repository read");
          return {
            data: result.excerpt.snippet,
            page: { truncated: false, reason: "none", cursor: null },
            resultCount: 1,
          };
        },
      };
      const binder = createCatalogToolBinder(
        { ...fixture.input, handlerBindings: [binding] },
        fixture.options,
      );
      const outcome = await binder.dispatch(invocation(fixture, binder, "keiko.file.read"), ID);
      expect(outcome.kind === "settled" && outcome.result).toMatchObject({
        status: "completed",
        data: "export const valid = true;",
      });
      expect(fixture.primary.events.map((event) => event.op)).toContain(
        "coding-repository-handler.settled",
      );
      expect(JSON.stringify(fixture.primary.events)).not.toContain(
        fixture.minted.toolFacadeCapability,
      );
    },
  );
  it("consumes a real scoped supervised approval exactly once after non-consuming offer preview", async () => {
    const fixture = catalogRuntimeFixture("supervised-coding");
    cleanups.push(fixture.dispose);
    const consume = vi.spyOn(fixture.approval, "consume");
    const request = vi.fn((action: CodingToolActionRequest): Promise<CodingToolActionRequest> => {
      if (action.action !== "command") throw new TypeError("Expected command approval");
      const proof = {
        approvalId: action.actionId,
        approvalDigest: codingToolApprovalBindingDigest("run-1", action),
      };
      expect(
        fixture.approval.observePermission({
          runId: "run-1",
          requestId: "permission-1",
          action: "command",
          actionId: action.actionId,
          idempotencyKey: action.idempotencyKey,
          targetId: action.commandId,
          proof,
          expiresAt: fixture.trusted.expiresAt,
          nowMs: Date.parse(RUNTIME_NOW),
        }),
      ).toBe(true);
      expect(
        fixture.approval.activatePermission({
          runId: "run-1",
          requestId: "permission-1",
          approvalAuthorityDigest: "c".repeat(64),
          expiresAtMs: Date.parse(fixture.trusted.expiresAt),
          nowMs: Date.parse(RUNTIME_NOW),
        }),
      ).toBe(true);
      return Promise.resolve({ ...action, approvalProof: proof });
    });
    const binder = createCatalogToolBinder(
      {
        ...fixture.input,
        handlerBindings: [registration(fixture, "keiko.command.run")],
        approvalPort: { available: () => true, request },
      },
      fixture.options,
    );
    const input = invocation(fixture, binder, "keiko.command.run");
    expect(consume).not.toHaveBeenCalled();
    const outcome = await binder.dispatch(input, ID);
    expect(outcome.kind === "settled" && outcome.result.status).toBe("completed");
    expect(consume).toHaveBeenCalledOnce();
    expect((await binder.dispatch(input, ID)).kind).toBe("replayed");
    expect(request).toHaveBeenCalledOnce();
    expect(consume).toHaveBeenCalledOnce();
  });
  it("does not turn the production Ask command hard denial into an approval request", () => {
    const fixture = catalogRuntimeFixture("governed-assist");
    cleanups.push(fixture.dispose);
    const request = vi.fn();
    const binder = createCatalogToolBinder(
      {
        ...fixture.input,
        handlerBindings: [registration(fixture, "keiko.command.run")],
        approvalPort: { available: () => true, request },
      },
      fixture.options,
    );
    expect(binder.offer().toolRefs).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
  it("denies a revoked genuine authority before reaching its domain handler", async () => {
    const fixture = catalogRuntimeFixture("autonomous-delivery");
    cleanups.push(fixture.dispose);
    const execute = vi.fn(registration(fixture, "keiko.file.read").execute);
    const binder = createCatalogToolBinder(
      {
        ...fixture.input,
        handlerBindings: [{ ...registration(fixture, "keiko.file.read"), execute }],
      },
      fixture.options,
    );
    const input = invocation(fixture, binder, "keiko.file.read");
    fixture.registry.revoke(fixture.minted.authorityRef);
    const result = await binder.dispatch(input, ID);
    expect(result.kind === "settled" && result.result.status).toBe("denied");
    expect(execute).not.toHaveBeenCalled();
  });
  it("revalidates genuine authority before revealing a retained invocation receipt", async () => {
    const fixture = catalogRuntimeFixture("autonomous-delivery");
    cleanups.push(fixture.dispose);
    const binder = createCatalogToolBinder(
      { ...fixture.input, handlerBindings: [registration(fixture, "keiko.file.read")] },
      fixture.options,
    );
    const input = invocation(fixture, binder, "keiko.file.read");
    expect((await binder.dispatch(input, ID)).kind).toBe("settled");
    fixture.registry.revoke(fixture.minted.authorityRef);
    const replay = await binder.dispatch(input, ID);
    expect(replay.kind === "settled" && replay.result.status).toBe("denied");
  });
});
