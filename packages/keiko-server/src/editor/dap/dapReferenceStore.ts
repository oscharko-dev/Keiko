import { randomBytes } from "node:crypto";

import { DEFAULT_DEBUG_PAYLOAD_LIMITS } from "@oscharko-dev/keiko-contracts";

export const DEBUG_REFERENCE_CAP = 1_000;
const TOKEN_BYTES = 24;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/u;

export interface DebugReferenceScope {
  readonly sessionId: string;
  readonly workspacePartitionKey: string;
  readonly browserSessionBinding: string;
  readonly pauseGeneration: number;
}

export type DebugReferenceTarget =
  | { readonly kind: "frame"; readonly frameId: number }
  | { readonly kind: "scope"; readonly variablesReference: number; readonly depth: number }
  | {
      readonly kind: "variable";
      readonly variablesReference: number;
      readonly parentVariablesReference: number;
      readonly depth: number;
      readonly name: string;
      readonly settable: boolean;
    }
  | { readonly kind: "cursor"; readonly startFrame: number };

export type DebugReferenceMintResult =
  | { readonly ok: true; readonly reference: string }
  | { readonly ok: false; readonly reason: "inactive" | "capacity" };

export type DebugReferenceResolveResult<T extends DebugReferenceTarget["kind"]> =
  | {
      readonly ok: true;
      readonly target: Extract<DebugReferenceTarget, { readonly kind: T }>;
    }
  | { readonly ok: false; readonly reason: "missing" | "stale" | "kind_mismatch" };

export interface DebugReferenceStore {
  activatePause(scope: DebugReferenceScope): void;
  projectionEpoch(scope: DebugReferenceScope): number | undefined;
  resetPause(scope: DebugReferenceScope): void;
  mint(scope: DebugReferenceScope, target: DebugReferenceTarget): DebugReferenceMintResult;
  resolve<T extends DebugReferenceTarget["kind"]>(
    scope: DebugReferenceScope,
    reference: string,
    kind: T,
  ): DebugReferenceResolveResult<T>;
  clearSession(sessionId: string): void;
}

export interface DebugReferenceStoreOptions {
  readonly token?: (() => Buffer) | undefined;
  readonly capacity?: number | undefined;
}

interface ReferenceRecord {
  readonly scope: DebugReferenceScope;
  readonly target: DebugReferenceTarget;
}

interface ActivePause {
  readonly scope: DebugReferenceScope;
  readonly references: Map<string, ReferenceRecord>;
  readonly referencesByTarget: Map<string, string>;
  projectionEpoch: number;
}

function sameScope(left: DebugReferenceScope, right: DebugReferenceScope): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.workspacePartitionKey === right.workspacePartitionKey &&
    left.browserSessionBinding === right.browserSessionBinding &&
    left.pauseGeneration === right.pauseGeneration
  );
}

function validDepth(depth: number): boolean {
  return (
    Number.isSafeInteger(depth) && depth >= 0 && depth <= DEFAULT_DEBUG_PAYLOAD_LIMITS.maxDepth
  );
}

function validVariableTarget(
  target: Extract<DebugReferenceTarget, { readonly kind: "variable" }>,
): boolean {
  return (
    Number.isSafeInteger(target.variablesReference) &&
    target.variablesReference >= 0 &&
    Number.isSafeInteger(target.parentVariablesReference) &&
    target.parentVariablesReference >= 0 &&
    (!target.settable || target.parentVariablesReference > 0) &&
    validDepth(target.depth) &&
    target.name.length > 0 &&
    !target.name.includes("\u0000")
  );
}

function safeTarget(target: DebugReferenceTarget): boolean {
  if (target.kind === "frame") return Number.isSafeInteger(target.frameId) && target.frameId > 0;
  if (target.kind === "cursor") {
    return Number.isSafeInteger(target.startFrame) && target.startFrame >= 0;
  }
  if (target.kind === "scope") {
    return (
      Number.isSafeInteger(target.variablesReference) &&
      target.variablesReference > 0 &&
      validDepth(target.depth)
    );
  }
  return validVariableTarget(target);
}

function copyTarget(target: DebugReferenceTarget): DebugReferenceTarget {
  return Object.freeze({ ...target });
}

function targetKey(target: DebugReferenceTarget): string {
  return JSON.stringify(target);
}

function nextToken(factory: () => Buffer): string | undefined {
  const bytes = factory();
  if (bytes.length !== TOKEN_BYTES) return undefined;
  const token = bytes.toString("base64url");
  return TOKEN_PATTERN.test(token) ? token : undefined;
}

function activatePause(pauses: Map<string, ActivePause>, scope: DebugReferenceScope): void {
  const current = pauses.get(scope.sessionId);
  if (current !== undefined && sameScope(current.scope, scope)) return;
  pauses.set(scope.sessionId, {
    scope: Object.freeze({ ...scope }),
    references: new Map(),
    referencesByTarget: new Map(),
    projectionEpoch: 0,
  });
}

function mint(
  pause: ActivePause | undefined,
  scope: DebugReferenceScope,
  target: DebugReferenceTarget,
  capacity: number,
  tokenFactory: () => Buffer,
): DebugReferenceMintResult {
  if (pause === undefined || !sameScope(pause.scope, scope) || !safeTarget(target)) {
    return { ok: false, reason: "inactive" };
  }
  const key = targetKey(target);
  const existing = pause.referencesByTarget.get(key);
  if (existing !== undefined) return { ok: true, reference: existing };
  if (pause.references.size >= capacity) return { ok: false, reason: "capacity" };
  const reference = nextToken(tokenFactory);
  if (reference === undefined || pause.references.has(reference)) {
    return { ok: false, reason: "capacity" };
  }
  pause.references.set(reference, { scope: pause.scope, target: copyTarget(target) });
  pause.referencesByTarget.set(key, reference);
  return { ok: true, reference };
}

function resolve<T extends DebugReferenceTarget["kind"]>(
  pause: ActivePause | undefined,
  scope: DebugReferenceScope,
  reference: string,
  kind: T,
): DebugReferenceResolveResult<T> {
  if (pause === undefined || !sameScope(pause.scope, scope)) return { ok: false, reason: "stale" };
  if (!TOKEN_PATTERN.test(reference)) return { ok: false, reason: "missing" };
  const record = pause.references.get(reference);
  if (record === undefined) return { ok: false, reason: "missing" };
  if (!sameScope(record.scope, scope)) return { ok: false, reason: "stale" };
  if (record.target.kind !== kind) return { ok: false, reason: "kind_mismatch" };
  return {
    ok: true,
    target: copyTarget(record.target) as Extract<DebugReferenceTarget, { readonly kind: T }>,
  };
}

export function createDebugReferenceStore(
  options: DebugReferenceStoreOptions = {},
): DebugReferenceStore {
  const pauses = new Map<string, ActivePause>();
  const capacity = options.capacity ?? DEBUG_REFERENCE_CAP;
  const tokenFactory = options.token ?? ((): Buffer => randomBytes(TOKEN_BYTES));
  return {
    activatePause: (scope): void => {
      activatePause(pauses, scope);
    },
    projectionEpoch: (scope): number | undefined => {
      const pause = pauses.get(scope.sessionId);
      return pause !== undefined && sameScope(pause.scope, scope)
        ? pause.projectionEpoch
        : undefined;
    },
    resetPause: (scope): void => {
      const pause = pauses.get(scope.sessionId);
      if (pause === undefined || !sameScope(pause.scope, scope)) return;
      pause.references.clear();
      pause.referencesByTarget.clear();
      pause.projectionEpoch += 1;
    },
    mint: (scope, target) =>
      mint(pauses.get(scope.sessionId), scope, target, capacity, tokenFactory),
    resolve: <T extends DebugReferenceTarget["kind"]>(
      scope: DebugReferenceScope,
      reference: string,
      kind: T,
    ): DebugReferenceResolveResult<T> =>
      resolve(pauses.get(scope.sessionId), scope, reference, kind),
    clearSession: (sessionId): void => {
      pauses.delete(sessionId);
    },
  };
}
