import { describe, expect, it, vi } from "vitest";
import {
  createKeikoToolCatalog,
  compileToolProjection,
  lookupCatalogTool,
  nativeTextSnapshotRegistrationSet,
} from "@oscharko-dev/keiko-tool-catalog";
import type { CodingToolActionRequest } from "../coding-runtime/codingToolIpc.js";
import type { CatalogBoundHandler } from "./catalogToolBinder.js";
import type { CatalogToolExecutionOverride } from "./catalogToolPorts.js";
import { captureHandlerAction } from "./catalogToolRuntimeAuthority.js";

function nativeCaptureFixture(): {
  readonly handler: CatalogBoundHandler;
  readonly profile: ReturnType<typeof createKeikoToolCatalog>["profiles"][number];
  readonly request: Extract<CodingToolActionRequest, { readonly action: "read" }>;
  readonly identity: { readonly actionId: string; readonly idempotencyKey: string };
  readonly capture: ReturnType<typeof vi.fn>;
  readonly override: CatalogToolExecutionOverride;
  readonly execute: ReturnType<typeof vi.fn>;
} {
  const set = nativeTextSnapshotRegistrationSet("invocation");
  const catalog = createKeikoToolCatalog([set]);
  const projection = compileToolProjection(catalog, set.profile);
  const ref = projection.tools[0]?.toolRef;
  const descriptor = ref === undefined ? undefined : lookupCatalogTool(catalog, ref);
  const profile = catalog.profiles[0];
  if (descriptor === undefined || profile === undefined)
    throw new TypeError("Missing native profile");
  const identity = { actionId: "original-read", idempotencyKey: "original-read" };
  const request = {
    ...identity,
    action: "read" as const,
    relativePath: "long-segment/".repeat(50) + "é.ts",
  };
  const capture = vi.fn(() => request);
  const execute = vi.fn(() =>
    Promise.resolve({
      data: {},
      resultCount: 1,
      page: { truncated: false, reason: "none" as const, cursor: null },
    }),
  );
  const handler: CatalogBoundHandler = {
    descriptor,
    binding: {
      toolRef: descriptor.toolRef,
      descriptorDigest: descriptor.descriptorDigest,
      handlerId: descriptor.handlerRequirement.id,
      handlerVersion: descriptor.handlerRequirement.contractVersion,
      catalogAction: descriptor.actionMapping[0]?.action ?? "read",
      readiness: () => "ready",
      previewAction: () => request,
      actionFor: () => request,
      execute,
    },
  };
  return {
    handler,
    profile,
    request,
    identity,
    capture,
    execute,
    override: {
      toolRef: descriptor.toolRef,
      actionFor: () => request,
      execute,
      captureNativeReadAction: capture,
    },
  };
}

describe("exact private original Read handler action capture", () => {
  it("keeps the unchanged public handler capture refusing the same legal native target", () => {
    const f = nativeCaptureFixture();
    const { captureNativeReadAction: _capture, ...ordinary } = f.override;
    expect(() => captureHandlerAction(f.handler, {}, f.identity, ordinary, f.profile)).toThrow(
      "Catalog dispatch rejected",
    );
    expect(f.capture).not.toHaveBeenCalled();
  });

  it("uses the server codec only on the actual private profile and exact descriptor", () => {
    const f = nativeCaptureFixture();
    expect(captureHandlerAction(f.handler, {}, f.identity, f.override, f.profile)).toEqual(
      f.request,
    );
    expect(f.capture).toHaveBeenCalledOnce();
    expect(Object.isFrozen(f.request)).toBe(true);
  });

  it.each([
    "profile",
    "profile-content",
    "descriptor",
    "copied",
    "handler",
    "version",
    "role",
    "override",
  ] as const)("refuses copied/forged %s before calling the private producer", (fault) => {
    const f = nativeCaptureFixture();
    const binding = f.handler.binding;
    if (binding === undefined) throw new TypeError("Expected actual native binding");
    let handler = f.handler,
      profile = f.profile,
      override = f.override;
    if (fault === "profile") profile = { ...profile, profile: { id: "opencode", version: 1 } };
    else if (fault === "profile-content")
      profile = { ...profile, nativeExtensions: [{ alias: "execute", contractVersion: 1 }] };
    else if (fault === "descriptor")
      handler = {
        ...handler,
        descriptor: {
          ...handler.descriptor,
          descriptorDigest: "a".repeat(64) as typeof handler.descriptor.descriptorDigest,
        },
      };
    else if (fault === "copied")
      handler = {
        ...handler,
        descriptor: { ...handler.descriptor, effects: ["workspace-write"] },
      };
    else if (fault === "role")
      handler = {
        ...handler,
        binding: { ...binding, catalogAction: "edit" },
      };
    else if (fault === "handler")
      handler = {
        ...handler,
        binding: {
          ...binding,
          handlerId: "ordinary-read-port",
        },
      };
    else if (fault === "version")
      handler = {
        ...handler,
        binding: {
          ...binding,
          handlerVersion: 2,
        },
      };
    else
      override = {
        ...override,
        toolRef: {
          ...override.toolRef,
          canonicalId: "keiko.workspace.read" as typeof override.toolRef.canonicalId,
        },
      };
    expect(() => captureHandlerAction(handler, {}, f.identity, override, profile)).toThrow(
      "Catalog dispatch rejected",
    );
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(["path", "identity", "effect"] as const)(
    "refuses a private codec changing the captured %s rather than validating it",
    (fault) => {
      const f = nativeCaptureFixture();
      const changed: CodingToolActionRequest =
        fault === "effect"
          ? { action: "git", operation: "read", ...f.identity }
          : {
              ...f.request,
              ...(fault === "path" ? { relativePath: "other.ts" } : { actionId: "changed" }),
            };
      const capture = vi.fn(() => changed);
      expect(() =>
        captureHandlerAction(
          f.handler,
          {},
          f.identity,
          { ...f.override, captureNativeReadAction: capture },
          f.profile,
        ),
      ).toThrow("Catalog dispatch rejected");
      expect(capture).toHaveBeenCalledOnce();
    },
  );
});

it("owns the captured target before the private codec and refuses response accessors without invoking them", () => {
  const f = nativeCaptureFixture();
  const mutating = vi.fn((value: unknown) => {
    Object.assign(value as object, { relativePath: "changed.ts" });
    return f.request;
  });
  expect(() =>
    captureHandlerAction(
      f.handler,
      {},
      f.identity,
      { ...f.override, captureNativeReadAction: mutating },
      f.profile,
    ),
  ).toThrow();
  expect(f.request.relativePath).toContain("long-segment/");
  const getter = vi.fn(() => "read");
  const accessor = Object.defineProperty({ ...f.request }, "action", { get: getter });
  expect(() =>
    captureHandlerAction(
      f.handler,
      {},
      f.identity,
      { ...f.override, captureNativeReadAction: () => accessor },
      f.profile,
    ),
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
});
