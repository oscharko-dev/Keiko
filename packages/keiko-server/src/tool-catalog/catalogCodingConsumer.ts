import {
  captureCatalogJson,
  createKeikoToolCatalog,
  nativeTextSnapshotRegistrationSet,
  verifyToolDescriptor,
} from "@oscharko-dev/keiko-tool-catalog";
import type {
  CatalogJsonObject,
  CatalogJsonValue,
  CatalogProfile,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import {
  codingToolRequiredActionClasses,
  parseCodingToolRequest,
  type CodingToolActionRequest,
} from "../coding-runtime/codingToolIpc.js";
import type {
  CatalogTrustedContext,
  CatalogBoundHandler,
  CatalogConsumerPort,
  CatalogToolExecutionOverride,
} from "./catalogToolPorts.js";
import { CatalogDispatchFault, requireDispatch } from "./catalogToolErrors.js";
import { sameRef } from "./catalogToolRequest.js";

const NATIVE_READ_REGISTRATION = nativeTextSnapshotRegistrationSet("invocation");
const NATIVE_READ_DESCRIPTOR = NATIVE_READ_REGISTRATION.entries[0]?.descriptor;
const NATIVE_READ_PROFILE = createKeikoToolCatalog([NATIVE_READ_REGISTRATION]).profiles[0];
function captureHandlerRequest(
  handler: CatalogBoundHandler,
  captured: CatalogJsonValue,
  executionOverride: CatalogToolExecutionOverride | undefined,
  profile: CatalogProfile | undefined,
): CodingToolActionRequest | undefined {
  const capture = executionOverride?.captureNativeReadAction;
  if (capture === undefined)
    return parseCodingToolRequest(
      JSON.stringify(captured),
      handler.descriptor.bounds.maxArgumentBytes,
    );
  requireNativeReadHandler(handler, profile);
  return captureUnchangedNativeReadAction(capture, captured);
}

function requireNativeReadHandler(
  handler: CatalogBoundHandler,
  profile: CatalogProfile | undefined,
): void {
  verifyNativeReadDescriptor(handler);
  const descriptor = NATIVE_READ_DESCRIPTOR;
  requireDispatch(descriptor !== undefined, "failed", "handler-mismatch");
  requireDispatch(
    profile !== undefined &&
      NATIVE_READ_PROFILE !== undefined &&
      canonicalise(captureCatalogJson(profile)) === canonicalise(NATIVE_READ_PROFILE),
    "failed",
    "handler-mismatch",
  );
  requireDispatch(
    sameRef(handler.descriptor.toolRef, descriptor.toolRef) &&
      handler.descriptor.descriptorDigest === descriptor.descriptorDigest &&
      handler.binding?.descriptorDigest === descriptor.descriptorDigest &&
      handler.binding.handlerId === descriptor.handlerRequirement.id &&
      handler.binding.handlerVersion === descriptor.handlerRequirement.contractVersion &&
      handler.binding.catalogAction === descriptor.actionMapping[0]?.action,
    "failed",
    "handler-mismatch",
  );
}

function verifyNativeReadDescriptor(handler: CatalogBoundHandler): void {
  try {
    verifyToolDescriptor(handler.descriptor);
  } catch (error) {
    throw new CatalogDispatchFault("failed", "handler-mismatch", error);
  }
}

function captureUnchangedNativeReadAction(
  capture: NonNullable<CatalogToolExecutionOverride["captureNativeReadAction"]>,
  captured: CatalogJsonValue,
): CodingToolActionRequest | undefined {
  const expected = canonicalise(captured);
  const request = capture(deepFreeze(captured));
  const data = request === undefined ? undefined : captureCatalogJson(request);
  requireDispatch(
    data !== undefined &&
      typeof data === "object" &&
      data !== null &&
      !Array.isArray(data) &&
      (data as CatalogJsonObject).action === "read" &&
      canonicalise(data) === expected,
    "failed",
    "handler-mismatch",
  );
  return request;
}

/** Existing Coding action codec and native-read exception, injected into the common binder. */
export const codingCatalogConsumer: CatalogConsumerPort = Object.freeze({
  scope: (context: CatalogTrustedContext): CatalogJsonObject => ({
    kind: "coding",
    workspaceRoot: context.workspaceRoot,
    workspaceIdentity: context.workspaceIdentity,
    workspaceRevision: context.workspaceRevision,
  }),
  staleReason: "workspace-stale",
  requiredEffects: codingToolRequiredActionClasses,
  captureAction: captureHandlerRequest,
  captureApprovedAction: (value: CatalogJsonValue): CodingToolActionRequest | undefined =>
    parseCodingToolRequest(JSON.stringify(value), 262_144),
});
