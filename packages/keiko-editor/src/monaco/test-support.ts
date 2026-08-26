/**
 * Shared test helpers for Monaco source-scanning tests (KEIKO-0921).
 *
 * The file name deliberately does NOT match vitest's `src/**\/*.test.ts` include glob, so this
 * module is imported by tests but never collected as a test file of its own. Consumed today by
 * `./runtime.test.ts`'s no-CDN invariant scan and `./theme.test.ts`'s no-colour-literal invariant
 * scan; one canonical definition keeps both scans in step if the helper is ever hardened.
 */

/** Remove block/JSDoc comments so a source-literal scan inspects code, not documentation prose. */
export function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}
