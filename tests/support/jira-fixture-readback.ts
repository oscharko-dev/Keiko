import assert from "node:assert/strict";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";

interface ReadbackFaultControls {
  readonly denyReadback: boolean;
  readonly throwReadback: boolean;
  readonly missingReadback?: boolean;
  /** The read-back answers a server error, which establishes nothing about the object. */
  readonly serverErrorReadback?: boolean;
}
/** The injectable faults every directory-style fixture shares. */
export interface SharedFixtureControls extends ReadbackFaultControls {
  lostAck: boolean;
  denyReadback: boolean;
  throwReadback: boolean;
  actorChangesAfter: boolean;
  actorChangesBefore: boolean;
}
interface ReadbackControls extends ReadbackFaultControls {
  readonly reject: boolean;
}
interface SelectedWrite {
  readonly path: string;
  readonly method: string;
  readonly body?: unknown;
}

/** The synthetic read-back faults every lifecycle fixture injects once the write has landed. */
export function readbackFault(
  controls: ReadbackFaultControls,
  effects: number,
  path: string,
  failureMessage: string,
): AtlassianWriteHttpOutcome | undefined {
  if (effects <= 0) return undefined;
  if (controls.throwReadback) throw new Error(failureMessage);
  if (controls.denyReadback) return { ok: false, reason: "permission-denied", httpStatus: 403 };
  if (controls.missingReadback === true && path !== "myself")
    return { ok: false, reason: "not-found", httpStatus: 404 };
  if (controls.serverErrorReadback === true && path !== "myself")
    return { ok: false, reason: "unavailable", httpStatus: 503 };
  return undefined;
}

export interface RecordedCall {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
  readonly expect: unknown;
}

/** Asserts a dispatched write is exactly the reviewed native call, with the body and ack kind named. */
export function assertDispatchedWrite(
  selected: { readonly path: string; readonly method: string },
  call: RecordedCall,
  expected: { readonly body: unknown; readonly expect: unknown },
): void {
  assert.equal(call.path, selected.path);
  assert.equal(call.method, selected.method);
  assert.deepEqual(call.body, expected.body);
  assert.equal(call.expect, expected.expect);
}

/** Asserts the dispatched write is exactly the reviewed one; returns the injected rejection, if any. */
export function reviewedWriteRefusal(
  selected: SelectedWrite,
  controls: ReadbackControls,
  write: {
    readonly path: string;
    readonly method: string;
    readonly body: unknown;
    readonly expect: unknown;
  },
): AtlassianWriteHttpOutcome | undefined {
  assert.equal(write.path, selected.path);
  assert.equal(write.method, selected.method);
  assert.deepEqual(write.body, selected.body);
  assert.equal(write.expect, "none");
  return controls.reject ? { ok: false, reason: "field-validation", httpStatus: 400 } : undefined;
}

/** The `myself` read: the reviewed actor, or another one once the configured drift applies. */
export function actorReadback(
  actor: { readonly key: string },
  otherKey: string,
  drifted: boolean,
): AtlassianWriteHttpOutcome {
  return { ok: true, status: 200, body: { ...actor, key: drifted ? otherKey : actor.key } };
}

/** Records one dispatched call, applies the read-back fault, then routes it to the read or the write. */
export function dispatchFixtureCall(
  state: {
    readonly calls: RecordedCall[];
    readonly controls: ReadbackFaultControls;
    readonly effects: number;
  },
  call: RecordedCall,
  faultMessage: string,
  route: {
    readonly read: (path: string) => AtlassianWriteHttpOutcome;
    readonly write: (call: RecordedCall) => AtlassianWriteHttpOutcome;
  },
): AtlassianWriteHttpOutcome {
  state.calls.push({ ...call, body: structuredClone(call.body) });
  const fault = readbackFault(state.controls, state.effects, call.path, faultMessage);
  if (fault !== undefined) return fault;
  return call.method === "GET" ? route.read(call.path) : route.write(call);
}
