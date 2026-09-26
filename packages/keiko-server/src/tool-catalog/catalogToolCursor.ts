import { Buffer } from "node:buffer";
import { captureCatalogJson, createToolRef } from "@oscharko-dev/keiko-tool-catalog";
import type {
  CatalogDigest,
  CatalogJsonObject,
  CatalogVersionRef,
  ToolRef,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import type { CodingToolInvocationRegistry } from "../coding-runtime/codingToolInvocationRegistry.js";
import { CatalogDispatchFault, requireDispatch } from "./catalogToolRuntimeAuthority.js";

export interface CursorBinding {
  readonly toolRef: ToolRef;
  readonly requestDigest: CatalogDigest;
  readonly workspaceIdentity: string;
  readonly workspaceRevision: string;
  readonly profile: CatalogVersionRef;
  readonly projectionDigest: CatalogDigest;
  readonly expiresAt: string;
  readonly budgetReservationId: string;
  readonly nonce: string;
  readonly pageSequence: number;
}
export const CATALOG_CURSOR_ID_PREFIX = "catalog-cursor-";
const KEYS = [
  "toolRef",
  "requestDigest",
  "workspaceIdentity",
  "workspaceRevision",
  "profile",
  "projectionDigest",
  "expiresAt",
  "budgetReservationId",
  "nonce",
  "pageSequence",
]
  .sort((left, right) => left.localeCompare(right))
  .join();
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
function object(value: unknown): CatalogJsonObject {
  requireDispatch(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "invalid",
    "cursor-invalid",
  );
  return value as CatalogJsonObject;
}
function scalarFields(value: CatalogJsonObject): void {
  requireDispatch(
    [value.requestDigest, value.projectionDigest].every(
      (digest) => typeof digest === "string" && DIGEST.test(digest),
    ),
    "invalid",
    "cursor-invalid",
  );
  requireDispatch(
    [
      value.workspaceIdentity,
      value.workspaceRevision,
      value.budgetReservationId,
      value.nonce,
    ].every((id) => typeof id === "string" && /^[A-Za-z0-9_.-]{1,128}$/u.test(id)),
    "invalid",
    "cursor-invalid",
  );
  requireDispatch(
    typeof value.expiresAt === "string" &&
      Number.isSafeInteger(Date.parse(value.expiresAt)) &&
      new Date(value.expiresAt).toISOString() === value.expiresAt,
    "invalid",
    "cursor-invalid",
  );
  requireDispatch(
    typeof value.pageSequence === "number" &&
      Number.isSafeInteger(value.pageSequence) &&
      value.pageSequence >= 1 &&
      value.pageSequence <= 10_000,
    "invalid",
    "cursor-invalid",
  );
}
function identityFields(value: CatalogJsonObject): void {
  const ref = object(value.toolRef);
  requireDispatch(
    Object.keys(ref)
      .sort((left, right) => left.localeCompare(right))
      .join() === "canonicalId,contractVersion" &&
      typeof ref.canonicalId === "string" &&
      typeof ref.contractVersion === "number",
    "invalid",
    "cursor-invalid",
  );
  createToolRef(ref.canonicalId, ref.contractVersion);
  const profile = object(value.profile);
  requireDispatch(
    Object.keys(profile).sort(compareStrings).join() === "id,version" &&
      typeof profile.id === "string" &&
      /^[a-z][a-z0-9.-]{0,63}$/u.test(profile.id) &&
      typeof profile.version === "number" &&
      Number.isSafeInteger(profile.version) &&
      profile.version > 0,
    "invalid",
    "cursor-invalid",
  );
}
export function captureCursorBinding(source: unknown): CursorBinding {
  try {
    const value = object(captureCatalogJson(source, 4096));
    requireDispatch(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right))
        .join() === KEYS,
      "invalid",
      "cursor-invalid",
    );
    scalarFields(value);
    identityFields(value);
    return deepFreeze(value) as unknown as CursorBinding;
  } catch (error) {
    if (error instanceof CatalogDispatchFault) throw error;
    throw new CatalogDispatchFault("invalid", "cursor-invalid");
  }
}
function identity(
  runId: string,
  token: string,
): { runId: string; actionId: string; idempotencyKey: string } {
  requireDispatch(TOKEN.test(token), "invalid", "cursor-invalid");
  const id = `${CATALOG_CURSOR_ID_PREFIX}${sha256Hex(canonicalise({ domain: "keiko.tool-cursor-reference.v1", token }))}`;
  return { runId, actionId: id, idempotencyKey: id };
}
function bindingDigest(binding: CursorBinding): string {
  return sha256Hex(canonicalise({ domain: "keiko.tool-cursor.v1", ...binding }));
}
function assertUnexpired(binding: CursorBinding, now: number): void {
  requireDispatch(
    Number.isSafeInteger(now) && Date.parse(binding.expiresAt) > now,
    "invalid",
    "cursor-expired",
  );
}
/** Cursor entries share all existing live/aggregate/TTL/revocation limits; no live entry is evicted. */
export function issueCatalogCursor(
  registry: CodingToolInvocationRegistry,
  runId: string,
  source: unknown,
  token: string,
  now: number,
): string {
  const binding = captureCursorBinding(source);
  assertUnexpired(binding, now);
  requireDispatch(Date.parse(binding.expiresAt) <= now + 30_000, "invalid", "cursor-invalid");
  const payload = Buffer.from(canonicalise(binding));
  const staged = registry.stage({
    ...identity(runId, token),
    payload,
    digest: bindingDigest(binding),
    authorityExpiresAt: binding.expiresAt,
  });
  if (staged.kind !== "staged") payload.fill(0);
  requireDispatch(staged.kind !== "busy", "busy", "capacity-exhausted");
  requireDispatch(staged.kind === "staged", "invalid", "cursor-invalid");
  return token;
}
/** Consuming a cursor authorizes no effect. The caller must re-enter normal live dispatch and budget admission. */
export function consumeCatalogCursor(
  registry: CodingToolInvocationRegistry,
  runId: string,
  token: string,
  expectedSource: unknown,
  now: number,
): CursorBinding {
  const expected = captureCursorBinding(expectedSource);
  assertUnexpired(expected, now);
  return consumeCatalogCursorMatching(registry, runId, token, now, (actual) => {
    requireDispatch(bindingDigest(actual) === bindingDigest(expected), "invalid", "cursor-invalid");
  });
}
/** Server composition validates the captured binding against current request identity before consuming it. */
export function consumeCatalogCursorMatching(
  registry: CodingToolInvocationRegistry,
  runId: string,
  token: string,
  now: number,
  validate: (binding: CursorBinding) => void,
): CursorBinding {
  const key = identity(runId, token);
  const taken = registry.take(key);
  requireDispatch(taken.kind !== "replayed", "invalid", "cursor-replayed");
  requireDispatch(taken.kind === "ready", "invalid", "cursor-invalid");
  try {
    const actual = captureCursorBinding(JSON.parse(taken.payload.toString("utf8")) as unknown);
    assertUnexpired(actual, now);
    validate(actual);
    return actual;
  } finally {
    registry.settle(key);
  }
}
export function discardCatalogCursor(
  registry: CodingToolInvocationRegistry,
  runId: string,
  token: string,
): void {
  const key = identity(runId, token);
  if (registry.take(key).kind === "ready") registry.settle(key);
}
