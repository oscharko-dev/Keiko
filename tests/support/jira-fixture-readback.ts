import assert from "node:assert/strict";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";

interface ReadbackControls {
  readonly denyReadback: boolean;
  readonly throwReadback: boolean;
  readonly missingReadback?: boolean;
  readonly reject: boolean;
}
interface SelectedWrite {
  readonly path: string;
  readonly method: string;
  readonly body?: unknown;
}

/** The synthetic read-back faults every lifecycle fixture injects once the write has landed. */
export function readbackFault(
  controls: ReadbackControls,
  effects: number,
  path: string,
  failureMessage: string,
): AtlassianWriteHttpOutcome | undefined {
  if (effects <= 0) return undefined;
  if (controls.throwReadback) throw new Error(failureMessage);
  if (controls.denyReadback) return { ok: false, reason: "permission-denied", httpStatus: 403 };
  if (controls.missingReadback === true && path !== "myself")
    return { ok: false, reason: "not-found", httpStatus: 404 };
  return undefined;
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
