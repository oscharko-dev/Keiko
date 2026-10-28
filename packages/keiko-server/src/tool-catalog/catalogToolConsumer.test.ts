import { describe, expect, it, vi } from "vitest";
import {
  TOOL_CATALOG_LIMITS,
  NATIVE_TOOL_CATALOG_RUNTIME,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  compileToolProjection,
  createKeikoToolCatalog,
  createToolDescriptor,
  createToolRef,
  opencodeRegistrationSet,
} from "@oscharko-dev/keiko-tool-catalog";
import type { CodingToolActionRequest } from "../coding-runtime/codingToolIpc.js";
import { declaration } from "./__fixtures__/catalogDefinition.js";
import { createCatalogBinding } from "./catalogToolBinder.js";
import { approveCatalogAction, captureHandlerAction } from "./catalogToolRuntimeAuthority.js";
import type { CatalogConsumer, CatalogConsumerPort } from "./catalogToolPorts.js";
import { codingCatalogConsumer } from "./catalogCodingConsumer.js";
import { catalogToolFixture } from "./__fixtures__/catalogToolFixture.js";
import { createCatalogToolBinder } from "./catalogToolDispatch.js";

describe("catalog consumer action codec", () => {
  it.each(["captureAction", "requiredEffects", "scope"])(
    "captures %s before a later replacement",
    async (member) => {
      const fixture = catalogToolFixture();
      const consumerPort = { ...codingCatalogConsumer };
      const binder = createCatalogToolBinder({ ...fixture.input, consumerPort }, fixture.options);
      try {
        Object.assign(consumerPort, { [member]: (): undefined => undefined });
        const offer = binder.offer();
        const result = await binder.dispatch(
          {
            kind: "bound",
            toolRef: offer.toolRefs[0],
            projectionDigest: offer.binding.projectionDigest,
            offerId: offer.offerId,
            arguments: { path: "fixture.ts" },
          },
          { actionId: "action-codec", idempotencyKey: "key-codec" },
        );
        expect(result).toMatchObject({ kind: "settled", result: { status: "completed" } });
      } finally {
        fixture.options.invocationRegistry.dispose();
      }
    },
  );
  it("retains the captured approval decoder through actual approval redemption", async () => {
    const fixture = catalogToolFixture();
    const consumerPort = { ...codingCatalogConsumer };
    fixture.preview.mockReturnValue({ ok: false, reason: "approval-required" });
    const binder = createCatalogToolBinder(
      {
        ...fixture.input,
        consumerPort,
        approvalPort: {
          available: () => true,
          request: (request) => {
            fixture.preview.mockReturnValue({ ok: true });
            return Promise.resolve(request);
          },
        },
      },
      fixture.options,
    );
    try {
      consumerPort.captureApprovedAction = (): undefined => undefined;
      const offer = binder.offer();
      const result = await binder.dispatch(
        {
          kind: "bound",
          toolRef: offer.toolRefs[0],
          projectionDigest: offer.binding.projectionDigest,
          offerId: offer.offerId,
          arguments: { path: "fixture.ts" },
        },
        { actionId: "action-approved-codec", idempotencyKey: "key-approved-codec" },
      );
      expect(result).toMatchObject({ kind: "settled", result: { status: "completed" } });
    } finally {
      fixture.options.invocationRegistry.dispose();
    }
  });
  it.each(
    ["scope", "requiredEffects", "captureAction", "captureApprovedAction"].flatMap((member) =>
      [undefined, 7].map((value) => ({ member, value })),
    ),
  )("rejects malformed $member=$value during binding", ({ member, value }) => {
    const fixture = catalogToolFixture();
    try {
      expect(() =>
        createCatalogToolBinder(
          {
            ...fixture.input,
            consumerPort: { ...codingCatalogConsumer, [member]: value },
          },
          fixture.options,
        ),
      ).toThrow("Invalid catalog handler binding");
    } finally {
      fixture.options.invocationRegistry.dispose();
    }
  });
});

describe("per-tool argument limits through consumer approval", () => {
  it("redeems approval and executes a real Coding edit above 256 KiB", async () => {
    const fixture = catalogToolFixture();
    const registration = opencodeRegistrationSet();
    const catalog = createKeikoToolCatalog([registration]);
    const descriptor = registration.entries.find(
      (entry) => entry.descriptor.toolRef.canonicalId === "keiko.changeset.edit",
    )?.descriptor;
    if (descriptor === undefined) throw new TypeError("Missing Coding edit descriptor");
    const changeset = {
      edits: [
        { file: "data.json", oldString: "", newString: "x".repeat(262_145), replaceAll: false },
      ],
      deletions: [],
      renames: [],
      files: [{ file: "data.json", expectedContentHash: "e".repeat(64) }],
      selectedFiles: ["data.json"],
    };
    const actionFor = (identity: {
      readonly actionId: string;
      readonly idempotencyKey: string;
    }): CodingToolActionRequest => ({ ...identity, action: "edit", changeset });
    const approved = vi.fn((request: CodingToolActionRequest) => {
      fixture.preview.mockReturnValue({ ok: true });
      return Promise.resolve(request);
    });
    const captureApprovedAction = vi.fn(codingCatalogConsumer.captureApprovedAction);
    const execute = vi.fn(
      (args: CatalogJsonValue, context: Parameters<typeof fixture.handler.execute>[1]) => {
        expect(context.beforeEffect()).toBe(true);
        expect(args).toEqual({ changeset });
        return Promise.resolve({
          data: { status: "completed", evidence: [] },
          page: { truncated: false, reason: "none" as const, cursor: null },
          resultCount: 1,
        });
      },
    );
    fixture.preview.mockReturnValue({ ok: false, reason: "approval-required" });
    const binder = createCatalogToolBinder(
      {
        ...fixture.input,
        consumerPort: { ...codingCatalogConsumer, captureApprovedAction },
        projection: compileToolProjection(catalog, registration.profile),
        handlerBindings: [
          {
            toolRef: descriptor.toolRef,
            descriptorDigest: descriptor.descriptorDigest,
            handlerId: descriptor.handlerRequirement.id,
            handlerVersion: descriptor.handlerRequirement.contractVersion,
            catalogAction: "keiko_changeset_edit",
            readiness: (): "ready" => "ready",
            previewAction: actionFor,
            actionFor: (_args, identity): CodingToolActionRequest => actionFor(identity),
            execute,
          },
        ],
        approvalPort: { available: () => true, request: approved },
      },
      { ...fixture.options, catalog },
    );
    try {
      const offer = binder.offerTool(descriptor.toolRef);
      const result = await binder.dispatch(
        {
          kind: "bound",
          toolRef: descriptor.toolRef,
          projectionDigest: offer.binding.projectionDigest,
          offerId: offer.offerId,
          arguments: { changeset },
        },
        { actionId: "large-approved-edit", idempotencyKey: "large-approved-edit" },
      );
      expect(approved).toHaveBeenCalledOnce();
      expect(captureApprovedAction).toHaveBeenCalledOnce();
      expect(captureApprovedAction.mock.results[0]?.value).toMatchObject({
        action: "edit",
        changeset,
      });
      expect(result).toMatchObject({ kind: "settled", result: { status: "completed" } });
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      fixture.options.invocationRegistry.dispose();
    }
  });

  it("keeps a generic MCP operation named edit under generic capture and approval limits", async () => {
    type ExternalAction = CatalogConsumer["action"] & {
      readonly operation: "edit";
      readonly content: string;
    };
    interface ExternalConsumer extends CatalogConsumer {
      readonly action: ExternalAction;
    }
    const fixture = catalogToolFixture();
    const descriptor = createToolDescriptor({
      ...declaration(),
      toolRef: createToolRef("keiko.mcp.fixture.edit", 1),
      effects: ["connector-access"],
      actionMapping: [{ action: "edit", effects: ["connector-access"] }],
      idempotency: "server-key-required",
    });
    const registration = {
      profile: { id: "mcp-edit-fixture", version: 1 },
      adapterDialect: { id: "gateway-json-schema", version: 1 },
      adapterRuntime: NATIVE_TOOL_CATALOG_RUNTIME,
      entries: [{ alias: "mcp_fixture_edit", descriptor }],
    };
    const catalog = createKeikoToolCatalog([registration]);
    const identity = { actionId: "mcp-edit", idempotencyKey: "mcp-edit" };
    let content = "small";
    const action = (): ExternalAction => ({ ...identity, operation: "edit", content });
    const capture = vi.fn((value: CatalogJsonValue): ExternalAction | undefined => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
      const record = value as Record<string, CatalogJsonValue>;
      return record.operation === "edit" && typeof record.content === "string"
        ? { ...identity, operation: "edit", content: record.content }
        : undefined;
    });
    const consumerPort: CatalogConsumerPort<ExternalConsumer> = {
      scope: (context) => ({ kind: "mcp", runId: context.runId }),
      staleReason: "consumer-stale",
      requiredEffects: () => ["connector-access"],
      captureAction: (_handler, value) => capture(value),
      captureApprovedAction: capture,
    };
    const execute = vi.fn();
    const binding = {
      ...fixture.handler,
      toolRef: descriptor.toolRef,
      descriptorDigest: descriptor.descriptorDigest,
      catalogAction: "edit",
      previewAction: action,
      actionFor: action,
      execute,
    };
    const state = createCatalogBinding<ExternalConsumer>(
      {
        consumerPort,
        projection: compileToolProjection(catalog, registration.profile),
        handlerBindings: [binding],
        authorityPort: {
          preview: () => ({ ok: false, reason: "approval-required" }),
          admit: () => ({ ok: true, mutationGuard: { check: (): boolean => true } }),
        },
        budgetPort: {
          available: () => true,
          reserve: () => ({ reservationId: "mcp-budget" }),
          check: () => true,
          commit: () => undefined,
          release: () => undefined,
        },
        approvalPort: { available: () => true, request: (request) => Promise.resolve(request) },
        logPort: fixture.input.logPort,
      },
      { ...fixture.options, catalog },
    );
    const handler = { descriptor, binding };
    try {
      expect(captureHandlerAction(consumerPort, handler, {}, identity)).toEqual(action());
      await expect(
        approveCatalogAction(state, action(), fixture.context, handler),
      ).resolves.toEqual(action());
      capture.mockClear();
      content = "x".repeat(TOOL_CATALOG_LIMITS.maxArgumentBytes + 1);
      expect(() => captureHandlerAction(consumerPort, handler, {}, identity)).toThrow(
        "input-bound",
      );
      await expect(approveCatalogAction(state, action(), fixture.context, handler)).rejects.toThrow(
        "input-bound",
      );
      expect(capture).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      fixture.options.invocationRegistry.dispose();
    }
  });
});
