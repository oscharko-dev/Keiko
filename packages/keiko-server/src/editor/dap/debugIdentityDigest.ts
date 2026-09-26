import { createHash } from "node:crypto";

/**
 * Generic `sha256(JSON.stringify(value))` digest. This is the single implementation of the
 * formula that debugLaunchContext.ts, debugLaunchPlan.ts, dapNodeCapsuleLauncher.ts, and
 * debugLaunchCatalog.ts previously re-typed independently (three to four verbatim copies of the
 * same `createHash("sha256").update(JSON.stringify(value)).digest("hex")` body). Keep this the
 * only place that formula is written.
 */
export function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

interface DebugRuntimeMountStatFields {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
}

/**
 * Runtime-mount identity digest: `sha256(JSON.stringify([realPath, dev, ino, mode, uid]))`.
 *
 * This is the single source of the formula for the debug runtime-mount identity invariant.
 * debugLaunchContext.ts's `inspectRuntime` (producer) and debugLaunchPlan.ts's
 * `runtimeIdentityValid` / dapNodeCapsuleLauncher.ts's `runtimeUnchanged` (validators) all call
 * this instead of re-typing the formula, so a producer-side edit can never silently drift from a
 * validator-side copy the way the workspace-identity digest once did (epic #2285, issue #2643:
 * every Linux debug launch failed `INVALID_CAPSULE_PLAN` with the suite green because the
 * validator's inline copy did not track a producer formula change).
 *
 * Field order and shape are byte-for-byte behaviour-preserving with the formula this replaces:
 * already-recorded digests keep validating unchanged.
 */
export function deriveDebugRuntimeMountIdentityDigest(
  realPath: string,
  stat: DebugRuntimeMountStatFields,
): string {
  return sha256Json([realPath, stat.dev, stat.ino, stat.mode, stat.uid]);
}

/**
 * Whole-spawn-envelope identity digest: `sha256Json` of the envelope with its own `identityDigest`
 * and `planId` keys excluded (a self-referential digest cannot include itself).
 *
 * Excluding those two keys is a no-op when they are not present yet, so this single function
 * correctly serves both call shapes in the codebase: debugLaunchPlan.ts's `spawnEnvelope` calls it
 * on the pre-signing `values` object (which never had `identityDigest`/`planId` keys at all), and
 * dapNodeCapsuleLauncher.ts's revalidation calls it on the fully-signed envelope (which has both
 * keys and must strip them before re-deriving). Both callers therefore agree by construction
 * instead of by two authors happening to type the same filter twice.
 *
 * This is a distinct invariant from the runtime-mount identity digest above and must stay a
 * separate function.
 */
export function deriveDebugSpawnEnvelopeIdentityDigest(envelope: object): string {
  const values = Object.fromEntries(
    Object.entries(envelope).filter(([key]) => key !== "identityDigest" && key !== "planId"),
  );
  return sha256Json(values);
}
